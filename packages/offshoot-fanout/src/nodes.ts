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
	/** In-repo stem branch, or null for a root branch (fed cross-repo). */
	stem: string | null;
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

function orderBranches(branches: Record<string, {stem?: string}>): {
	nodes: BranchNode[];
	error: string | null;
} {
	const nodes: BranchNode[] = Object.entries(branches).map(([name, cfg]) => ({
		name,
		stem: cfg.stem ?? null,
	}));
	const names = new Set(nodes.map((n) => n.name));
	for (const n of nodes) {
		if (n.stem !== null && !names.has(n.stem)) {
			return {
				nodes,
				error: `branch \`${n.name}\` has stem \`${n.stem}\`, which is not listed in \`branches\``,
			};
		}
		if (n.stem === n.name) {
			return {nodes, error: `branch \`${n.name}\` lists itself as its stem`};
		}
	}
	// Cycle check: every branch must reach a root by following stems.
	const byName = new Map(nodes.map((n) => [n.name, n] as const));
	for (const n of nodes) {
		const seen = new Set<string>([n.name]);
		let cur = n.stem;
		while (cur !== null) {
			if (seen.has(cur)) {
				return {nodes, error: `in-repo stem cycle through \`${cur}\``};
			}
			seen.add(cur);
			cur = byName.get(cur)?.stem ?? null;
		}
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
			branches: [{name: opts.branchOverride, stem: null}],
			primary: opts.branchOverride,
			note: config.note,
			error: null,
		};
	}

	const declared = config.config?.branches;
	if (declared && Object.keys(declared).length > 0) {
		const {nodes, error} = orderBranches(declared);
		const roots = nodes.filter((n) => n.stem === null);
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
		branches: [{name: fallback.branch, stem: null}],
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

/** The node(s) a repo contributes as the target of a cross-repo edge. */
export function entryBranches(plan: RepoPlan): string[] {
	if (plan.error !== null || plan.branches.length === 0) return [plan.primary];
	const roots = plan.branches.filter((b) => b.stem === null);
	return roots.length > 0 ? roots.map((b) => b.name) : [plan.primary];
}

/**
 * Children of a node: its in-repo branch children always, plus (only from the
 * repo's primary branch) the root branches of every cross-repo child repo.
 */
export function childNodes(
	node: NodeRef,
	tree: Tree,
	planner: (repo: Repo) => RepoPlan,
): ChildNode[] {
	const plan = planner(node.repo);
	const out: ChildNode[] = [];

	for (const b of plan.branches) {
		if (b.stem === node.branch) {
			out.push({node: {repo: node.repo, branch: b.name}, edge: 'in-repo'});
		}
	}

	if (node.branch === plan.primary) {
		for (const child of childrenOf(node.repo, tree)) {
			const childPlan = planner(child);
			for (const branch of entryBranches(childPlan)) {
				out.push({node: {repo: child, branch}, edge: 'cross-repo'});
			}
		}
	}

	return out;
}
