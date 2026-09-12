/**
 * Reconstruct a whole tree on a bare machine, from ONE repo name.
 *
 * The sequence, none of which touches local state:
 *   root repo -> its root commit -> host commit search -> the family
 *   each member's `stem` field  -> the exact parent/child graph
 *   clone each member          -> wire each `stem` remote from that graph
 *
 * Membership comes from shared history, direction comes from the stated `stem`
 * field, and nothing is ever inferred: an edge this cannot read is reported as
 * missing rather than guessed, because guessing it is precisely what produced
 * an inverted three-repo chain when it was measured.
 *
 * A repo with no `stem` field is DISCARDED, not adopted. That makes the field
 * the opt-in marker for "this repo is maintained as part of the tree", which is
 * what separates a real member from an old experiment or someone else's copy
 * that happens to share the same first commit.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {CONFIG_FILE, DEFAULT_CONFIG_BRANCH} from './config.js';
import type {FanoutConfig} from './config.js';
import {addOrSetRemote, getRemoteUrl, git, isGitRepo} from './git.js';
import {
	searchReposByCommit,
	fetchFileFromBranch,
	resolveToken,
} from './host.js';
import type {HostOptions, TokenSource} from './host.js';
import {parseStem, protocolOf, sameRepo, stemUrl} from './stem.js';
import type {StemId, StemProtocol} from './stem.js';

export type MemberStatus =
	/** Annotated member: has a `stem` field naming its parent. */
	| 'member'
	/** The root of the tree being reconstructed. */
	| 'root'
	/** Shares the root commit but never opted in: not maintained here. */
	| 'unannotated'
	/** Declares itself a root, but is not the one asked for: another family. */
	| 'foreign-root'
	/** Its config branch could not be read or parsed. */
	| 'unreadable';

export interface TreeMember {
	/** `owner/name` on the host. */
	fullName: string;
	name: string;
	status: MemberStatus;
	/** Canonical parent id from the config, or null for a root. */
	stem: string | null;
	/** Why it was discarded, when it was. */
	reason: string | null;
}

export type CloneAction = 'cloned' | 'existing' | 'skipped' | 'failed';

export interface CloneOutcome {
	member: TreeMember;
	dir: string;
	action: CloneAction;
	/** What the `stem` remote was set to, when it was set. */
	wired: string | null;
	message: string | null;
}

export interface CloneTreeOptions {
	/** Where clones land. Default: cwd. */
	dir?: string;
	/** Config branch holding each repo's `fanout.config.json`. */
	configBranch?: string;
	/** Remote name to wire. Default: `stem`. */
	remote?: string;
	/** ssh or https clone URLs. Default: inferred from the root, else https. */
	protocol?: StemProtocol;
	/** Discover and report, clone nothing, wire nothing. */
	dryRun?: boolean;
	/**
	 * Refuse to run without a credential. A tree with private members is simply
	 * not reconstructible unauthenticated, and a smaller answer that LOOKS whole
	 * is worse than no answer, so a caller that knows the tree has private repos
	 * can demand the difference be fatal.
	 */
	requireAuth?: boolean;
	host?: HostOptions;
	/** Progress line sink, so the CLI can stream a long operation. */
	onProgress?: (line: string) => void;
}

export interface CloneTreeResult {
	root: string;
	/** Root commits probed on the host. */
	rootCommits: string[];
	members: TreeMember[];
	outcomes: CloneOutcome[];
	/** `stem` values naming a repo that is not in the discovered set. */
	dangling: {repo: string; stem: string}[];
	/** The host said its own search result was truncated. */
	incomplete: boolean;
	/** Which credential was used, so a partial tree can be explained. */
	auth: TokenSource;
}

/** The oldest commits of a repo: the probe that finds every descendant. */
export function rootCommitsOf(repoPath: string): string[] {
	const r = git(['rev-list', '--max-parents=0', 'HEAD'], repoPath);
	if (!r.ok) return [];
	return r.stdout.trim().split('\n').filter(Boolean);
}

function parseConfigText(text: string): FanoutConfig | null {
	try {
		return JSON.parse(text) as FanoutConfig;
	} catch {
		return null;
	}
}

/** Reads one repo's raw config text off its config branch, or null if absent. */
export type ConfigReader = (fullName: string) => Promise<string | null>;

/**
 * Turn a set of repos that merely SHARE HISTORY into a stated tree.
 *
 * Sharing the root commit is not membership: a fork someone took years ago, an
 * abandoned experiment and a bug reproduction all carry it. The `stem` field is
 * the opt-in marker, so anything without one is discarded WITH A REASON rather
 * than adopted, and a repo declaring itself a root is another family's root,
 * not this one's child.
 *
 * Kept free of the network and the filesystem so the classification rules can
 * be tested directly: they are the part that decides what lands on a machine.
 */
export async function classifyMembers(
	rootFullName: string,
	candidates: string[],
	read: ConfigReader,
	configBranch = DEFAULT_CONFIG_BRANCH,
): Promise<{members: TreeMember[]; dangling: {repo: string; stem: string}[]}> {
	const members: TreeMember[] = [];
	const all = new Set([...candidates, rootFullName]);

	for (const fullName of [...all].sort()) {
		const isRoot = fullName.toLowerCase() === rootFullName.toLowerCase();
		const name = fullName.split('/').pop()!;
		const push = (
			status: MemberStatus,
			stem: string | null,
			reason: string | null,
		): void => {
			members.push({fullName, name, status, stem, reason});
		};

		let text: string | null;
		try {
			text = await read(fullName);
		} catch (e) {
			push('unreadable', null, e instanceof Error ? e.message : String(e));
			continue;
		}

		if (text === null) {
			push(
				isRoot ? 'root' : 'unannotated',
				null,
				isRoot
					? null
					: `no \`${configBranch}\` branch with ${CONFIG_FILE}: not maintained as part of this tree`,
			);
			continue;
		}

		const config = parseConfigText(text);
		if (!config) {
			push(
				'unreadable',
				null,
				`${configBranch}:${CONFIG_FILE} is not valid JSON`,
			);
			continue;
		}

		if (!('stem' in config)) {
			push(
				isRoot ? 'root' : 'unannotated',
				null,
				isRoot
					? null
					: 'config has no `stem` field: not maintained as part of this tree',
			);
			continue;
		}

		// `"stem": null` is a STATEMENT ("I am a root"), and an absent key is the
		// absence of one, so the two are never collapsed.
		const declared = config.stem ?? null;
		if (declared === null) {
			push(
				isRoot ? 'root' : 'foreign-root',
				null,
				isRoot ? null : 'declares itself the root of a different tree',
			);
			continue;
		}

		let parsed: StemId;
		try {
			parsed = parseStem(declared);
		} catch (e) {
			push('unreadable', null, e instanceof Error ? e.message : String(e));
			continue;
		}
		// The root's own `stem` (it may be a descendant of some other tree) is not
		// followed: the caller asked for THIS root, so the walk stops here.
		push(isRoot ? 'root' : 'member', isRoot ? null : parsed.id, null);
	}

	// An edge pointing outside the discovered set is reported, never dropped: it
	// means an ancestor is private, renamed, or on another host.
	const known = new Set(members.map((m) => m.fullName.toLowerCase()));
	const dangling: {repo: string; stem: string}[] = [];
	for (const m of members) {
		if (!m.stem) continue;
		if (!known.has(parseStem(m.stem).path.toLowerCase())) {
			dangling.push({repo: m.fullName, stem: m.stem});
		}
	}
	return {members, dangling};
}

/**
 * Clone every repo of the tree rooted at `rootSpec` and wire its `stem` remote.
 *
 * Idempotent: an existing clone with the right `origin` is left alone and only
 * re-wired, so this doubles as "bring this machine back in sync".
 */
export async function cloneTree(
	rootSpec: string,
	opts: CloneTreeOptions = {},
): Promise<CloneTreeResult> {
	const dir = path.resolve(opts.dir ?? process.cwd());
	const configBranch = opts.configBranch ?? DEFAULT_CONFIG_BRANCH;
	const remoteName = opts.remote ?? 'stem';
	const say = opts.onProgress ?? (() => {});

	// Resolve the credential ONCE, up front: it decides whether private members
	// are visible at all, so it belongs before any question is asked of the host.
	const auth = resolveToken(opts.host?.token);
	if (auth.source === 'none' && opts.requireAuth) {
		throw new Error(
			'no GitHub credential: private members of this tree would be invisible, and the result would look complete anyway. ' +
				'Run `gh auth login`, or set GITHUB_TOKEN, or drop --require-auth to accept a public-only view.',
		);
	}
	const host: HostOptions = {
		...opts.host,
		...(auth.token ? {token: auth.token} : {}),
	};
	if (auth.source === 'gh') say('authenticated with the `gh` CLI');
	const root = parseStem(rootSpec);

	fs.mkdirSync(dir, {recursive: true});

	// 1. The root has to exist locally, because only a real repo can tell us the
	//    family's root commit. Everything else follows from that hash.
	const rootDir = path.join(dir, root.name);
	// Match the protocol already in use: an existing root clone decides it, else
	// how the caller wrote the spec, else https. A tree half in ssh and half in
	// https still works, but it reads like two trees.
	const protocol: StemProtocol =
		opts.protocol ??
		(isGitRepo(rootDir)
			? protocolOf(getRemoteUrl(rootDir, 'origin'))
			: protocolOf(
					rootSpec.includes('://') || rootSpec.startsWith('git@')
						? rootSpec
						: null,
				));
	const rootUrl = stemUrl(root, protocol);

	// A dry run must still be able to REPORT the tree, and the probe it needs is
	// the root commit, which only a real repo can supply. So when the root is not
	// here yet, fetch history without file contents into a throwaway bare clone:
	// enough to read the first commit, and nothing lands in the target directory.
	let probeDir = rootDir;
	let temporary: string | null = null;
	if (!isGitRepo(rootDir)) {
		if (opts.dryRun) {
			temporary = fs.mkdtempSync(
				path.join(os.tmpdir(), 'offshoot-fanout-probe-'),
			);
			probeDir = path.join(temporary, `${root.name}.git`);
			say(`probing ${root.id} for the family's root commit (no files fetched)`);
			const r = git(
				['clone', '--filter=blob:none', '--bare', '--quiet', rootUrl, probeDir],
				temporary,
			);
			if (!r.ok) {
				fs.rmSync(temporary, {recursive: true, force: true});
				throw new Error(
					`probing the root ${root.id} failed: ${r.stderr.trim()}`,
				);
			}
		} else {
			say(`cloning root ${root.id}`);
			const r = git(['clone', rootUrl, rootDir], dir);
			if (!r.ok)
				throw new Error(
					`cloning the root ${root.id} failed: ${r.stderr.trim()}`,
				);
		}
	}

	const rootCommits = rootCommitsOf(probeDir);
	if (temporary) fs.rmSync(temporary, {recursive: true, force: true});
	if (rootCommits.length === 0) {
		throw new Error(`could not read the root commit of ${probeDir}`);
	}

	// 2. Membership from the host: every repo whose default branch carries one
	//    of those root commits.
	const candidates = new Set<string>();
	let incomplete = false;
	for (const sha of rootCommits) {
		say(`searching the host for repos containing ${sha.slice(0, 10)}`);
		const found = await searchReposByCommit(sha, host);
		if (found.incomplete) incomplete = true;
		for (const name of found.repos) candidates.add(name);
	}

	const rootFullName = root.path;
	candidates.add(rootFullName);

	// 3. Direction from each repo's stated `stem`, read off the config branch
	//    without cloning. This is the step that cannot be replaced by inference.
	const {members, dangling} = await classifyMembers(
		rootFullName,
		[...candidates],
		async (fullName) => {
			say(`reading ${fullName}:${configBranch}/${CONFIG_FILE}`);
			return await fetchFileFromBranch(
				fullName,
				configBranch,
				CONFIG_FILE,
				host,
			);
		},
		configBranch,
	);

	// 5. Clone and wire only what belongs.
	const keep = members.filter(
		(m) => m.status === 'member' || m.status === 'root',
	);
	const outcomes: CloneOutcome[] = [];
	for (const m of keep) {
		const target = path.join(dir, m.name);
		const url = stemUrl(parseStem(m.fullName), protocol);
		let action: CloneAction;
		let message: string | null = null;

		if (isGitRepo(target)) {
			const origin = getRemoteUrl(target, 'origin');
			if (origin && !sameRepo(origin, url)) {
				outcomes.push({
					member: m,
					dir: target,
					action: 'skipped',
					wired: null,
					message: `${target} exists with a different origin (${origin}); left untouched`,
				});
				continue;
			}
			action = 'existing';
		} else if (fs.existsSync(target)) {
			outcomes.push({
				member: m,
				dir: target,
				action: 'skipped',
				wired: null,
				message: `${target} exists and is not a git repo; left untouched`,
			});
			continue;
		} else if (opts.dryRun) {
			action = 'cloned';
		} else {
			say(`cloning ${m.fullName}`);
			const r = git(['clone', url, target], dir);
			if (!r.ok) {
				outcomes.push({
					member: m,
					dir: target,
					action: 'failed',
					wired: null,
					message: r.stderr.trim(),
				});
				continue;
			}
			action = 'cloned';
		}

		let wired: string | null = null;
		if (m.stem) {
			const parentUrl = stemUrl(parseStem(m.stem), protocol);
			if (opts.dryRun) {
				wired = parentUrl;
			} else {
				const existing = getRemoteUrl(target, remoteName);
				if (existing && !sameRepo(existing, parentUrl)) {
					message = `\`${remoteName}\` already points at ${existing}; left as is (config says ${m.stem})`;
				} else {
					const r = addOrSetRemote(target, remoteName, parentUrl);
					if (r.ok) wired = parentUrl;
					else message = `wiring \`${remoteName}\` failed: ${r.stderr.trim()}`;
				}
			}
		}

		outcomes.push({member: m, dir: target, action, wired, message});
	}

	return {
		root: root.id,
		rootCommits,
		members,
		outcomes,
		dangling,
		incomplete,
		auth: auth.source,
	};
}
