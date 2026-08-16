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
}

export interface FanoutConfig {
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
			out[name] = stem === undefined ? {} : {stem: stem as string | string[]};
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
