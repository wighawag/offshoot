import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
	addOrSetRemote,
	allCommits,
	cherryPick,
	cherryPickAbort,
	commitSubject,
	commitsAhead,
	conflictedFiles,
	getRemoteUrl,
	git,
	headCommitDate,
	isClean,
	isGitRepo,
	mergeAbort,
	mergeCommitFiles,
	renameRemote,
	stagedFiles,
} from './git.js';

/** Default name of the parent-template remote. */
export const DEFAULT_REMOTE = 'stem';

export interface Repo {
	name: string;
	path: string;
	/** `origin` remote URL — the repo's own identity. */
	originUrl: string | null;
	/** Parent-template remote URL (named `remoteName`, default `stem`), or null. */
	originalUrl: string | null;
}

export type PropagateStatus =
	| 'source'
	| 'up-to-date'
	| 'merged'
	| 'conflict'
	| 'dirty'
	| 'error'
	| 'skipped';

export interface PropagateResult {
	repo: Repo;
	parent: Repo | null;
	status: PropagateStatus;
	/** Files changed by the merge, or conflicting files. */
	files: string[];
	message: string;
	children: PropagateResult[];
}

export interface PropagateOptions {
	/** Repo whose changes cascade down to its descendants. Defaults to cwd. */
	sourcePath: string;
	/** Directory scanned for sibling repos. Defaults to the source's parent. */
	baseDir?: string;
	/** Explicit repo paths; bypasses scanning when provided. */
	repos?: string[];
	/** Branch to fetch/merge from the parent. Default: `main`. */
	branch?: string;
	/** Parent-template remote name. Default: `stem`. */
	remoteName?: string;
	/** Report only; perform fetch + `--no-commit` merge then abort. */
	dryRun?: boolean;
	/** On conflict, leave the merge in progress for manual resolution instead of aborting. */
	leaveConflicts?: boolean;
}

export interface Tree {
	repos: Repo[];
	/** normalized originUrl -> repo, for resolving a child's parent remote to a local clone. */
	byOrigin: Map<string, Repo>;
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

/**
 * Normalize a git remote URL to a canonical, comparable form:
 *   git@github.com:wighawag/x.git   ->  https://github.com/wighawag/x
 *   https://github.com/Wighawag/X   ->  https://github.com/wighawag/x
 *   /abs/local/path                 ->  /abs/local/path (lowercased)
 */
export function normalizeUrl(url: string): string {
	let s = url.trim();
	s = s.replace(/\.git$/, '');
	s = s.replace(/^git@([^:]+):/, 'https://$1/');
	s = s.replace(/^ssh:\/\/git@([^:/]+)\/?/, 'https://$1/');
	s = s.replace(/^ssh:\/\//, 'https://');
	s = s.replace(/^git:\/\//, 'https://');
	s = s.replace(/^https:\/\/git@/, 'https://');
	s = s.toLowerCase();
	return s;
}

function samePath(a: string, b: string): boolean {
	return path.resolve(a) === path.resolve(b);
}

function repoFromPath(p: string, remoteName: string): Repo {
	return {
		name: path.basename(p),
		path: p,
		originUrl: isGitRepo(p) ? getRemoteUrl(p, 'origin') : null,
		originalUrl: isGitRepo(p) ? getRemoteUrl(p, remoteName) : null,
	};
}

/** Scan `baseDir`'s immediate subdirectories for git repos and read their remotes. */
export function discoverRepos(
	baseDir: string,
	remoteName = DEFAULT_REMOTE,
): Repo[] {
	if (!fs.existsSync(baseDir)) return [];
	const repos: Repo[] = [];
	for (const entry of fs.readdirSync(baseDir, {withFileTypes: true})) {
		if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
		const p = path.join(baseDir, entry.name);
		if (!isGitRepo(p)) continue;
		repos.push(repoFromPath(p, remoteName));
	}
	return repos;
}

export function buildTree(repos: Repo[]): Tree {
	const byOrigin = new Map<string, Repo>();
	for (const r of repos) {
		if (r.originUrl) byOrigin.set(normalizeUrl(r.originUrl), r);
	}
	return {repos, byOrigin};
}

/** Direct children of `parent` = repos whose parent remote matches `parent`'s `origin`. */
export function childrenOf(parent: Repo, tree: Tree): Repo[] {
	const key = parent.originUrl ? normalizeUrl(parent.originUrl) : null;
	return tree.repos.filter(
		(r) =>
			r.originalUrl !== null &&
			key !== null &&
			normalizeUrl(r.originalUrl) === key &&
			!samePath(r.path, parent.path),
	);
}

type MergeOutcome = {
	status: Exclude<PropagateStatus, 'source' | 'skipped'>;
	files: string[];
	message: string;
};

async function mergeOne(
	child: Repo,
	fetchUrl: string,
	branch: string,
	dryRun: boolean,
	leaveConflicts: boolean,
): Promise<MergeOutcome> {
	if (!isClean(child.path)) {
		return {
			status: 'dirty',
			files: [],
			message: 'working tree not clean — skipped',
		};
	}

	const fetch = git(['fetch', fetchUrl, branch], child.path);
	if (!fetch.ok) {
		return {
			status: 'error',
			files: [],
			message: `fetch failed: ${(fetch.stderr || fetch.stdout).trim()}`,
		};
	}

	if (dryRun) {
		const m = git(
			['merge', '--no-commit', '--no-ff', 'FETCH_HEAD'],
			child.path,
		);
		if (m.ok) {
			if (/already up to date/i.test(m.stdout)) {
				mergeAbort(child.path);
				return {status: 'up-to-date', files: [], message: 'already up to date'};
			}
			const files = stagedFiles(child.path);
			mergeAbort(child.path);
			return {
				status: 'merged',
				files,
				message: `dry-run: would merge ${files.length} file(s)`,
			};
		}
		const conflicts = conflictedFiles(child.path);
		mergeAbort(child.path);
		return {
			status: 'conflict',
			files: conflicts,
			message: `conflict in ${conflicts.length} file(s) (dry-run, aborted)`,
		};
	}

	const m = git(
		[
			'merge',
			'--no-ff',
			'-m',
			`offshoot-fanout: merge ${branch} from parent`,
			'FETCH_HEAD',
		],
		child.path,
	);
	if (m.ok) {
		if (/already up to date/i.test(m.stdout)) {
			return {status: 'up-to-date', files: [], message: 'already up to date'};
		}
		const files = mergeCommitFiles(child.path);
		return {status: 'merged', files, message: `merged ${files.length} file(s)`};
	}
	const conflicts = conflictedFiles(child.path);
	if (conflicts.length > 0) {
		if (leaveConflicts) {
			return {
				status: 'conflict',
				files: conflicts,
				message: `conflict in ${conflicts.length} file(s) — left for manual resolution`,
			};
		}
		mergeAbort(child.path);
		return {
			status: 'conflict',
			files: conflicts,
			message: `conflict in ${conflicts.length} file(s) — aborted`,
		};
	}
	return {
		status: 'error',
		files: [],
		message: `merge failed: ${(m.stderr || m.stdout).trim()}`,
	};
}

const SUCCESS: PropagateStatus[] = ['source', 'merged', 'up-to-date'];

/**
 * Propagate changes from `sourcePath` down through every descendant discovered
 * via the parent remote (default `stem`). Descendants are processed in BFS
 * order, each merging its parent's current LOCAL head, so an intermediate
 * merge cascades to the leaves in one pass. A failed node's descendants are
 * marked `skipped` (still visited/rendered) rather than merged against stale state.
 */
export async function propagate(
	opts: PropagateOptions,
): Promise<PropagateResult> {
	const branch = opts.branch ?? 'main';
	const remoteName = opts.remoteName ?? DEFAULT_REMOTE;
	const sourcePath = path.resolve(opts.sourcePath);
	const baseDir = path.resolve(opts.baseDir ?? path.dirname(sourcePath));

	let repos: Repo[];
	if (opts.repos && opts.repos.length > 0) {
		repos = opts.repos.map((p) => repoFromPath(path.resolve(p), remoteName));
	} else {
		repos = discoverRepos(baseDir, remoteName);
	}
	if (!repos.some((r) => samePath(r.path, sourcePath))) {
		repos.push(repoFromPath(sourcePath, remoteName));
	}

	const tree = buildTree(repos);
	const source = repos.find((r) => samePath(r.path, sourcePath))!;

	const root: PropagateResult = {
		repo: source,
		parent: null,
		status: 'source',
		files: [],
		message: 'source',
		children: [],
	};

	type Frame = {node: Repo; result: PropagateResult; ancestralFailure: boolean};
	const queue: Frame[] = [
		{node: source, result: root, ancestralFailure: false},
	];
	const visited = new Set<string>([source.path]);

	while (queue.length > 0) {
		const {node, result, ancestralFailure} = queue.shift()!;
		for (const child of childrenOf(node, tree)) {
			if (visited.has(child.path)) continue;
			visited.add(child.path);

			const childResult: PropagateResult = {
				repo: child,
				parent: node,
				status: 'up-to-date',
				files: [],
				message: '',
				children: [],
			};
			result.children.push(childResult);

			if (ancestralFailure) {
				childResult.status = 'skipped';
				childResult.message = `parent not updated (${result.status})`;
				queue.push({node: child, result: childResult, ancestralFailure: true});
				continue;
			}

			const parentLocal = child.originalUrl
				? (tree.byOrigin.get(normalizeUrl(child.originalUrl)) ?? null)
				: null;
			const fetchUrl = parentLocal ? parentLocal.path : child.originalUrl;
			if (!fetchUrl) {
				childResult.status = 'error';
				childResult.message = `no \`${remoteName}\` remote and no local parent found`;
				queue.push({node: child, result: childResult, ancestralFailure: true});
				continue;
			}

			const outcome = await mergeOne(
				child,
				fetchUrl,
				branch,
				!!opts.dryRun,
				!!opts.leaveConflicts,
			);
			childResult.status = outcome.status;
			childResult.files = outcome.files;
			childResult.message = outcome.message;

			queue.push({
				node: child,
				result: childResult,
				ancestralFailure: !SUCCESS.includes(outcome.status),
			});
		}
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
): FamilyTree[] {
	if (!fs.existsSync(baseDir)) return [];
	const repos: AncestryRepo[] = [];
	for (const entry of fs.readdirSync(baseDir, {withFileTypes: true})) {
		if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
		const p = path.join(baseDir, entry.name);
		if (!isGitRepo(p)) continue;
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
		const reg: Registry = {
			version: 1,
			remoteName,
			generatedAt,
			root: root.name,
			repos: regRepos,
		};
		const file = registryPath(root.name);
		fs.writeFileSync(file, JSON.stringify(reg, null, 2) + '\n', 'utf8');
		written.push(file);
	}
	return written;
}

/** Load a registry file into a plain `Repo[]` (stemUrl -> originalUrl). */
export function loadRegistry(
	file: string,
): {root: string; remoteName: string; repos: Repo[]} | null {
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
	return {root: reg.root, remoteName: reg.remoteName, repos};
}

// ──────────────────────────────────────────────────────────────────────────────
// Drift: descendant commits not yet in their parent (candidate backports)
// ──────────────────────────────────────────────────────────────────────────────

export interface DriftResult {
	repo: Repo;
	ahead: {sha: string; subject: string}[];
	error?: string;
}

/** For each repo with a `stem` parent, list commits it has that the parent lacks. */
export function driftTree(
	repos: Repo[],
	remoteName: string,
	branch: string,
): DriftResult[] {
	const tree = buildTree(repos);
	const results: DriftResult[] = [];
	for (const repo of repos) {
		if (!repo.originalUrl) continue; // root or unwired — nothing to compare
		const parentLocal =
			tree.byOrigin.get(normalizeUrl(repo.originalUrl)) ?? null;
		const fetchUrl = parentLocal ? parentLocal.path : repo.originalUrl;
		const r = commitsAhead(repo.path, fetchUrl, branch);
		if (r.ok) results.push({repo, ahead: r.commits});
		else results.push({repo, ahead: [], error: r.error});
	}
	return results;
}

// ──────────────────────────────────────────────────────────────────────────────
// Backport: cherry-pick a descendant commit onto an ancestor (the "home")
// ──────────────────────────────────────────────────────────────────────────────

export interface BackportResult {
	ancestorPath: string;
	ancestorName: string;
	status: 'backported' | 'conflict' | 'dry-run' | 'error';
	commit: string;
	subject: string | null;
	message: string;
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
}

export function backport(opts: BackportOptions): BackportResult {
	const branch = opts.branch ?? 'main';
	const remoteName = opts.remoteName ?? DEFAULT_REMOTE;
	const fromRepo = repoFromPath(opts.fromPath, remoteName);

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
				status: 'error',
				commit: opts.commit,
				subject: null,
				message: `no --to given and \`${remoteName}\` parent not resolvable for ${fromRepo.name}`,
			};
		}
		ancestorPath = parentLocal.path;
	}

	const ancestor = repoFromPath(ancestorPath, remoteName);

	// Bring the descendant's commit into the ancestor's object db, then describe it.
	const fetch = git(['fetch', opts.fromPath, branch], ancestorPath);
	if (!fetch.ok) {
		return {
			ancestorPath,
			ancestorName: ancestor.name,
			status: 'error',
			commit: opts.commit,
			subject: null,
			message: `fetch failed: ${(fetch.stderr || fetch.stdout).trim()}`,
		};
	}
	const subj = commitSubject(ancestorPath, opts.commit);

	if (opts.dryRun) {
		return {
			ancestorPath,
			ancestorName: ancestor.name,
			status: 'dry-run',
			commit: opts.commit,
			subject: subj,
			message: `would cherry-pick ${opts.commit} onto ${ancestor.name}`,
		};
	}

	if (!isClean(ancestorPath)) {
		return {
			ancestorPath,
			ancestorName: ancestor.name,
			status: 'error',
			commit: opts.commit,
			subject: subj,
			message: `${ancestor.name} working tree not clean`,
		};
	}

	const cp = cherryPick(ancestorPath, opts.commit);
	if (cp.ok) {
		return {
			ancestorPath,
			ancestorName: ancestor.name,
			status: 'backported',
			commit: opts.commit,
			subject: subj,
			message: `cherry-picked ${opts.commit} onto ${ancestor.name}`,
		};
	}
	const conflicts = conflictedFiles(ancestorPath);
	if (conflicts.length > 0) {
		if (opts.leaveConflicts) {
			return {
				ancestorPath,
				ancestorName: ancestor.name,
				status: 'conflict',
				commit: opts.commit,
				subject: subj,
				message: `conflict in ${conflicts.length} file(s) — left for manual resolution`,
			};
		}
		cherryPickAbort(ancestorPath);
		return {
			ancestorPath,
			ancestorName: ancestor.name,
			status: 'conflict',
			commit: opts.commit,
			subject: subj,
			message: `conflict in ${conflicts.length} file(s) — aborted`,
		};
	}
	return {
		ancestorPath,
		ancestorName: ancestor.name,
		status: 'error',
		commit: opts.commit,
		subject: subj,
		message: `cherry-pick failed: ${(cp.stderr || cp.stdout).trim()}`,
	};
}

// ──────────────────────────────────────────────────────────────────────────────
// Status: a consolidated triage of a wired hierarchy (wiring + downstream + upstream)
// ──────────────────────────────────────────────────────────────────────────────

export interface RootStatus {
	root: Repo;
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
	};
	/** Descendants that conflicted on the dry-run, with their conflicting files. */
	conflicts: {repo: Repo; files: string[]}[];
	/** Names of descendants blocked because an ancestor conflicted. */
	blocked: string[];
	/** Upstream drift: repos with commits ahead of their `stem` parent (candidate backports). */
	drift: DriftResult[];
}

/**
 * One-command triage over the wired tree(s) in `repos`: for each wired root,
 * run a `fanout --dry-run` (downstream: who merges, who conflicts, who is blocked)
 * and a `drift` (upstream: candidate backports). Read-only (fetches objects only).
 */
export async function statusTree(
	repos: Repo[],
	remoteName = DEFAULT_REMOTE,
	branch = 'main',
): Promise<RootStatus[]> {
	const tree = buildTree(repos);
	// A wired root has no `stem` parent inside the set and at least one descendant.
	const roots = repos.filter((r) => {
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
		});
		const counts = {
			merged: 0,
			upToDate: 0,
			conflict: 0,
			error: 0,
			skipped: 0,
			dirty: 0,
		};
		const conflicts: {repo: Repo; files: string[]}[] = [];
		const blocked: string[] = [];
		const subtreeRepos: Repo[] = [];
		const walk = (n: PropagateResult) => {
			subtreeRepos.push(n.repo);
			if (n.status === 'merged') counts.merged++;
			else if (n.status === 'up-to-date') counts.upToDate++;
			else if (n.status === 'conflict') {
				counts.conflict++;
				conflicts.push({repo: n.repo, files: n.files});
			} else if (n.status === 'error') counts.error++;
			else if (n.status === 'skipped') {
				counts.skipped++;
				blocked.push(n.repo.name);
			} else if (n.status === 'dirty') counts.dirty++;
			n.children.forEach(walk);
		};
		walk(downstream);
		const drift = driftTree(subtreeRepos, remoteName, branch).filter(
			(d) => d.ahead.length > 0 || d.error,
		);
		results.push({
			root,
			counts,
			conflicts,
			blocked,
			drift,
			repoCount: subtreeRepos.length,
		});
	}
	return results;
}
