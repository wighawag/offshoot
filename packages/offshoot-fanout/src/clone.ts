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
 * The clone is then made RUNNABLE, which is the difference between objects on a
 * disk and a tree. `git clone` leaves one local branch, so a tree whose repos
 * declare `with/pixi-js` or `website` comes back unable to run the tool's own
 * primary verb: measured on the real tree, `offshoot-fanout --dry-run` in a
 * fresh clone reported `CONFLICT — conflict in 0 file(s)` for every declared
 * branch. So every branch the repo's OWN config names is materialised from
 * origin, using the `branches` object this file has already parsed to find the
 * edges. (The cascade no longer mislabels an absent branch as a conflict
 * either; it names the branch and how to create it. Both halves were wrong.)
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
import {
	addOrSetRemote,
	getRemoteUrl,
	git,
	isRepoRoot,
	listWorktrees,
	refExists,
	refSha,
} from './git.js';
import {
	searchReposByCommit,
	fetchFileFromBranch,
	resolveToken,
} from './host.js';
import type {HostOptions, TokenSource} from './host.js';
import {
	parseStem,
	preferredProtocol,
	protocolOf,
	sameRepo,
	stemUrl,
} from './stem.js';
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
	/**
	 * Branches the repo's own config names, in declaration order. These are the
	 * nodes it will participate with, so they are exactly what a clone has to
	 * materialise to be runnable. Empty when the config declares no `branches`,
	 * which means the repo is a single node at `main` and a plain clone suffices.
	 */
	branches: string[];
}

export type BranchAction =
	/** A local tracking branch was created from origin. */
	| 'created'
	/** Already present locally; never moved. */
	| 'existing'
	/**
	 * Fast-forwarded to origin. Only ever the CONFIG branch, which holds no work
	 * and whose staleness silently changes which nodes exist.
	 */
	| 'updated'
	/** The config names it, origin does not have it. */
	| 'missing'
	/** git refused to create it, or the name is not usable. */
	| 'failed';

export interface BranchOutcome {
	branch: string;
	action: BranchAction;
	message: string | null;
}

export type CloneAction = 'cloned' | 'existing' | 'skipped' | 'failed';

export interface CloneOutcome {
	member: TreeMember;
	dir: string;
	action: CloneAction;
	/** What the `stem` remote was set to, when it was set. */
	wired: string | null;
	message: string | null;
	/**
	 * One entry per branch the config names, plus the config branch when origin
	 * has it. Empty when materialising was turned off, when the repo was skipped,
	 * or in a dry run against a repo that is not on disk yet (nothing to read).
	 */
	branches: BranchOutcome[];
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
	/**
	 * Create a local tracking branch for every branch each repo's config names.
	 * Default: true, because a tree that cannot run `fanout` is broken rather
	 * than minimal. Set false for objects-and-remotes only.
	 */
	branches?: boolean;
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
	/**
	 * Annotated members of the same FAMILY that do not descend from the requested
	 * root: siblings and ancestors. Reported, never cloned.
	 */
	outsideSubtree: string[];
	/** The host said its own search result was truncated. */
	incomplete: boolean;
	/** Which credential was used, so a partial tree can be explained. */
	auth: TokenSource;
}

/**
 * The oldest commits of a repo: the probe that finds every descendant.
 *
 * `ref` defaults to HEAD but should almost never be left to: the family is
 * defined by the DEFAULT branch, and a maintainer of a tree like this one keeps
 * orphan branches (`tooling`, the config branch) that have a different root
 * commit entirely. Probed from a checkout sitting on one of those, the host
 * search finds only repos carrying the orphan's hash and reports a one-repo
 * family with complete confidence. See `defaultRefOf`.
 */
export function rootCommitsOf(repoPath: string, ref = 'HEAD'): string[] {
	const r = git(['rev-list', '--max-parents=0', ref], repoPath);
	if (!r.ok) return [];
	return r.stdout.trim().split('\n').filter(Boolean);
}

/** The default branch, preferred over whatever happens to be checked out. */
function defaultRefOf(repoPath: string): string {
	for (const ref of [
		'refs/remotes/origin/HEAD',
		'refs/heads/main',
		'refs/remotes/origin/main',
	]) {
		if (refExists(repoPath, ref)) return ref;
	}
	return 'HEAD';
}

function parseConfigText(text: string): FanoutConfig | null {
	try {
		return JSON.parse(text) as FanoutConfig;
	} catch {
		return null;
	}
}

/**
 * The branch names a config declares, in declaration order.
 *
 * Defensive because this parse is a bare `JSON.parse` on text fetched from the
 * host rather than the validated read `resolveConfig` does locally: a malformed
 * `branches` must cost this repo its branch list, not the whole reconstruction.
 */
function branchNamesOf(config: FanoutConfig): string[] {
	const branches: unknown = config.branches;
	if (
		branches === null ||
		typeof branches !== 'object' ||
		Array.isArray(branches)
	)
		return [];
	return Object.keys(branches).filter((name) => name.length > 0);
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
		// Filled once the config parses. A member discarded before that point has
		// no branch list, which is right: it is not going to be cloned.
		let branches: string[] = [];
		const push = (
			status: MemberStatus,
			stem: string | null,
			reason: string | null,
		): void => {
			members.push({fullName, name, status, stem, reason, branches});
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
		// `.branches` is already in the object just parsed to find the edge, so
		// materialising branches costs no extra read of anything.
		branches = branchNamesOf(config);

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
 * Give a clone the local branches its config names, so `fanout` can run on it.
 *
 * `git clone` creates ONE local branch. Every other branch is a remote-tracking
 * ref, which the cascade can neither check out nor merge into, so every node
 * but one fails on a tree with nothing wrong with it.
 *
 * The rules, each of them the conservative side of the choice:
 *
 *   - A branch the config names that origin does NOT have is REPORTED, never
 *     silently dropped. The tree comes back visibly thin instead of invisibly
 *     thin, which is the same instinct as an unmatched `stemBranch` (`nodes.ts`)
 *     and a `stem` pointing outside the discovered set. `fresh` says whether
 *     origin's refs were actually refreshed first; when they were not, the
 *     report says so rather than asserting a fact about origin nobody checked.
 *   - An existing local branch is left exactly where it is. Re-running this on a
 *     machine with work in progress must not move a ref, so the non-clobber rule
 *     is the one already applied to a `stem` remote pointing somewhere else.
 *   - The CONFIG branch is the single exception to that, and only by
 *     fast-forward. It is never checked out and holds no work, while its
 *     staleness is invisible and changes which nodes exist at all: a machine
 *     that cloned in March and re-runs this in September would otherwise keep
 *     fanning out March's branch set, because a local `offshoot` outranks
 *     `origin/offshoot` in `resolveConfig`. Divergence is reported, not resolved.
 *   - The config branch is materialised in the first place because without it a
 *     fresh clone has no local `offshoot`, and `config stem` then starts a
 *     SECOND, parentless config history and prints a push origin rejects.
 *
 * What is deliberately NOT materialised: any branch no config names. `branches`
 * exists to keep scratch branches out of the cascade without naming them, so a
 * scratch or orphan branch stays a remote-tracking ref. Reconstructing one would
 * mean inventing an edge no config states, which is the thing this file refuses
 * to do everywhere else. Fetch it yourself: `git fetch origin <branch>:<branch>`.
 */
export function materializeBranches(
	repoDir: string,
	declared: string[],
	opts: {
		configBranch?: string;
		dryRun?: boolean;
		/**
		 * Origin's remote-tracking refs are known current (this run cloned or
		 * fetched the repo). Without it, `missing` is a statement about a local
		 * cache, not about origin, and says so.
		 */
		fresh?: boolean;
	} = {},
): BranchOutcome[] {
	const out: BranchOutcome[] = [];
	const seen = new Set<string>();
	const checkedOut = new Set(
		listWorktrees(repoDir)
			.map((w) => w.branch)
			.filter((b): b is string => b !== null),
	);

	const track = (branch: string, isConfigBranch: boolean): void => {
		if (seen.has(branch)) return;
		seen.add(branch);
		const push = (
			action: BranchAction,
			message: string | null = null,
		): void => {
			out.push({branch, action, message});
		};

		// The name came from JSON on someone else's config branch and is about to
		// reach argv, where a leading `-` is an option rather than a name. git's own
		// validation cannot be reached without passing it first.
		if (branch.startsWith('-')) {
			push(
				'failed',
				'branch name starts with `-`, which git reads as an option',
			);
			return;
		}

		// FULLY QUALIFIED on purpose: `origin/x` as a rev is a DWIM lookup, and a
		// local branch literally named `origin/x` (legal) would win it.
		const remote = refSha(repoDir, `refs/remotes/origin/${branch}`);
		const local = refSha(repoDir, `refs/heads/${branch}`);

		if (local !== null) {
			if (!isConfigBranch || remote === null || local === remote) {
				push('existing');
				return;
			}
			if (checkedOut.has(branch)) {
				push(
					'existing',
					`differs from origin/${branch}, and is checked out; left alone`,
				);
				return;
			}
			const behind = git(
				['merge-base', '--is-ancestor', local, remote],
				repoDir,
			).ok;
			if (!behind) {
				// Ahead is the normal state right after `config stem`; diverged is not.
				const ahead = git(
					['merge-base', '--is-ancestor', remote, local],
					repoDir,
				).ok;
				push(
					'existing',
					ahead
						? null
						: `has diverged from origin/${branch}; left alone, so the config read here may not be the published one`,
				);
				return;
			}
			if (opts.dryRun) {
				push('updated');
				return;
			}
			// `update-ref <ref> <new> <old>` is compare-and-swap: it refuses if the
			// ref moved since it was read, so this cannot race a concurrent write.
			const r = git(
				['update-ref', `refs/heads/${branch}`, remote, local],
				repoDir,
			);
			if (r.ok) push('updated');
			else push('failed', r.stderr.trim() || r.stdout.trim());
			return;
		}

		if (remote === null) {
			// The config branch simply is not there for a repo that has no config,
			// which is a supported state rather than a finding.
			if (isConfigBranch) return;
			push(
				'missing',
				opts.fresh
					? `named in ${CONFIG_FILE} but absent from origin: this node cannot be merged`
					: `named in ${CONFIG_FILE} and not among this clone's \`origin/*\` refs, which this run did not refresh. Run \`git fetch origin\` first if the branch was pushed recently`,
			);
			return;
		}
		if (opts.dryRun) {
			push('created');
			return;
		}
		const r = git(
			['branch', '--track', branch, `refs/remotes/origin/${branch}`],
			repoDir,
		);
		if (r.ok) push('created');
		else push('failed', r.stderr.trim() || r.stdout.trim());
	};

	for (const branch of declared) track(branch, false);
	if (opts.configBranch) track(opts.configBranch, true);
	return out;
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
	const wantBranches = opts.branches !== false;
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
	// `owner/..` parses, and would put the "clone" at the PARENT of --dir, where
	// `isRepoRoot` then asks questions of whatever repo lives there.
	if (root.name === '.' || root.name === '..') {
		throw new Error(`\`${rootSpec}\` does not name a repository`);
	}

	fs.mkdirSync(dir, {recursive: true});

	// 1. The root has to exist locally, because only a real repo can tell us the
	//    family's root commit. Everything else follows from that hash.
	const rootDir = path.join(dir, root.name);
	// The whole reconstruction hangs off this one directory's history, so it has
	// to be the RIGHT repo. Left unchecked, a same-named repo of another project
	// sitting at that path is probed instead, and the tool then reports a
	// different family's tree with complete confidence. The only hint is the
	// root's own `skipped, exists with a different origin` line, buried under
	// everything it got wrong.
	if (isRepoRoot(rootDir)) {
		const existingOrigin = getRemoteUrl(rootDir, 'origin');
		if (existingOrigin && !sameRepo(existingOrigin, stemUrl(root, 'https'))) {
			throw new Error(
				`${rootDir} already exists and its \`origin\` is ${existingOrigin}, not ${root.id}. ` +
					'Its history would be used to identify the family, so this would rebuild the wrong tree. ' +
					'Move it aside, or pass --dir somewhere else.',
			);
		}
	}
	// Match the protocol already in use, in order of how strongly each source
	// knows: an existing root clone, then a spec written as a URL, then whatever
	// `gh` says the user does for git operations (ssh unless told otherwise).
	// A tree half in ssh and half in https still works, but it reads like two.
	const specIsUrl = rootSpec.includes('://') || rootSpec.startsWith('git@');
	const rootOrigin = isRepoRoot(rootDir)
		? getRemoteUrl(rootDir, 'origin')
		: null;
	const protocol: StemProtocol =
		opts.protocol ??
		// `protocolOf(null)` is https, so an existing root with NO origin would
		// silently pick https and defeat the private-member argument below. Only let
		// the existing clone decide when it actually has a URL to decide with.
		(rootOrigin
			? protocolOf(rootOrigin)
			: specIsUrl
				? protocolOf(rootSpec)
				: preferredProtocol(root.host));
	const rootUrl = stemUrl(root, protocol);

	// A dry run must still be able to REPORT the tree, and the probe it needs is
	// the root commit, which only a real repo can supply. So when the root is not
	// here yet, fetch history without file contents into a throwaway bare clone:
	// enough to read the first commit, and nothing lands in the target directory.
	let probeDir = rootDir;
	let temporary: string | null = null;
	// Remember that WE cloned the root: it is a real repo by the time the clone
	// loop reaches it, and reporting "existing" for a repo this command just
	// created reads as "nothing happened".
	let clonedRoot = false;
	if (!isRepoRoot(rootDir)) {
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
			clonedRoot = true;
		}
	}

	// From the DEFAULT branch, never from HEAD: a maintainer of a tree like this
	// keeps orphan branches (the config branch, a `tooling` branch), and probed
	// with one of those checked out the search matches only repos carrying the
	// orphan's root commit and reports a one-repo family as if it were the tree.
	const probeRef = defaultRefOf(probeDir);
	const rootCommits = rootCommitsOf(probeDir, probeRef);
	if (temporary) fs.rmSync(temporary, {recursive: true, force: true});
	if (rootCommits.length === 0) {
		throw new Error(
			`could not read the root commit of ${probeDir} at \`${probeRef}\`: ` +
				`${git(['rev-list', '--max-parents=0', probeRef], probeDir).stderr.trim() || 'no commits'}`,
		);
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

	// 5. Clone and wire only what belongs UNDER THE REQUESTED ROOT.
	//
	//    Membership in the family is not the same as being in this subtree. The
	//    whole family shares the root commit, so `clone jolly-roger` sees its own
	//    ancestors and their other children too, and cloning all of them would
	//    silently turn a request for three repos into eleven.
	const reachable = descendantsOf(rootFullName, members);
	const keep = members.filter(
		(m) =>
			(m.status === 'member' || m.status === 'root') &&
			reachable.has(m.fullName.toLowerCase()),
	);
	const outsideSubtree = members
		.filter(
			(m) => m.status === 'member' && !reachable.has(m.fullName.toLowerCase()),
		)
		.map((m) => m.fullName);
	const outcomes: CloneOutcome[] = [];
	for (const m of keep) {
		const target = path.join(dir, m.name);
		const url = stemUrl(parseStem(m.fullName), protocol);
		let action: CloneAction;
		let message: string | null = null;

		if (isRepoRoot(target)) {
			const origin = getRemoteUrl(target, 'origin');
			if (m.status === 'root' && clonedRoot) {
				outcomes.push({
					member: m,
					dir: target,
					action: 'cloned',
					wired: null,
					message: null,
					branches: wantBranches
						? materializeBranches(target, m.branches, {
								configBranch,
								fresh: true,
							})
						: [],
				});
				continue;
			}
			if (origin && !sameRepo(origin, url)) {
				outcomes.push({
					member: m,
					dir: target,
					action: 'skipped',
					wired: null,
					message: `${target} exists with a different origin (${origin}); left untouched`,
					branches: [],
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
				branches: [],
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
					branches: [],
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

		// An EXISTING clone's `origin/*` refs are as of its last fetch, while the
		// config that names the branches was read LIVE from the host seconds ago.
		// Comparing the two without refreshing turns the ordinary "a branch was
		// pushed and you are re-running this to sync" into `missing` and a non-zero
		// exit, which is exactly the case the verb advertises. A dry run does not
		// write, so it skips the fetch and labels its answer as provisional instead.
		let fresh = action === 'cloned' && !opts.dryRun;
		if (wantBranches && !fresh && !opts.dryRun && isRepoRoot(target)) {
			say(`refreshing ${m.fullName}`);
			const f = git(['fetch', '--quiet', 'origin'], target);
			if (f.ok) fresh = true;
			else {
				const why = `could not refresh \`origin\`: ${(f.stderr || f.stdout).trim()}`;
				message = message ? `${message}; ${why}` : why;
			}
		}

		// A dry run against a repo that is not on disk has nothing to inspect: the
		// branch list is reported from the config instead (see the CLI), rather than
		// claiming a creation whose `missing` case could not be checked.
		const branches =
			wantBranches && isRepoRoot(target)
				? materializeBranches(target, m.branches, {
						configBranch,
						fresh,
						...(opts.dryRun ? {dryRun: true} : {}),
					})
				: [];

		outcomes.push({member: m, dir: target, action, wired, message, branches});
	}

	return {
		root: root.id,
		rootCommits,
		members,
		outcomes,
		dangling,
		outsideSubtree,
		incomplete,
		auth: auth.source,
	};
}

/**
 * The requested root plus everything that reaches it by following `stem` edges
 * upward: the subtree the caller actually asked for.
 *
 * Walks DOWN from the root one generation at a time rather than following each
 * member's parent chain, so a cycle introduced by a mis-annotated repo cannot
 * spin: a repo is only ever added once, and only when its parent is already in.
 */
export function descendantsOf(
	rootFullName: string,
	members: TreeMember[],
): Set<string> {
	const childrenOf = new Map<string, TreeMember[]>();
	for (const m of members) {
		if (m.status !== 'member' || !m.stem) continue;
		const key = parseStem(m.stem).path.toLowerCase();
		childrenOf.set(key, [...(childrenOf.get(key) ?? []), m]);
	}

	const reachable = new Set([rootFullName.toLowerCase()]);
	const queue = [rootFullName.toLowerCase()];
	while (queue.length > 0) {
		const next = queue.shift()!;
		for (const child of childrenOf.get(next) ?? []) {
			const key = child.fullName.toLowerCase();
			if (reachable.has(key)) continue;
			reachable.add(key);
			queue.push(key);
		}
	}
	return reachable;
}
