import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
	addOrSetRemote,
	allCommits,
	cherryPick,
	cherryPickAbort,
	commitSubject,
	commitsNotIn,
	conflictedFiles,
	getRemoteUrl,
	git,
	headCommitDate,
	isClean,
	isGitRepo,
	isLinkedWorktree,
	listWorktrees,
	mergeAbort,
	mergeCommitFiles,
	refSha,
	renameRemote,
	runCommand,
	stagedFiles,
} from './git.js';
import {
	DEFAULT_REMOTE,
	asLinkedWorktree,
	buildTree,
	childrenOf,
	discoverRepos,
	matchIgnore,
	normalizeUrl,
	repoFromPath,
	samePath,
	type Repo,
} from './repo.js';
import {
	childNodes,
	createPlanner,
	nodeKey,
	nodeLabel,
	type EdgeKind,
	type NodeRef,
} from './nodes.js';
import {DEFAULT_CONFIG_BRANCH} from './config.js';
import {closeWorkspace, openWorkspace} from './workspace.js';

export {
	DEFAULT_REMOTE,
	asLinkedWorktree,
	buildTree,
	childrenOf,
	discoverLinkedWorktrees,
	discoverRepos,
	matchIgnore,
	normalizeUrl,
	repoFromPath,
} from './repo.js';
export type {LinkedWorktree, Repo, Tree} from './repo.js';

export type PropagateStatus =
	| 'source'
	| 'up-to-date'
	| 'merged'
	| 'conflict'
	| 'dirty'
	| 'error'
	| 'skipped'
	| 'ignored';

export interface VerifyOutcome {
	status: 'passed' | 'failed';
	command: string;
	message: string;
}

export interface PropagateResult {
	repo: Repo;
	/** The branch this node merges INTO: the destination the tool controls. */
	branch: string;
	/** How this node is fed: from the parent repo, from a sibling branch, or the source. */
	edge: EdgeKind;
	/**
	 * Every node this one merges from. More than one for an integration branch,
	 * which is why the result is a DAG rendered as a tree rather than a tree.
	 */
	parents: NodeRef[];
	status: PropagateStatus;
	/** Files changed by the merge, or conflicting files. */
	files: string[];
	message: string;
	/** A temporary worktree deliberately left in place holding an unresolved conflict. */
	worktree: string | null;
	/** Result of the opt-in `verify` command, when it ran. */
	verify: VerifyOutcome | null;
	children: PropagateResult[];
	/**
	 * Set on the cross-link stub printed under a multi-stem node's other parents:
	 * the label of the node this one is rendered in full under. Stubs carry no
	 * status of their own and must not be counted.
	 */
	reference: string | null;
	/** Root only: what was excluded from the node set and why. */
	notes: string[];
}

export interface PropagateOptions {
	/** Repo whose changes cascade down to its descendants. Defaults to cwd. */
	sourcePath: string;
	/** Directory scanned for sibling repos. Defaults to the source's parent. */
	baseDir?: string;
	/** Explicit repo paths; bypasses scanning when provided. */
	repos?: string[];
	/** Global branch override: every repo becomes a single node at this branch. */
	branch?: string;
	/** Parent-template remote name. Default: `stem`. */
	remoteName?: string;
	/** Report only; no merge commits, no ref updates, no worktrees. */
	dryRun?: boolean;
	/** On conflict, leave the merge in progress for manual resolution instead of aborting. */
	leaveConflicts?: boolean;
	/** Config branch to read per-repo config from. Default: `offshoot`. */
	configBranch?: string;
	/** Set false to ignore config branches entirely. Default: true. */
	useConfig?: boolean;
	/** Run each repo's configured `verify` command in merged nodes. Opt-in. */
	verify?: boolean;
	/** Repo names/paths to exclude from the tree entirely. */
	ignore?: string[];
}

export type LinkStatus = 'linked' | 'repointed' | 'error';

export interface LinkResult {
	repo: Repo;
	status: LinkStatus;
	url: string;
	message: string;
}

export type RenameStatus =
	'renamed' | 'already' | 'missing' | 'taken' | 'error';

export interface RenameResult {
	repo: Repo;
	status: RenameStatus;
	message: string;
}

/** Per-family proposed tree, root-first. */
export interface DiscoveredEdge {
	repo: AncestryRepo;
	parent: AncestryRepo | null;
	/** The parent URL the `stem` remote would be set to, or null if unknown. */
	existingParentUrl: string | null;
}

export interface FamilyTree {
	root: AncestryRepo;
	edges: DiscoveredEdge[];
}

/** A repo augmented with ancestry fingerprints used by `discoverAncestry`. */
export interface AncestryRepo extends Repo {
	/** All commit SHAs reachable from any ref. */
	shas: Set<string>;
	/** Unix timestamp of HEAD; tie-break heuristic only. */
	headDate: number | null;
}

// ──────────────────────────────────────────────────────────────────────────────
// Merging one (repo, branch) node
// ──────────────────────────────────────────────────────────────────────────────

interface MergeOutcome {
	status: Exclude<PropagateStatus, 'source' | 'skipped' | 'ignored'>;
	files: string[];
	message: string;
	worktree: string | null;
	verify: VerifyOutcome | null;
}

/** One thing merged INTO the node's branch. A node has one per stem. */
interface MergeSource {
	/** Objects to fetch first (cross-repo edge), or null (in-repo edge). */
	fetch: {url: string; branch: string} | null;
	/** Ref merged FROM, before any fetch pins it to a sha. */
	ref: string;
	/** Human description of where the change comes from. */
	label: string;
}

interface MergeSpec {
	repoPath: string;
	/** Branch merged INTO. */
	branch: string;
	/** Stems, merged in declaration order. Exactly one for a cross-repo edge. */
	sources: MergeSource[];
	/** Verify command to run after a successful merge, or null. */
	verify: string | null;
}

function outcome(
	status: MergeOutcome['status'],
	message: string,
	files: string[] = [],
	extra: Partial<MergeOutcome> = {},
): MergeOutcome {
	return {status, files, message, worktree: null, verify: null, ...extra};
}

/** The worktree that has `branch` checked out, if any. */
function checkedOutIn(repoPath: string, branch: string) {
	return listWorktrees(repoPath).find((w) => w.branch === branch);
}

function dirtyOutcome(
	branch: string,
	dir: string,
	main: boolean,
): MergeOutcome {
	return outcome(
		'dirty',
		main
			? `working tree not clean — skipped (\`${branch}\` is checked out)`
			: `worktree ${dir} not clean — skipped`,
	);
}

/** `a`, `a and b`, `a, b and c`. */
function listLabels(labels: string[]): string {
	if (labels.length <= 1) return labels[0] ?? '';
	return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

/**
 * Dry-run of ONE stem without a worktree: `git merge-tree` computes the merge in
 * memory, so `--dry-run`/`status` never touch a branch, an index or the working
 * tree. Returns null when git is too old, so the caller can fall back.
 */
function dryRunOne(
	branch: string,
	sourceRef: string,
	repoPath: string,
): MergeOutcome | null {
	if (git(['merge-base', '--is-ancestor', sourceRef, branch], repoPath).ok) {
		return outcome('up-to-date', 'already up to date');
	}
	const m = git(
		['merge-tree', '--write-tree', '--name-only', branch, sourceRef],
		repoPath,
	);
	const lines = m.stdout.split('\n');
	if (m.ok) {
		const treeSha = (lines[0] ?? '').trim();
		if (!/^[0-9a-f]{40,}$/.test(treeSha)) return null; // unsupported git
		const diff = git(['diff', '--name-only', branch, treeSha], repoPath);
		const files = diff.ok
			? diff.stdout
					.split('\n')
					.map((l) => l.trim())
					.filter(Boolean)
			: [];
		return outcome('merged', `would merge ${files.length} file(s)`, files);
	}
	if (m.status === 1) {
		const files: string[] = [];
		for (const line of lines.slice(1)) {
			const f = line.trim();
			if (f === '') break;
			files.push(f);
		}
		return outcome('conflict', `conflict in ${files.length} file(s)`, files);
	}
	return null; // git too old, or a genuine failure: let the caller fall back
}

/**
 * Dry-run of every stem.
 *
 * Each stem is predicted against the branch as it stands now, because
 * `merge-tree` takes commits and there is no commit for "the branch after stem
 * 1 merged". For a single-stem node that is exact; for an integration node the
 * stems after the first are an approximation, and the message says so rather
 * than quietly overstating what a real run would do.
 */
function dryRunMerge(
	spec: MergeSpec,
	refs: string[],
	repoPath: string,
): MergeOutcome | null {
	const files = new Set<string>();
	const conflicted: string[] = [];
	const conflictFiles = new Set<string>();
	const merging: string[] = [];

	for (const [i, ref] of refs.entries()) {
		const one = dryRunOne(spec.branch, ref, repoPath);
		if (one === null) return null; // fall back for the whole node
		const label = spec.sources[i]!.label;
		if (one.status === 'conflict') {
			conflicted.push(label);
			for (const f of one.files) conflictFiles.add(f);
		} else if (one.status === 'merged') {
			merging.push(label);
			for (const f of one.files) files.add(f);
		}
	}

	const approximate =
		refs.length > 1 && merging.length + conflicted.length > 1
			? ' (stems after the first predicted against the current branch)'
			: '';

	if (conflicted.length > 0) {
		return outcome(
			'conflict',
			`conflict in ${conflictFiles.size} file(s) merging ${listLabels(
				conflicted,
			)} (dry-run, nothing changed)${approximate}`,
			[...conflictFiles],
		);
	}
	if (merging.length === 0) {
		return outcome('up-to-date', 'already up to date');
	}
	return outcome(
		'merged',
		`dry-run: would merge ${files.size} file(s) into ${spec.branch}` +
			(refs.length > 1 ? ` from ${listLabels(merging)}` : '') +
			approximate,
		[...files],
	);
}

async function mergeNode(
	spec: MergeSpec,
	opts: {dryRun: boolean; leaveConflicts: boolean},
): Promise<MergeOutcome> {
	// A dirty tree blocks its branch in a dry-run too. `status` promising a merge
	// that a real run then refuses is worse than useless, so this is checked first,
	// before any fetch, exactly as it was before nodes existed.
	const occupied = checkedOutIn(spec.repoPath, spec.branch);
	if (occupied && !isClean(occupied.path)) {
		return dirtyOutcome(spec.branch, occupied.path, occupied.main);
	}

	// The fetch is the only write a dry-run performs (objects only), exactly as before.
	const refs: string[] = [];
	for (const source of spec.sources) {
		if (!source.fetch) {
			refs.push(source.ref);
			continue;
		}
		const f = git(
			['fetch', source.fetch.url, source.fetch.branch],
			spec.repoPath,
		);
		if (!f.ok) {
			return outcome('error', `fetch failed: ${(f.stderr || f.stdout).trim()}`);
		}
		// FETCH_HEAD is per-worktree, and the merge may happen in another one, so
		// pin the fetched commit now: objects are shared, that name is not.
		const fetched = refSha(spec.repoPath, 'FETCH_HEAD');
		if (!fetched) {
			return outcome('error', 'fetch produced no FETCH_HEAD');
		}
		refs.push(fetched);
	}

	if (opts.dryRun) {
		const fast = dryRunMerge(spec, refs, spec.repoPath);
		if (fast) return fast;
	}

	const opened = openWorkspace(spec.repoPath, spec.branch);
	if (!opened.ok) return outcome('error', opened.error);
	const ws = opened.workspace;
	let keep = false;

	try {
		// Re-checked against the resolved workspace: cheap, and the tree can have
		// been dirtied between the check above and here.
		if (!ws.temporary && !isClean(ws.dir)) {
			return dirtyOutcome(spec.branch, ws.dir, ws.main);
		}
		const where = ws.temporary ? ` in a temporary worktree` : '';

		if (opts.dryRun) {
			// Fallback for git without `merge-tree --write-tree`: only the first stem
			// can be evaluated this way, since aborting undoes it before the next.
			const m = git(['merge', '--no-commit', '--no-ff', refs[0]!], ws.dir);
			if (m.ok) {
				if (/already up to date/i.test(m.stdout)) {
					mergeAbort(ws.dir);
					return outcome('up-to-date', 'already up to date');
				}
				const files = stagedFiles(ws.dir);
				mergeAbort(ws.dir);
				return outcome(
					'merged',
					`dry-run: would merge ${files.length} file(s) into ${spec.branch}`,
					files,
				);
			}
			const conflicts = conflictedFiles(ws.dir);
			mergeAbort(ws.dir);
			return outcome(
				'conflict',
				`conflict in ${conflicts.length} file(s) (dry-run, aborted)`,
				conflicts,
			);
		}

		// Merge each stem in order. Earlier merges are already committed by the
		// time a later one conflicts; they are kept (the state is honest, and
		// re-running continues from there) and the message names both what landed
		// and what blocked.
		const files = new Set<string>();
		const landed: string[] = [];

		for (const [i, ref] of refs.entries()) {
			const label = spec.sources[i]!.label;
			const m = git(
				[
					'merge',
					'--no-ff',
					'-m',
					`offshoot-fanout: merge ${label} into ${spec.branch}`,
					ref,
				],
				ws.dir,
			);

			if (m.ok) {
				if (/already up to date/i.test(m.stdout)) continue;
				for (const f of mergeCommitFiles(ws.dir)) files.add(f);
				landed.push(label);
				continue;
			}

			const conflicts = conflictedFiles(ws.dir);
			const alsoLanded =
				landed.length > 0 ? `; ${listLabels(landed)} already merged` : '';
			if (conflicts.length > 0) {
				const stem = refs.length > 1 ? ` merging ${label}` : '';
				if (opts.leaveConflicts) {
					keep = ws.temporary;
					return outcome(
						'conflict',
						keep
							? `conflict in ${conflicts.length} file(s)${stem} — left in a temporary worktree: ${ws.dir}${alsoLanded}`
							: `conflict in ${conflicts.length} file(s)${stem} — left for manual resolution${alsoLanded}`,
						conflicts,
						{worktree: keep ? ws.dir : null},
					);
				}
				mergeAbort(ws.dir);
				return outcome(
					'conflict',
					`conflict in ${conflicts.length} file(s)${stem} — aborted${alsoLanded}`,
					conflicts,
				);
			}
			return outcome(
				'error',
				`merge failed${refs.length > 1 ? ` (${label})` : ''}: ${(
					m.stderr || m.stdout
				).trim()}${alsoLanded}`,
			);
		}

		if (landed.length === 0) {
			return outcome('up-to-date', 'already up to date');
		}

		const verify = spec.verify ? runVerify(spec.verify, ws.dir) : null;
		// A failed verify is only actionable if there is somewhere to go and look,
		// so keep the temporary worktree, exactly as a left conflict does.
		keep = verify?.status === 'failed' && ws.temporary;
		return outcome(
			'merged',
			`merged ${files.size} file(s) into ${spec.branch}` +
				(refs.length > 1 ? ` from ${listLabels(landed)}` : '') +
				where +
				(keep ? `, kept at ${ws.dir}` : ''),
			[...files],
			{verify, worktree: keep ? ws.dir : null},
		);
	} finally {
		if (!keep) closeWorkspace(spec.repoPath, ws);
	}
}

/**
 * Run a repo's configured verify command. Its LAST output line is the report
 * line (checkers put the summary at the end); a command that fails silently is
 * reported by its exit code instead.
 */
function runVerify(command: string, cwd: string): VerifyOutcome {
	const r = runCommand(command, cwd);
	const lastLine = r.output
		.split('\n')
		.map((l) => l.trim())
		.filter(Boolean)
		.pop();
	return {
		status: r.ok ? 'passed' : 'failed',
		command,
		message: r.ok
			? 'verify passed'
			: `verify FAILED (exit ${r.status ?? '?'})${lastLine ? `: ${lastLine}` : ''}`,
	};
}

const SUCCESS: PropagateStatus[] = ['source', 'merged', 'up-to-date'];

function emptyResult(
	repo: Repo,
	branch: string,
	edge: EdgeKind,
	parents: NodeRef[],
): PropagateResult {
	return {
		repo,
		branch,
		edge,
		parents,
		status: 'up-to-date',
		files: [],
		message: '',
		worktree: null,
		verify: null,
		children: [],
		reference: null,
		notes: [],
	};
}

/**
 * Propagate changes from `sourcePath` down through every descendant node.
 *
 * A node is a `(repo, branch)` pair. Edges are cross-repo (the `stem` remote,
 * parent's primary branch -> child's root branches) and in-repo (a branch whose
 * config declares one or more other branches of the same repo as its stems).
 *
 * The node graph is a DAG, not a tree: an integration branch merges several
 * stems, so it must not be processed until EVERY one of them is done, or it
 * merges one side's stale state. That is a topological sweep (Kahn), and each
 * node merges its stems' current LOCAL refs, so an intermediate merge cascades
 * to the leaves in one pass.
 *
 * A failed node's descendants are marked `skipped` (still visited/rendered)
 * rather than merged against stale state. For a node with several stems, ANY
 * failed stem blocks it.
 */
export async function propagate(
	opts: PropagateOptions,
): Promise<PropagateResult> {
	const remoteName = opts.remoteName ?? DEFAULT_REMOTE;
	const sourcePath = path.resolve(opts.sourcePath);
	const baseDir = path.resolve(opts.baseDir ?? path.dirname(sourcePath));
	const notes: string[] = [];

	const worktreeNote = (name: string, mainName: string) =>
		`${name} is a linked worktree of ${mainName} (same repository) — not a node`;

	let repos: Repo[] = [];
	if (opts.repos && opts.repos.length > 0) {
		for (const p of opts.repos) {
			const abs = path.resolve(p);
			const wt = asLinkedWorktree(abs);
			if (wt) {
				notes.push(worktreeNote(wt.name, wt.mainName));
				continue;
			}
			repos.push(repoFromPath(abs, remoteName));
		}
	} else {
		repos = discoverRepos(baseDir, remoteName);
	}

	const planner = createPlanner({
		configBranch: opts.configBranch ?? DEFAULT_CONFIG_BRANCH,
		useConfig: opts.useConfig,
		branchOverride: opts.branch,
		ignore: opts.ignore,
	});

	if (!repos.some((r) => samePath(r.path, sourcePath))) {
		const wt = asLinkedWorktree(sourcePath);
		if (wt) {
			const result = emptyResult(
				repoFromPath(sourcePath, remoteName),
				'(unknown)',
				'source',
				[],
			);
			result.status = 'error';
			result.message = `${wt.name} is a linked worktree of ${wt.mainName}; run from ${wt.mainPath} instead`;
			result.notes = notes;
			return result;
		}
		repos.push(repoFromPath(sourcePath, remoteName));
	}

	// Mention each repo's linked worktrees once, however the repo set was built.
	for (const repo of repos) {
		for (const wt of listWorktrees(repo.path)) {
			if (wt.main) continue;
			const note = worktreeNote(path.basename(wt.path), repo.name);
			if (!notes.includes(note)) notes.push(note);
		}
	}

	const tree = buildTree(repos);
	const source = repos.find((r) => samePath(r.path, sourcePath))!;
	const sourcePlan = planner(source);
	const sourceNode: NodeRef = {repo: source, branch: sourcePlan.primary};
	const sourceKey = nodeKey(source, sourcePlan.primary);

	const root = emptyResult(source, sourcePlan.primary, 'source', []);
	root.status = 'source';
	root.message = sourcePlan.note ? `source (${sourcePlan.note})` : 'source';
	root.notes = notes;
	if (sourcePlan.error) {
		root.status = 'error';
		root.message = sourcePlan.error;
	}

	// ── 1. Discover the reachable node graph ─────────────────────────────────
	// The whole graph has to exist before anything is merged, because a node's
	// turn depends on how many stems feed it, which is not knowable lazily.
	const nodes = new Map<string, NodeRef>([[sourceKey, sourceNode]]);
	const incoming = new Map<string, {from: NodeRef; edge: EdgeKind}[]>();
	const outgoing = new Map<string, NodeRef[]>();
	const stack: NodeRef[] = [sourceNode];

	while (stack.length > 0) {
		const node = stack.shift()!;
		const key = nodeKey(node.repo, node.branch);
		if (outgoing.has(key)) continue; // already expanded
		const kids = childNodes(node, tree, planner);
		outgoing.set(
			key,
			kids.map((k) => k.node),
		);
		for (const kid of kids) {
			const kidKey = nodeKey(kid.node.repo, kid.node.branch);
			if (!nodes.has(kidKey)) nodes.set(kidKey, kid.node);
			const edges = incoming.get(kidKey) ?? [];
			if (!edges.some((e) => nodeKey(e.from.repo, e.from.branch) === key)) {
				edges.push({from: node, edge: kid.edge});
			}
			incoming.set(kidKey, edges);
			stack.push(kid.node);
		}
	}

	// Order each node's stems as the config declares them, not as traversal
	// happened to reach them: the first one decides where the node is rendered in
	// full, and `["extended/a", "extended/b"]` should mean what it says.
	for (const [key, node] of nodes) {
		const edges = incoming.get(key);
		if (!edges || edges.length < 2) continue;
		const declared =
			planner(node.repo).branches.find((b) => b.name === node.branch)?.stems ??
			[];
		const rank = (e: {from: NodeRef}) => {
			if (!samePath(e.from.repo.path, node.repo.path)) return -1; // cross-repo first
			const i = declared.indexOf(e.from.branch);
			return i === -1 ? declared.length : i;
		};
		edges.sort((a, b) => rank(a) - rank(b));
	}

	// ── 2. Sweep it in topological order ─────────────────────────────────────
	const pending = new Map<string, number>();
	for (const key of nodes.keys()) {
		// Edges into the source are ignored: it is where the cascade starts, so a
		// cycle back to it must not stop the sweep from beginning.
		pending.set(key, key === sourceKey ? 0 : (incoming.get(key)?.length ?? 0));
	}

	const results = new Map<string, PropagateResult>([[sourceKey, root]]);
	const blocked = new Map<string, PropagateStatus>();
	if (root.status !== 'source') blocked.set(sourceKey, root.status);

	/** Attach a finished node under its first parent, cross-linking the rest. */
	const attach = (key: string, result: PropagateResult) => {
		const parents = (incoming.get(key) ?? []).map((e) => e.from);
		const first = parents[0];
		if (!first) return;
		const firstResult = results.get(nodeKey(first.repo, first.branch));
		firstResult?.children.push(result);
		for (const other of parents.slice(1)) {
			const otherResult = results.get(nodeKey(other.repo, other.branch));
			if (!otherResult) continue;
			const stub = emptyResult(
				result.repo,
				result.branch,
				result.edge,
				result.parents,
			);
			stub.status = result.status;
			stub.reference = nodeLabel(first.repo, first.branch);
			otherResult.children.push(stub);
		}
	};

	const ready: string[] = [sourceKey];
	const done = new Set<string>();

	while (ready.length > 0) {
		const key = ready.shift()!;
		done.add(key);
		const node = nodes.get(key)!;
		const result = results.get(key);

		// The source's own result is pre-built; every other node is merged here.
		if (!result) {
			const parents = (incoming.get(key) ?? []).map((e) => e.from);
			const edge = incoming.get(key)?.[0]?.edge ?? 'cross-repo';
			const nodeResult = emptyResult(node.repo, node.branch, edge, parents);
			const plan = planner(node.repo);
			const blockedBy = blocked.get(key);

			if (blockedBy) {
				nodeResult.status = 'skipped';
				nodeResult.message = `parent not updated (${blockedBy})`;
			} else if (plan.ignored !== null) {
				nodeResult.status = 'ignored';
				nodeResult.message = `ignored (\`${plan.ignored}\`)`;
			} else if (plan.error) {
				nodeResult.status = 'error';
				nodeResult.message = plan.error;
			} else {
				const sources: MergeSource[] = parents.map((parent) =>
					samePath(parent.repo.path, node.repo.path)
						? {
								fetch: null,
								ref: parent.branch,
								label: parent.branch,
							}
						: {
								fetch: {url: parent.repo.path, branch: parent.branch},
								ref: 'FETCH_HEAD',
								label: `${parent.repo.name}@${parent.branch}`,
							},
				);
				const merged = await mergeNode(
					{
						repoPath: node.repo.path,
						branch: node.branch,
						sources,
						verify: opts.verify ? plan.verify : null,
					},
					{
						dryRun: !!opts.dryRun,
						leaveConflicts: !!opts.leaveConflicts,
					},
				);
				nodeResult.status = merged.status;
				nodeResult.files = merged.files;
				nodeResult.message = merged.message;
				nodeResult.worktree = merged.worktree;
				nodeResult.verify = merged.verify;
				if (plan.note) nodeResult.message += ` (${plan.note})`;
			}

			results.set(key, nodeResult);
			attach(key, nodeResult);
			if (!SUCCESS.includes(nodeResult.status)) {
				for (const child of outgoing.get(key) ?? []) {
					const childKey = nodeKey(child.repo, child.branch);
					if (!blocked.has(childKey)) blocked.set(childKey, nodeResult.status);
				}
			}
		} else if (!SUCCESS.includes(result.status)) {
			for (const child of outgoing.get(key) ?? []) {
				const childKey = nodeKey(child.repo, child.branch);
				if (!blocked.has(childKey)) blocked.set(childKey, result.status);
			}
		}

		for (const child of outgoing.get(key) ?? []) {
			const childKey = nodeKey(child.repo, child.branch);
			const left = (pending.get(childKey) ?? 0) - 1;
			pending.set(childKey, left);
			if (left <= 0 && !done.has(childKey) && !ready.includes(childKey)) {
				ready.push(childKey);
			}
		}
	}

	// Anything still waiting is in a cycle (repos wired to each other, say).
	// Report it rather than letting it vanish from the tree.
	for (const [key, node] of nodes) {
		if (done.has(key)) continue;
		const waiting = (incoming.get(key) ?? [])
			.filter((e) => !done.has(nodeKey(e.from.repo, e.from.branch)))
			.map((e) => nodeLabel(e.from.repo, e.from.branch));
		const parents = (incoming.get(key) ?? []).map((e) => e.from);
		const cycle = emptyResult(
			node.repo,
			node.branch,
			incoming.get(key)?.[0]?.edge ?? 'cross-repo',
			parents,
		);
		cycle.status = 'error';
		cycle.message = `never reached: still waiting on ${listLabels(waiting)} (stem cycle)`;
		results.set(key, cycle);
		attach(key, cycle);
	}

	return root;
}

/**
 * Create or repoint the parent remote (`remoteName`, default `stem`) on `childPath`
 * so it points at `url`.
 */
export function linkRemote(
	childPath: string,
	url: string,
	remoteName = DEFAULT_REMOTE,
): LinkResult {
	const repo = repoFromPath(childPath, remoteName);
	const had = repo.originalUrl !== null;
	const r = addOrSetRemote(childPath, remoteName, url);
	if (!r.ok) {
		return {
			repo,
			status: 'error',
			url,
			message: `failed: ${(r.stderr || r.stdout).trim()}`,
		};
	}
	return {
		repo,
		status: had ? 'repointed' : 'linked',
		url,
		message: had
			? `repointed \`${remoteName}\` -> ${url}`
			: `added \`${remoteName}\` -> ${url}`,
	};
}

/**
 * Rename the parent remote from `from` to `to` across every repo under `baseDir`.
 * Repos without `from` are reported `missing` (no-op); a `to` that already exists
 * (with a different URL) is reported `taken` rather than clobbered.
 */
export function renameRemotes(
	baseDir: string,
	from: string,
	to: string,
	dryRun = false,
): RenameResult[] {
	// Only consider repos that actually have the `from` remote — silent on the rest.
	const repos = discoverRepos(baseDir, from).filter(
		(r) => r.originalUrl !== null,
	);
	const results: RenameResult[] = [];
	for (const repo of repos) {
		const fromUrl = repo.originalUrl;
		if (!fromUrl) {
			results.push({repo, status: 'missing', message: `no \`${from}\` remote`});
			continue;
		}
		const existingTo = getRemoteUrl(repo.path, to);
		if (existingTo && normalizeUrl(existingTo) !== normalizeUrl(fromUrl)) {
			results.push({
				repo,
				status: 'taken',
				message: `\`${to}\` already exists (-> ${existingTo}); not overwriting`,
			});
			continue;
		}
		if (existingTo) {
			// already correctly named/pointing; treat as a no-op success
			results.push({
				repo,
				status: 'already',
				message: `\`${to}\` already -> ${existingTo}`,
			});
			continue;
		}
		if (dryRun) {
			results.push({
				repo,
				status: 'renamed',
				message: `would rename \`${from}\` -> \`${to}\` (${fromUrl})`,
			});
			continue;
		}
		const r = renameRemote(repo.path, from, to);
		if (!r.ok) {
			results.push({
				repo,
				status: 'error',
				message: `rename failed: ${(r.stderr || r.stdout).trim()}`,
			});
			continue;
		}
		results.push({
			repo,
			status: 'renamed',
			message: `\`${from}\` -> \`${to}\` (${fromUrl})`,
		});
	}
	return results;
}

/** Build an `AncestryRepo` (with commit fingerprints) from a path. */
export function ancestryRepo(
	p: string,
	remoteName = DEFAULT_REMOTE,
): AncestryRepo {
	const base = repoFromPath(p, remoteName);
	return {
		...base,
		shas: new Set(allCommits(p)),
		headDate: headCommitDate(p),
	};
}

/**
 * Discover repos under `baseDir` and group them into families by shared git
 * ancestry (two repos are related when their commit-SHA sets intersect — a
 * clone shares all of its source's pre-clone commits).
 *
 * Direction (which member is the root) cannot be determined from history alone
 * once both sides diverged past the fork, so the root is a *proposal*: the
 * member with the fewest commits (tie-broken by oldest HEAD). Within a family,
 * each member's proposed parent is the already-placed member with which it
 * shares the most commits — placed root-first by ascending commit count.
 *
 * `existingParentUrl` carries each repo's current parent-remote URL (if any),
 * so callers can show what's already wired vs. what `--add-remotes` would add.
 */
export function discoverAncestry(
	baseDir: string,
	remoteName = DEFAULT_REMOTE,
	ignore: string[] = [],
): FamilyTree[] {
	if (!fs.existsSync(baseDir)) return [];
	const repos: AncestryRepo[] = [];
	for (const entry of fs.readdirSync(baseDir, {withFileTypes: true})) {
		if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
		const p = path.join(baseDir, entry.name);
		if (!isGitRepo(p)) continue;
		// A linked worktree is the same repository as its parent: it shares every
		// commit, so it would look like a perfect "family member" of itself.
		if (isLinkedWorktree(p)) continue;
		if (matchIgnore({name: entry.name, path: p}, ignore)) continue;
		repos.push(ancestryRepo(p, remoteName));
	}

	// Union-find families by shared commit SHAs.
	const parent = new Map<string, string>();
	const find = (x: string): string => {
		let cur = x;
		while (parent.get(cur) !== cur) cur = parent.get(cur)!;
		let root = cur;
		cur = x;
		while (parent.get(cur) !== cur) {
			const next = parent.get(cur)!;
			parent.set(cur, root);
			cur = next;
		}
		return root;
	};
	const union = (a: string, b: string) => {
		const ra = find(a);
		const rb = find(b);
		if (ra !== rb) parent.set(ra, rb);
	};
	for (const r of repos) parent.set(r.path, r.path);

	// Build a global SHA -> first repo that has it, to intersect cheaply.
	const shaToRepo = new Map<string, string>();
	for (const r of repos) {
		for (const sha of r.shas) {
			const first = shaToRepo.get(sha);
			if (first && first !== r.path) union(first, r.path);
			else if (!first) shaToRepo.set(sha, r.path);
		}
	}

	// Group by family root.
	const familiesByRoot = new Map<string, AncestryRepo[]>();
	for (const r of repos) {
		const f = find(r.path);
		const arr = familiesByRoot.get(f) ?? [];
		arr.push(r);
		familiesByRoot.set(f, arr);
	}

	const trees: FamilyTree[] = [];
	for (const members of familiesByRoot.values()) {
		if (members.length === 0) continue;
		if (members.length === 1) {
			trees.push({
				root: members[0]!,
				edges: [
					{
						repo: members[0]!,
						parent: null,
						existingParentUrl: members[0]!.originalUrl,
					},
				],
			});
			continue;
		}
		// Order most-ancestral-first: fewest commits, then oldest HEAD.
		const ordered = [...members].sort((a, b) => {
			if (a.shas.size !== b.shas.size) return a.shas.size - b.shas.size;
			const ad = a.headDate ?? Number.POSITIVE_INFINITY;
			const bd = b.headDate ?? Number.POSITIVE_INFINITY;
			return ad - bd;
		});

		const placed = new Map<string, AncestryRepo>();
		const edges: DiscoveredEdge[] = [];
		for (const r of ordered) {
			let best: AncestryRepo | null = null;
			let bestIntersection = 0;
			for (const p of placed.values()) {
				let shared = 0;
				const [small, large] =
					p.shas.size < r.shas.size ? [p.shas, r.shas] : [r.shas, p.shas];
				for (const sha of small) if (large.has(sha)) shared++;
				if (shared > bestIntersection) {
					bestIntersection = shared;
					best = p;
				}
			}
			placed.set(r.path, r);
			edges.push({repo: r, parent: best, existingParentUrl: r.originalUrl});
		}

		const root = ordered[0]!;
		trees.push({root, edges});
	}

	// Stable-ish ordering of families for display: by root commit count then name.
	trees.sort(
		(a, b) =>
			a.root.shas.size - b.root.shas.size ||
			a.root.name.localeCompare(b.root.name),
	);
	return trees;
}

// ──────────────────────────────────────────────────────────────────────────────
// Registry: a persisted hierarchy at ~/.offshoot-stems/<root>.json
// ──────────────────────────────────────────────────────────────────────────────

export interface RegistryRepo {
	name: string;
	path: string;
	originUrl: string | null;
	/** The parent (`stem`) remote URL, or null if unwired. */
	stemUrl: string | null;
	/** Detected parent repo name, or null for the root. */
	parent: string | null;
}

export interface Registry {
	version: number;
	remoteName: string;
	generatedAt: string;
	root: string;
	repos: RegistryRepo[];
	/**
	 * Maintainer-local exclusions: repos that exist on disk but must stay out of
	 * the tree (a deprecated template whose folder has not been deleted yet).
	 * This is local state, so it lives here rather than in a repo's config branch.
	 * `discover --save` preserves it.
	 */
	ignore?: string[];
}

/** ~/.offshoot-stems/ */
export function registryDir(): string {
	return path.join(os.homedir(), '.offshoot-stems');
}

/** ~/.offshoot-stems/<rootName>.json */
export function registryPath(rootName: string): string {
	return path.join(registryDir(), `${rootName}.json`);
}

/**
 * Write one registry file per wired hierarchy (defined by `stem` remotes, not
 * shared commits), so the file reflects the tree the tool actually merges along.
 * `parent` is the real stem-wired parent; `stemUrl` is the repo's current `stem`
 * remote (null = unwired). With `rootFilter`, only that root's family is saved.
 */
export function saveRegistry(
	repos: Repo[],
	remoteName: string,
	rootFilter?: string,
	extraIgnore: string[] = [],
): string[] {
	fs.mkdirSync(registryDir(), {recursive: true});
	const generatedAt = new Date().toISOString();
	const tree = buildTree(repos);

	// A root has no `stem` parent inside the set (unwired, or pointing outside).
	const isRoot = (r: Repo): boolean => {
		if (!r.originalUrl) return true;
		return tree.byOrigin.get(normalizeUrl(r.originalUrl)) === undefined;
	};
	const roots = repos.filter(isRoot);

	const written: string[] = [];
	for (const root of roots) {
		if (rootFilter && path.resolve(root.path) !== path.resolve(rootFilter))
			continue;
		// Collect the wired subtree (real stem edges) rooted at `root`.
		const members: Repo[] = [];
		const seen = new Set<string>();
		const queue: Repo[] = [root];
		while (queue.length > 0) {
			const n = queue.shift()!;
			if (seen.has(n.path)) continue;
			seen.add(n.path);
			members.push(n);
			for (const c of childrenOf(n, tree)) queue.push(c);
		}
		if (members.length < 2) continue; // lone repo, not a hierarchy

		const regRepos: RegistryRepo[] = members.map((m) => {
			const parent = m.originalUrl
				? (tree.byOrigin.get(normalizeUrl(m.originalUrl)) ?? null)
				: null;
			return {
				name: m.name,
				path: m.path,
				originUrl: m.originUrl,
				stemUrl: m.originalUrl,
				parent: parent ? parent.name : null,
			};
		});
		const file = registryPath(root.name);
		// Never clobber an existing `ignore` array: it is hand-maintained state that
		// a re-scan knows nothing about.
		const previous = loadRegistry(file);
		const ignore = [...new Set([...(previous?.ignore ?? []), ...extraIgnore])];
		const reg: Registry = {
			version: 1,
			remoteName,
			generatedAt,
			root: root.name,
			repos: regRepos,
			...(ignore.length > 0 ? {ignore} : {}),
		};
		fs.writeFileSync(file, JSON.stringify(reg, null, 2) + '\n', 'utf8');
		written.push(file);
	}
	return written;
}

/** Load a registry file into a plain `Repo[]` (stemUrl -> originalUrl). */
export function loadRegistry(
	file: string,
): {root: string; remoteName: string; repos: Repo[]; ignore: string[]} | null {
	if (!fs.existsSync(file)) return null;
	let reg: Registry;
	try {
		reg = JSON.parse(fs.readFileSync(file, 'utf8')) as Registry;
	} catch {
		return null;
	}
	const repos: Repo[] = reg.repos.map((r) => ({
		name: r.name,
		path: r.path,
		originUrl: r.originUrl,
		originalUrl: r.stemUrl,
	}));
	return {
		root: reg.root,
		remoteName: reg.remoteName,
		repos,
		ignore: Array.isArray(reg.ignore) ? reg.ignore : [],
	};
}

// ──────────────────────────────────────────────────────────────────────────────
// Drift: descendant commits not yet in their parent (candidate backports)
// ──────────────────────────────────────────────────────────────────────────────

export interface DriftResult {
	repo: Repo;
	/** The branch that is ahead. Drift is per node, not per repo. */
	branch: string;
	/** What it is ahead OF, e.g. `template-svelte@main` or `main` (in-repo). */
	stem: string;
	ahead: {sha: string; subject: string}[];
	error?: string;
}

export interface DriftOptions {
	configBranch?: string;
	useConfig?: boolean;
	ignore?: string[];
}

/**
 * For every node with a stem (a child repo's root branch for a cross-repo
 * edge, or a branch whose stem is a sibling branch) list the commits it has
 * that its stem lacks. Comparing per node is what makes drift able to notice
 * that a change landed on the wrong branch.
 */
export function driftTree(
	repos: Repo[],
	/** Kept for call-site symmetry: each repo already carries its resolved stem URL. */
	_remoteName: string,
	branch?: string,
	opts: DriftOptions = {},
): DriftResult[] {
	const tree = buildTree(repos);
	const planner = createPlanner({
		configBranch: opts.configBranch ?? DEFAULT_CONFIG_BRANCH,
		useConfig: opts.useConfig,
		branchOverride: branch,
		ignore: opts.ignore,
	});
	const results: DriftResult[] = [];

	for (const repo of repos) {
		const plan = planner(repo);
		if (plan.ignored !== null) continue;
		if (plan.error) {
			results.push({
				repo,
				branch: plan.primary,
				stem: '?',
				ahead: [],
				error: plan.error,
			});
			continue;
		}

		// in-repo edges: a branch whose stem(s) are other branches of this repo.
		// With several stems, "ahead" means commits in NONE of them, so an
		// integration branch is not reported as ahead of what it just merged.
		for (const node of plan.branches) {
			if (node.stems.length === 0) continue;
			const r = commitsNotIn(repo.path, node.stems, node.name);
			results.push({
				repo,
				branch: node.name,
				stem: node.stems.join(' + '),
				ahead: r.ok ? r.commits : [],
				...(r.ok ? {} : {error: r.error}),
			});
		}

		// cross-repo edge: this repo's root branches vs the parent's primary branch
		if (!repo.originalUrl) continue; // root or unwired: nothing to compare
		const parentLocal =
			tree.byOrigin.get(normalizeUrl(repo.originalUrl)) ?? null;
		const fetchUrl = parentLocal ? parentLocal.path : repo.originalUrl;
		const parentBranch = parentLocal
			? planner(parentLocal).primary
			: (branch ?? 'main');
		const stemLabel = `${parentLocal ? parentLocal.name : repo.originalUrl}@${parentBranch}`;

		const fetched = git(['fetch', fetchUrl, parentBranch], repo.path);
		for (const node of plan.branches) {
			if (node.stems.length > 0) continue;
			if (!fetched.ok) {
				results.push({
					repo,
					branch: node.name,
					stem: stemLabel,
					ahead: [],
					error: `fetch failed: ${(fetched.stderr || fetched.stdout).trim()}`,
				});
				continue;
			}
			const r = commitsNotIn(repo.path, ['FETCH_HEAD'], node.name);
			results.push({
				repo,
				branch: node.name,
				stem: stemLabel,
				ahead: r.ok ? r.commits : [],
				...(r.ok ? {} : {error: r.error}),
			});
		}
	}
	return results;
}

// ──────────────────────────────────────────────────────────────────────────────
// Backport: cherry-pick a descendant commit onto an ancestor (the "home")
// ──────────────────────────────────────────────────────────────────────────────

export interface BackportResult {
	ancestorPath: string;
	ancestorName: string;
	/** The ancestor branch the commit was cherry-picked onto. */
	ancestorBranch: string;
	status: 'backported' | 'conflict' | 'dry-run' | 'error';
	commit: string;
	subject: string | null;
	message: string;
	/** Temporary worktree left in place holding an unresolved conflict. */
	worktree: string | null;
}

export interface BackportOptions {
	/** Repo the commit lives in. */
	fromPath: string;
	/** Commit SHA to cherry-pick. */
	commit: string;
	/** Target ancestor. If omitted, defaults to the from-repo's immediate `stem` parent. */
	toPath?: string;
	branch?: string;
	remoteName?: string;
	/** Repo set used to resolve the default ancestor (and, in the CLI, the cascade). */
	repos?: Repo[];
	dryRun?: boolean;
	leaveConflicts?: boolean;
	configBranch?: string;
	useConfig?: boolean;
}

export function backport(opts: BackportOptions): BackportResult {
	const remoteName = opts.remoteName ?? DEFAULT_REMOTE;
	const fromRepo = repoFromPath(opts.fromPath, remoteName);
	const planner = createPlanner({
		configBranch: opts.configBranch ?? DEFAULT_CONFIG_BRANCH,
		useConfig: opts.useConfig,
		branchOverride: opts.branch,
	});
	const branch = opts.branch ?? planner(fromRepo).primary;

	// Resolve the ancestor: explicit --to, else the from-repo's immediate stem parent.
	let ancestorPath = opts.toPath;
	if (!ancestorPath) {
		const repos =
			opts.repos ?? discoverRepos(path.dirname(opts.fromPath), remoteName);
		const tree = buildTree(repos);
		const parentLocal = fromRepo.originalUrl
			? (tree.byOrigin.get(normalizeUrl(fromRepo.originalUrl)) ?? null)
			: null;
		if (!parentLocal) {
			return {
				ancestorPath: '',
				ancestorName: '',
				ancestorBranch: '?',
				status: 'error',
				commit: opts.commit,
				subject: null,
				message: `no --to given and \`${remoteName}\` parent not resolvable for ${fromRepo.name}`,
				worktree: null,
			};
		}
		ancestorPath = parentLocal.path;
	}

	const ancestor = repoFromPath(ancestorPath, remoteName);
	const ancestorPlan = planner(ancestor);
	const ancestorBranch = ancestorPlan.primary;

	// Bring the descendant's commit into the ancestor's object db, then describe it.
	const fetch = git(['fetch', opts.fromPath, branch], ancestorPath);
	const base = {
		ancestorPath,
		ancestorName: ancestor.name,
		ancestorBranch,
		commit: opts.commit,
		worktree: null as string | null,
	};
	if (!fetch.ok) {
		return {
			...base,
			status: 'error',
			subject: null,
			message: `fetch failed: ${(fetch.stderr || fetch.stdout).trim()}`,
		};
	}
	const subj = commitSubject(ancestorPath, opts.commit);

	if (opts.dryRun) {
		return {
			...base,
			status: 'dry-run',
			subject: subj,
			message: `would cherry-pick ${opts.commit} onto ${ancestor.name}@${ancestorBranch}`,
		};
	}

	// Cherry-pick onto the ancestor's node branch, which is not necessarily the
	// branch it has checked out (same rule as a merge: never `git checkout`).
	const opened = openWorkspace(ancestorPath, ancestorBranch);
	if (!opened.ok) {
		return {...base, status: 'error', subject: subj, message: opened.error};
	}
	const ws = opened.workspace;
	let keep = false;
	try {
		if (!ws.temporary && !isClean(ws.dir)) {
			return {
				...base,
				status: 'error',
				subject: subj,
				message: `${ancestor.name} working tree not clean`,
			};
		}

		const cp = cherryPick(ws.dir, opts.commit);
		if (cp.ok) {
			return {
				...base,
				status: 'backported',
				subject: subj,
				message: `cherry-picked ${opts.commit} onto ${ancestor.name}@${ancestorBranch}`,
			};
		}
		const conflicts = conflictedFiles(ws.dir);
		if (conflicts.length > 0) {
			if (opts.leaveConflicts) {
				keep = ws.temporary;
				return {
					...base,
					status: 'conflict',
					subject: subj,
					worktree: keep ? ws.dir : null,
					message: keep
						? `conflict in ${conflicts.length} file(s) — left in a temporary worktree: ${ws.dir}`
						: `conflict in ${conflicts.length} file(s) — left for manual resolution`,
				};
			}
			cherryPickAbort(ws.dir);
			return {
				...base,
				status: 'conflict',
				subject: subj,
				message: `conflict in ${conflicts.length} file(s) — aborted`,
			};
		}
		return {
			...base,
			status: 'error',
			subject: subj,
			message: `cherry-pick failed: ${(cp.stderr || cp.stdout).trim()}`,
		};
	} finally {
		if (!keep) closeWorkspace(ancestorPath, ws);
	}
}

// ──────────────────────────────────────────────────────────────────────────────
// Status: a consolidated triage of a wired hierarchy (wiring + downstream + upstream)
// ──────────────────────────────────────────────────────────────────────────────

export interface RootStatus {
	root: Repo;
	/** Total nodes ((repo, branch) pairs) in this wired subtree. */
	nodeCount: number;
	/** Total repos in this wired subtree (root + descendants). */
	repoCount: number;
	/** Downstream counts from a `fanout --dry-run` of the root. */
	counts: {
		merged: number;
		upToDate: number;
		conflict: number;
		error: number;
		skipped: number;
		dirty: number;
		ignored: number;
	};
	/** Nodes that conflicted on the dry-run, with their conflicting files. */
	conflicts: {repo: Repo; branch: string; files: string[]}[];
	/** Labels (`repo@branch`) of nodes blocked because an ancestor failed. */
	blocked: string[];
	/** Labels of nodes deliberately left out of the tree. */
	ignored: string[];
	/** Upstream drift: nodes with commits ahead of their stem (candidate backports). */
	drift: DriftResult[];
	/** Things excluded from the node set entirely (linked worktrees). */
	notes: string[];
}

export interface StatusOptions {
	configBranch?: string;
	useConfig?: boolean;
	ignore?: string[];
}

/**
 * One-command triage over the wired tree(s) in `repos`: for each wired root,
 * run a `fanout --dry-run` (downstream: who merges, who conflicts, who is blocked)
 * and a `drift` (upstream: candidate backports). Read-only (fetches objects only).
 */
export async function statusTree(
	repos: Repo[],
	remoteName = DEFAULT_REMOTE,
	branch?: string,
	opts: StatusOptions = {},
): Promise<RootStatus[]> {
	const tree = buildTree(repos);
	// A wired root has no `stem` parent inside the set and at least one descendant.
	const roots = repos.filter((r) => {
		if (matchIgnore(r, opts.ignore)) return false;
		const parent = r.originalUrl
			? tree.byOrigin.get(normalizeUrl(r.originalUrl))
			: undefined;
		return !parent && childrenOf(r, tree).length > 0;
	});

	const results: RootStatus[] = [];
	for (const root of roots) {
		const downstream = await propagate({
			sourcePath: root.path,
			repos: repos.map((r) => r.path),
			remoteName,
			branch,
			dryRun: true,
			configBranch: opts.configBranch,
			useConfig: opts.useConfig,
			ignore: opts.ignore,
		});
		const counts = {
			merged: 0,
			upToDate: 0,
			conflict: 0,
			error: 0,
			skipped: 0,
			dirty: 0,
			ignored: 0,
		};
		const conflicts: {repo: Repo; branch: string; files: string[]}[] = [];
		const blocked: string[] = [];
		const ignored: string[] = [];
		const subtreeRepos: Repo[] = [];
		const seenRepos = new Set<string>();
		let nodeCount = 0;
		const walk = (n: PropagateResult) => {
			if (n.reference) return; // counted where it is rendered in full
			nodeCount++;
			if (!seenRepos.has(path.resolve(n.repo.path))) {
				seenRepos.add(path.resolve(n.repo.path));
				subtreeRepos.push(n.repo);
			}
			if (n.status === 'merged') counts.merged++;
			else if (n.status === 'up-to-date') counts.upToDate++;
			else if (n.status === 'conflict') {
				counts.conflict++;
				conflicts.push({repo: n.repo, branch: n.branch, files: n.files});
			} else if (n.status === 'error') counts.error++;
			else if (n.status === 'skipped') {
				counts.skipped++;
				blocked.push(nodeLabel(n.repo, n.branch));
			} else if (n.status === 'dirty') counts.dirty++;
			else if (n.status === 'ignored') {
				counts.ignored++;
				ignored.push(nodeLabel(n.repo, n.branch));
			}
			n.children.forEach(walk);
		};
		walk(downstream);
		const drift = driftTree(subtreeRepos, remoteName, branch, {
			configBranch: opts.configBranch,
			useConfig: opts.useConfig,
			ignore: opts.ignore,
		}).filter((d) => d.ahead.length > 0 || d.error);
		results.push({
			root,
			counts,
			conflicts,
			blocked,
			ignored,
			drift,
			nodeCount,
			repoCount: subtreeRepos.length,
			notes: downstream.notes,
		});
	}
	return results;
}
