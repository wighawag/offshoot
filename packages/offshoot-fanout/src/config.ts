/**
 * Per-repo fanout config, read from an **orphan branch** so the template's
 * working tree carries no offshoot-specific file.
 *
 * Why a branch and not `.offshoot-fanout.json` at the root: the file's entire
 * content is per-repo (this repo's branch list, this repo's verify command), and
 * an in-tree file at the root template would cascade into every descendant and
 * conflict at every level on every change. An orphan branch has no merge base
 * with anything, so it never propagates and never conflicts.
 *
 * Reading never touches the working tree and never checks the branch out:
 *   git show offshoot:fanout.config.json
 *   git show origin/offshoot:fanout.config.json   (fallback for a fresh clone)
 */

import fs from 'node:fs';
import path from 'node:path';
import {git, gitWithInput, refExists, refSha, showFile} from './git.js';
import {parseStem} from './stem.js';

/**
 * Default config branch. Flat on purpose: git cannot hold both a branch named
 * `offshoot` and any `offshoot/*` branch (a ref file cannot also be a
 * directory). The convention is the flat name; if you need an `offshoot/*`
 * namespace, pick a nested config branch instead (`--config-branch
 * offshoot/fanout`) and never create the flat one.
 */
export const DEFAULT_CONFIG_BRANCH = 'offshoot';

/** File read from the config branch. */
export const CONFIG_FILE = 'fanout.config.json';

export interface BranchConfig {
	/**
	 * The branch(es) **in the same repo** this one derives from (in-repo edges).
	 * Absent = a root branch, fed by the cross-repo `stem` remote.
	 *
	 * An array makes the branch an **integration node**: it merges every listed
	 * stem, in order, and is only processed once all of them are done. That is
	 * how a branch combining independent extensions (`extended/complete` over
	 * `extended/hosted-account` + `extended/local-signer`) is expressed without
	 * chaining them, which would make each extension inherit the previous one.
	 */
	stem?: string | string[];
	/**
	 * Which branch **of the parent repo** feeds this root branch, when it is not
	 * the parent's primary.
	 *
	 * Only meaningful on a root branch (one with no in-repo `stem`), because that
	 * is the branch a cross-repo edge lands on. Default: the parent's primary.
	 *
	 * This exists because a repo can be built on a VARIANT of its parent rather
	 * than on the parent's mainline, and without it such a repo is wired to the
	 * wrong parent by construction. Observed cost on a live tree: a site built on
	 * `with/local-signer` merged from `main` reported 13 conflicts, of which 10
	 * were purely the absent variant, against 3 from its real parent. Worse than
	 * the noise, the ordinary resolution of those 10 silently reverts the site off
	 * the variant it is built on, in files that still compile.
	 *
	 * ```json
	 * {"branches": {"main": {"stemBranch": "with/local-signer"}}}
	 * ```
	 *
	 * A name that matches no branch of the parent is a hard error rather than a
	 * fallback to the primary: silently cascading from the wrong branch is the
	 * exact failure this key exists to prevent.
	 */
	stemBranch?: string;
}

export interface FanoutConfig {
	/**
	 * The PARENT REPOSITORY, as `provider:owner/name` (or a URL on a self-hosted
	 * host). `null` declares this repo the ROOT of its tree.
	 *
	 * This is the one relationship the tool could not see: the parent lived only
	 * in a local git remote, so a tree's shape died with the machine holding it.
	 * With it, enumerating a family (every member carries the root commit, which
	 * a host's commit search can find) and reading each member's config yields
	 * the exact graph, with no local state and no inference.
	 *
	 * Three distinct states, all meaningful:
	 *   absent      -> not annotated. Valid forever: every existing tree is this.
	 *   "a/b"       -> parent stated.
	 *   null        -> stated to BE the root, which is not the same as unknown.
	 *
	 * The `stem` REMOTE still wins for merging when it is present; see
	 * `resolveParent`. This field is the portable truth, not the merge input.
	 */
	stem?: string | null;
	/**
	 * Opt-in branch set. When present, ONLY the listed branches participate.
	 * That is what keeps scratch branches out of the cascade without naming them.
	 */
	branches?: Record<string, BranchConfig>;
	/** Opt-in (`--verify`) command run in a merged node. */
	verify?: string;
}

export type ConfigSource =
	/** read from the local config branch */
	| 'branch'
	/** read from `origin/<config branch>` (fresh clone, no local branch) */
	| 'remote-branch'
	/** no config branch: today's defaults apply */
	| 'none'
	/** config branch found but unusable */
	| 'error'
	/** reading was turned off (`--no-config`) */
	| 'disabled';

export interface ResolvedConfig {
	config: FanoutConfig | null;
	source: ConfigSource;
	/** The ref the config came from, e.g. `offshoot:fanout.config.json`. */
	ref: string | null;
	error: string | null;
	/** Something worth saying in the report that is not an error (a name collision). */
	note: string | null;
}

export interface ResolveConfigOptions {
	/** Config branch name. Default: `offshoot`. */
	branch?: string;
	/** Set false to skip reading entirely (`--no-config`). Default: true. */
	enabled?: boolean;
}

function validate(raw: unknown): FanoutConfig {
	if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
		throw new Error('config must be a JSON object');
	}
	const obj = raw as Record<string, unknown>;
	const config: FanoutConfig = {};

	if ('stem' in obj) {
		const stem = obj.stem;
		if (stem === null) {
			// Explicitly the root. Distinct from absent, which means "nobody said".
			config.stem = null;
		} else if (typeof stem !== 'string') {
			throw new Error(
				'`stem` must be a string (`provider:owner/name`) or null (this repo is the root)',
			);
		} else {
			// Parse for validity, but store the canonical id, so every reader sees
			// one spelling regardless of how it was written.
			try {
				config.stem = parseStem(stem).id;
			} catch (e) {
				throw new Error(
					`\`stem\` is invalid: ${e instanceof Error ? e.message : String(e)}`,
				);
			}
		}
	}

	if (obj.branches !== undefined) {
		const branches = obj.branches;
		if (
			branches === null ||
			typeof branches !== 'object' ||
			Array.isArray(branches)
		) {
			throw new Error('`branches` must be an object');
		}
		const out: Record<string, BranchConfig> = {};
		for (const [name, value] of Object.entries(
			branches as Record<string, unknown>,
		)) {
			if (value === null || typeof value !== 'object' || Array.isArray(value)) {
				throw new Error(`\`branches.${name}\` must be an object`);
			}
			const stem = (value as Record<string, unknown>).stem;
			if (stem !== undefined) {
				const list = Array.isArray(stem) ? stem : [stem];
				if (!list.every((s) => typeof s === 'string')) {
					throw new Error(
						`\`branches.${name}.stem\` must be a string or an array of strings`,
					);
				}
				if (list.length === 0) {
					throw new Error(
						`\`branches.${name}.stem\` is an empty array; omit it for a root branch`,
					);
				}
				if (new Set(list).size !== list.length) {
					throw new Error(
						`\`branches.${name}.stem\` lists the same branch twice`,
					);
				}
			}
			const stemBranch = (value as Record<string, unknown>).stemBranch;
			if (stemBranch !== undefined) {
				if (typeof stemBranch !== 'string' || stemBranch.length === 0) {
					throw new Error(
						`\`branches.${name}.stemBranch\` must be a non-empty string`,
					);
				}
				if (stem !== undefined) {
					// One or the other: `stem` says another branch HERE feeds it, and
					// `stemBranch` says a branch of the PARENT REPO does. Accepting both
					// would leave the merge order undefined and the intent unreadable.
					throw new Error(
						`\`branches.${name}\` sets both \`stem\` and \`stemBranch\`; ` +
							'`stem` is a branch in this repo and `stemBranch` is a branch of ' +
							'the parent repo, so a branch has one or the other',
					);
				}
			}
			out[name] = {
				...(stem === undefined ? {} : {stem: stem as string | string[]}),
				...(stemBranch === undefined ? {} : {stemBranch: stemBranch as string}),
			};
		}
		config.branches = out;
	}

	if (obj.verify !== undefined) {
		if (typeof obj.verify !== 'string') {
			throw new Error('`verify` must be a string');
		}
		config.verify = obj.verify;
	}

	return config;
}

/**
 * Resolve a repo's config from its config branch, without ever checking it out.
 * Absent config means today's defaults, so a repo that matches the defaults
 * stays completely free of offshoot references.
 */
export function resolveConfig(
	repoPath: string,
	opts: ResolveConfigOptions = {},
): ResolvedConfig {
	const branch = opts.branch ?? DEFAULT_CONFIG_BRANCH;
	if (opts.enabled === false) {
		return {
			config: null,
			source: 'disabled',
			ref: null,
			error: null,
			note: null,
		};
	}

	const candidates = [branch, `origin/${branch}`];
	const collisions: string[] = [];
	for (const [i, ref] of candidates.entries()) {
		if (!refExists(repoPath, ref)) continue;
		const text = showFile(repoPath, ref, CONFIG_FILE);
		const source: ConfigSource = i === 0 ? 'branch' : 'remote-branch';
		if (text === null) {
			// The default name is an ordinary word, so a branch called `offshoot`
			// with no config file in it is far more likely a name collision than a
			// broken config. Erroring here would mark the repo AND every descendant
			// as failed, so fall through and say so instead.
			collisions.push(ref);
			continue;
		}
		try {
			return {
				config: validate(JSON.parse(text) as unknown),
				source,
				ref: `${ref}:${CONFIG_FILE}`,
				error: null,
				note: null,
			};
		} catch (e) {
			// A file that IS there and does not parse is a real problem: refuse to
			// merge against a config we cannot read.
			return {
				config: null,
				source: 'error',
				ref: `${ref}:${CONFIG_FILE}`,
				error: `${ref}:${CONFIG_FILE} is invalid: ${
					e instanceof Error ? e.message : String(e)
				}`,
				note: null,
			};
		}
	}

	return {
		config: null,
		source: 'none',
		ref: null,
		error: null,
		note:
			collisions.length > 0
				? `\`${collisions.join('`, `')}\` has no ${CONFIG_FILE}; treated as no config`
				: null,
	};
}

export interface WriteConfigResult {
	ok: boolean;
	branch: string;
	/** The new commit on the config branch, when written. */
	commit: string | null;
	/** True when the config branch did not exist before. */
	created: boolean;
	message: string;
}

export interface WriteConfigOptions {
	/** Config branch name. Default: `offshoot`. */
	branch?: string;
	/** Commit message. */
	message?: string;
}

/**
 * Write `fanout.config.json` onto the config branch with pure plumbing
 * (`hash-object -w` + `mktree` + `commit-tree` + `update-ref`), so the working
 * tree, the index and the current branch are never touched. Creates the orphan
 * branch when absent; otherwise commits on top of it.
 */
export function writeConfig(
	repoPath: string,
	filePath: string,
	opts: WriteConfigOptions = {},
): WriteConfigResult {
	const branch = opts.branch ?? DEFAULT_CONFIG_BRANCH;
	const ref = `refs/heads/${branch}`;
	const fail = (message: string): WriteConfigResult => ({
		ok: false,
		branch,
		commit: null,
		created: false,
		message,
	});

	const abs = path.resolve(filePath);
	if (!fs.existsSync(abs)) return fail(`file not found: ${abs}`);

	// Fail before writing anything if the payload is not the shape we read back.
	try {
		validate(JSON.parse(fs.readFileSync(abs, 'utf8')) as unknown);
	} catch (e) {
		return fail(
			`refusing to write an invalid config: ${
				e instanceof Error ? e.message : String(e)
			}`,
		);
	}

	// Hash the FILE, not a re-serialization of the parsed object: unknown keys
	// written by a newer version survive an older binary's `config set`.
	const blob = git(['hash-object', '-w', '--', abs], repoPath);
	if (!blob.ok) return fail(`hash-object failed: ${blob.stderr.trim()}`);
	const blobSha = blob.stdout.trim();

	const tree = gitWithInput(
		['mktree'],
		repoPath,
		`100644 blob ${blobSha}\t${CONFIG_FILE}\n`,
	);
	if (!tree.ok) return fail(`mktree failed: ${tree.stderr.trim()}`);
	const treeSha = tree.stdout.trim();

	const parent = refSha(repoPath, ref);
	const created = parent === null;
	const message =
		opts.message ??
		`offshoot-fanout: ${created ? 'add' : 'update'} ${CONFIG_FILE}`;

	const args = ['commit-tree', treeSha];
	if (parent) args.push('-p', parent);
	args.push('-m', message);
	const commit = git(args, repoPath);
	if (!commit.ok) return fail(`commit-tree failed: ${commit.stderr.trim()}`);
	const commitSha = commit.stdout.trim();

	const update = parent
		? git(['update-ref', ref, commitSha, parent], repoPath)
		: git(['update-ref', ref, commitSha], repoPath);
	if (!update.ok) return fail(`update-ref failed: ${update.stderr.trim()}`);

	return {
		ok: true,
		branch,
		commit: commitSha,
		created,
		message: created
			? `created orphan branch \`${branch}\` with ${CONFIG_FILE} (${commitSha.slice(0, 8)})`
			: `updated \`${branch}\`:${CONFIG_FILE} (${commitSha.slice(0, 8)})`,
	};
}

/**
 * Stable serialization: `stem` first (it identifies the repo's place in the
 * tree), then `branches`, then `verify`. This file is read by humans and
 * diffed by review, so key order is not allowed to wander.
 */
export function serializeConfig(config: FanoutConfig): string {
	const ordered: Record<string, unknown> = {};
	if ('stem' in config) ordered.stem = config.stem ?? null;
	if (config.branches !== undefined) ordered.branches = config.branches;
	if (config.verify !== undefined) ordered.verify = config.verify;
	return `${JSON.stringify(ordered, null, 2)}\n`;
}

/**
 * Record this repo's parent on its config branch, PRESERVING everything else
 * that is already there.
 *
 * This is the migration path: a tree whose edges exist only as local `stem`
 * remotes is one command per repo away from being reconstructible by anyone,
 * and the remotes it reads are on the machine that is about to be wiped.
 * Passing `null` declares the repo a root.
 */
export function setStem(
	repoPath: string,
	stem: string | null,
	opts: WriteConfigOptions = {},
): WriteConfigResult {
	const branch = opts.branch ?? DEFAULT_CONFIG_BRANCH;
	const ref = `refs/heads/${branch}`;
	const fail = (message: string): WriteConfigResult => ({
		ok: false,
		branch,
		commit: null,
		created: false,
		message,
	});

	const existing = resolveConfig(repoPath, {branch});
	if (existing.source === 'error')
		return fail(existing.error ?? 'unreadable config');

	const next: FanoutConfig = {...(existing.config ?? {}), stem};
	let text: string;
	try {
		// Round-trip through validation so an invalid stem fails before anything
		// is written, with the same message a reader would produce.
		text = serializeConfig(
			validate(JSON.parse(serializeConfig(next)) as unknown),
		);
	} catch (e) {
		return fail(
			`refusing to write an invalid config: ${
				e instanceof Error ? e.message : String(e)
			}`,
		);
	}

	const before = existing.config ?? null;
	if (
		before &&
		'stem' in before &&
		before.stem === (stem === null ? null : next.stem)
	) {
		return {
			ok: true,
			branch,
			commit: null,
			created: false,
			message: `already records stem ${stem === null ? '(root)' : `\`${next.stem}\``}; nothing to do`,
		};
	}

	const blob = gitWithInput(['hash-object', '-w', '--stdin'], repoPath, text);
	if (!blob.ok) return fail(`hash-object failed: ${blob.stderr.trim()}`);
	const tree = gitWithInput(
		['mktree'],
		repoPath,
		`100644 blob ${blob.stdout.trim()}\t${CONFIG_FILE}\n`,
	);
	if (!tree.ok) return fail(`mktree failed: ${tree.stderr.trim()}`);

	const parent = refSha(repoPath, ref);
	const created = parent === null;
	const args = ['commit-tree', tree.stdout.trim()];
	if (parent) args.push('-p', parent);
	args.push(
		'-m',
		opts.message ??
			`offshoot-fanout: record stem ${stem === null ? '(root)' : next.stem}`,
	);
	const commit = git(args, repoPath);
	if (!commit.ok) return fail(`commit-tree failed: ${commit.stderr.trim()}`);
	const commitSha = commit.stdout.trim();

	const update = parent
		? git(['update-ref', ref, commitSha, parent], repoPath)
		: git(['update-ref', ref, commitSha], repoPath);
	if (!update.ok) return fail(`update-ref failed: ${update.stderr.trim()}`);

	return {
		ok: true,
		branch,
		commit: commitSha,
		created,
		message: `${created ? 'created' : 'updated'} \`${branch}\`:${CONFIG_FILE} with stem ${
			stem === null ? '(root)' : `\`${next.stem}\``
		} (${commitSha.slice(0, 8)})`,
	};
}
