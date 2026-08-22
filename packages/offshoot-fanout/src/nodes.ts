/**
 * The unit of work is a `(repo, branch)` **node**, not a repo.
 *
 * Two kinds of edge feed a node:
 *   - cross-repo: the `stem` remote match (a child's `stem` URL normalizes to a
 *     parent's `origin` URL), from the parent's primary branch into each of the
 *     child's root branches. Needs a fetch.
 *   - in-repo: a branch whose stem is another branch in the SAME repo
 *     (`variant/full` derives from `main` exactly the way a child repo derives
 *     from its parent). No fetch.
 *
 * A repo with no config is one node: `main` if that branch exists, else the
 * current HEAD branch, which is exactly today's behaviour for repos that only
 * use `main`.
 */

import path from 'node:path';
import {
	resolveConfig,
	type ResolvedConfig,
	DEFAULT_CONFIG_BRANCH,
} from './config.js';
import {branchExists, currentBranch} from './git.js';
import {childrenOf, matchIgnore, type Repo, type Tree} from './repo.js';

export interface BranchNode {
	name: string;
	/**
	 * In-repo stem branches. Empty = a root branch, fed cross-repo. More than
	 * one = an integration node, merged only once every stem is done.
	 */
	stems: string[];
	/**
	 * For a root branch: which branch of the PARENT REPO feeds it. Null = the
	 * parent's primary, which is the default and the common case.
	 */
	stemBranch: string | null;
}

export interface RepoPlan {
	repo: Repo;
	/** Branches that participate, in declaration order. */
	branches: BranchNode[];
	/** The branch that feeds cross-repo children. */
	primary: string;
	config: ResolvedConfig;
	/** The opt-in verify command, when the config declares one. */
	verify: string | null;
	/** How the default node set was chosen, when there was no config to say. */
	note: string | null;
	/** Set when the plan is unusable: the repo's nodes must not be merged. */
	error: string | null;
	/** The ignore pattern that excluded this repo, when ignored. */
	ignored: string | null;
}

export interface PlanOptions {
	/** Config branch name. Default: `offshoot`. */
	configBranch?: string;
	/** Set false to ignore config branches entirely. Default: true. */
	useConfig?: boolean;
	/** Global `--branch` override: every repo becomes a single node at it. */
	branchOverride?: string;
	/** Maintainer-local ignore list (repo names or paths). */
	ignore?: string[];
}

export interface NodeRef {
	repo: Repo;
	branch: string;
}

export type EdgeKind = 'source' | 'cross-repo' | 'in-repo';

export interface ChildNode {
	node: NodeRef;
	edge: EdgeKind;
}

export function nodeKey(repo: Repo, branch: string): string {
	return `${path.resolve(repo.path)}#${branch}`;
}

export function nodeLabel(repo: Repo, branch: string): string {
	return `${repo.name}@${branch}`;
}

/** `main` when it exists, else the checked-out branch, and say which was chosen. */
function defaultBranch(repo: Repo): {
	branch: string | null;
	note: string | null;
} {
	if (branchExists(repo.path, 'main')) return {branch: 'main', note: null};
	const head = currentBranch(repo.path);
	if (head)
		return {
			branch: head,
			note: `no \`main\`; using the checked-out branch \`${head}\``,
		};
	return {branch: null, note: null};
}

function orderBranches(
	branches: Record<string, {stem?: string | string[]; stemBranch?: string}>,
): {
	nodes: BranchNode[];
	error: string | null;
} {
	const nodes: BranchNode[] = Object.entries(branches).map(([name, cfg]) => ({
		name,
		stems:
			cfg.stem === undefined
				? []
				: Array.isArray(cfg.stem)
					? [...cfg.stem]
					: [cfg.stem],
		stemBranch: cfg.stemBranch ?? null,
	}));
	const names = new Set(nodes.map((n) => n.name));
	for (const n of nodes) {
		for (const stem of n.stems) {
			if (!names.has(stem)) {
				return {
					nodes,
					error: `branch \`${n.name}\` has stem \`${stem}\`, which is not listed in \`branches\``,
				};
			}
			if (stem === n.name) {
				return {nodes, error: `branch \`${n.name}\` lists itself as its stem`};
			}
		}
	}
	// Cycle check over the whole in-repo DAG (Kahn): anything still holding an
	// unsatisfied stem after the sweep is part of a cycle, so it can never merge.
	const remaining = new Map(
		nodes.map((n) => [n.name, n.stems.length] as const),
	);
	const dependents = new Map<string, string[]>();
	for (const n of nodes) {
		for (const stem of n.stems) {
			dependents.set(stem, [...(dependents.get(stem) ?? []), n.name]);
		}
	}
	const ready = nodes.filter((n) => n.stems.length === 0).map((n) => n.name);
	while (ready.length > 0) {
		const name = ready.shift()!;
		remaining.delete(name);
		for (const dependent of dependents.get(name) ?? []) {
			const left = (remaining.get(dependent) ?? 0) - 1;
			remaining.set(dependent, left);
			if (left === 0) ready.push(dependent);
		}
	}
	if (remaining.size > 0) {
		return {
			nodes,
			error: `in-repo stem cycle through \`${[...remaining.keys()].sort().join('`, `')}\``,
		};
	}
	return {nodes, error: null};
}

/**
 * Resolve a repo's node set: its participating branches, their in-repo stems,
 * and the branch that feeds its cross-repo children.
 */
export function planRepo(repo: Repo, opts: PlanOptions = {}): RepoPlan {
	const ignored = matchIgnore(repo, opts.ignore);
	const config = resolveConfig(repo.path, {
		branch: opts.configBranch ?? DEFAULT_CONFIG_BRANCH,
		enabled: opts.useConfig !== false,
	});

	const base = {
		repo,
		config,
		verify: config.config?.verify ?? null,
		ignored,
	};

	const fallback = defaultBranch(repo);

	if (config.source === 'error') {
		return {
			...base,
			branches: [],
			primary: opts.branchOverride ?? fallback.branch ?? '(unknown)',
			note: null,
			error: config.error,
		};
	}

	// `--branch` is a global override: one node per repo, at that branch.
	if (opts.branchOverride) {
		return {
			...base,
			branches: [{name: opts.branchOverride, stems: [], stemBranch: null}],
			primary: opts.branchOverride,
			note: config.note,
			error: null,
		};
	}

	const declared = config.config?.branches;
	if (declared && Object.keys(declared).length > 0) {
		const {nodes, error} = orderBranches(declared);
		const roots = nodes.filter((n) => n.stems.length === 0);
		if (!error && roots.length === 0) {
			return {
				...base,
				branches: nodes,
				primary: nodes[0]?.name ?? '(unknown)',
				note: null,
				error: 'no root branch: every listed branch has a `stem`',
			};
		}
		const primary =
			roots.find((r) => r.name === 'main')?.name ??
			roots[0]?.name ??
			nodes[0]!.name;
		return {
			...base,
			branches: nodes,
			primary,
			note: config.note,
			error,
		};
	}

	if (!fallback.branch) {
		return {
			...base,
			branches: [],
			primary: '(unknown)',
			note: config.note,
			error:
				'cannot determine a branch: no `main` and HEAD is detached (use --branch)',
		};
	}

	return {
		...base,
		branches: [{name: fallback.branch, stems: [], stemBranch: null}],
		primary: fallback.branch,
		note: [config.note, fallback.note].filter(Boolean).join('; ') || null,
		error: null,
	};
}

/** Memoizing plan resolver: config reads are git calls, one per repo is enough. */
export function createPlanner(
	opts: PlanOptions = {},
): (repo: Repo) => RepoPlan {
	const cache = new Map<string, RepoPlan>();
	return (repo: Repo) => {
		const key = path.resolve(repo.path);
		const hit = cache.get(key);
		if (hit) return hit;
		const plan = planRepo(repo, opts);
		cache.set(key, plan);
		return plan;
	};
}

/** A branch a repo offers as the target of a cross-repo edge. */
export interface EntryBranch {
	/** The branch in the child repo that receives the merge. */
	branch: string;
	/**
	 * The branch of the PARENT repo it wants to be fed from, or null for the
	 * parent's primary.
	 */
	from: string | null;
}

/** The node(s) a repo contributes as the target of a cross-repo edge. */
export function entryBranches(plan: RepoPlan): EntryBranch[] {
	if (plan.error !== null || plan.branches.length === 0)
		return [{branch: plan.primary, from: null}];
	const roots = plan.branches.filter((b) => b.stems.length === 0);
	if (roots.length === 0) return [{branch: plan.primary, from: null}];
	return roots.map((b) => ({branch: b.name, from: b.stemBranch}));
}

/**
 * A child repo that names a parent branch which does not exist.
 *
 * Reported rather than quietly ignored: an unmatched `stemBranch` would drop
 * the child out of the graph entirely, and a node missing from a report is the
 * one failure mode nobody investigates, because there is nothing to see.
 */
export interface OrphanEntry {
	repo: Repo;
	branch: string;
	stemBranch: string;
	parent: Repo;
}

/**
 * Cross-repo children of `repo` whose declared `stemBranch` matches no branch
 * the parent actually participates with.
 */
export function orphanEntries(
	repo: Repo,
	tree: Tree,
	planner: (r: Repo) => RepoPlan,
): OrphanEntry[] {
	const plan = planner(repo);
	const known = new Set(
		plan.branches.length > 0 ? plan.branches.map((b) => b.name) : [plan.primary],
	);
	const out: OrphanEntry[] = [];
	for (const child of childrenOf(repo, tree)) {
		for (const entry of entryBranches(planner(child))) {
			if (entry.from !== null && !known.has(entry.from)) {
				out.push({
					repo: child,
					branch: entry.branch,
					stemBranch: entry.from,
					parent: repo,
				});
			}
		}
	}
	return out;
}

/**
 * Children of a node: its in-repo branch children always, plus the root
 * branches of every cross-repo child repo that names THIS branch as its source.
 *
 * A child's root branch is fed from the parent's primary by default, which is
 * the common case and what an unconfigured tree does. A child built on a
 * VARIANT of its parent says so with `stemBranch`, and is then fed from that
 * branch instead. So the cross-repo loop is not gated on the primary: any
 * participating branch can feed a child that asks for it.
 */
export function childNodes(
	node: NodeRef,
	tree: Tree,
	planner: (repo: Repo) => RepoPlan,
): ChildNode[] {
	const plan = planner(node.repo);
	const out: ChildNode[] = [];

	for (const b of plan.branches) {
		if (b.stems.includes(node.branch)) {
			out.push({node: {repo: node.repo, branch: b.name}, edge: 'in-repo'});
		}
	}

	for (const child of childrenOf(node.repo, tree)) {
		for (const entry of entryBranches(planner(child))) {
			if ((entry.from ?? plan.primary) === node.branch) {
				out.push({
					node: {repo: child, branch: entry.branch},
					edge: 'cross-repo',
				});
			}
		}
	}

	return out;
}
