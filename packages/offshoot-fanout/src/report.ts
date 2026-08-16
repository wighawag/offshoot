import type {
	DiscoveredEdge,
	FamilyTree,
	LinkResult,
	PropagateResult,
	PropagateStatus,
	RenameResult,
} from './core.js';

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const GRAY = '\x1b[90m';

interface Glyph {
	mark: string;
	color: string;
}

function glyph(status: PropagateStatus): Glyph {
	switch (status) {
		case 'ignored':
			return {mark: '–', color: GRAY};
		case 'source':
			return {mark: '◆', color: CYAN};
		case 'merged':
			return {mark: '✓', color: GREEN};
		case 'up-to-date':
			return {mark: '•', color: DIM};
		case 'conflict':
			return {mark: '✗', color: RED};
		case 'dirty':
			return {mark: '!', color: YELLOW};
		case 'error':
			return {mark: '!', color: RED};
		case 'skipped':
			return {mark: '⊘', color: GRAY};
	}
}

function label(status: PropagateStatus): string {
	switch (status) {
		case 'ignored':
			return 'ignored';
		case 'source':
			return 'source';
		case 'merged':
			return 'merged';
		case 'up-to-date':
			return 'up to date';
		case 'conflict':
			return 'CONFLICT';
		case 'dirty':
			return 'dirty tree';
		case 'error':
			return 'error';
		case 'skipped':
			return 'skipped';
	}
}

function stripAnsi(s: string): string {
	return s.replace(/\x1b\[[0-9;]*m/g, '');
}

/**
 * Render a propagation result as an indented, colorized tree. Every line names
 * the node as `repo@branch`: the destination branch is the thing that used to
 * be invisible, and an update landing on the wrong branch is exactly the
 * failure this reports away.
 */
export function formatReport(
	root: PropagateResult,
	{color = true} = {},
): string {
	const lines: string[] = [];

	const render = (
		node: PropagateResult,
		prefix: string,
		isLast: boolean,
		isRoot: boolean,
	) => {
		const branch = isRoot ? '' : isLast ? '└─ ' : '├─ ';
		const {mark, color: c} = glyph(node.status);
		const name = `${node.repo.name}${GRAY}@${node.branch}${RESET}`;

		// A node with several stems is a child of each of them, but the report is
		// indented text: render it in full under the first, and cross-link here.
		if (node.reference) {
			const stub = `${prefix}${branch}${GRAY}↳ ${node.repo.name}@${node.branch} (also merges from here; shown under ${node.reference})${RESET}`;
			lines.push(color ? stub : stripAnsi(stub));
			return;
		}

		let line = `${prefix}${branch}${c}${mark}${RESET} ${name} ${DIM}${label(node.status)}${RESET}`;
		if (!isRoot && node.message) {
			line += ` ${GRAY}— ${node.message}${RESET}`;
		}
		lines.push(color ? line : stripAnsi(line));

		const cont = isRoot ? '' : isLast ? '   ' : '│  ';
		for (const f of node.files) {
			lines.push(
				color ? `${prefix}${cont}${GRAY}${f}${RESET}` : `${prefix}${cont}${f}`,
			);
		}
		if (node.verify) {
			const vc = node.verify.status === 'passed' ? GREEN : RED;
			const vm = node.verify.status === 'passed' ? '✓' : '✗';
			const vline = `${prefix}${cont}${vc}${vm}${RESET} ${GRAY}${node.verify.message}${RESET}`;
			lines.push(color ? vline : stripAnsi(vline));
		}
		const children = node.children;
		children.forEach((child, i) =>
			render(child, prefix + cont, i === children.length - 1, false),
		);
	};

	render(root, '', true, true);

	for (const note of root.notes) {
		const line = `${GRAY}– ${note}${RESET}`;
		lines.push(color ? line : stripAnsi(line));
	}
	return lines.join('\n');
}

export interface Summary {
	merged: number;
	upToDate: number;
	conflicts: number;
	errors: number;
	skipped: number;
	dirty: number;
	ignored: number;
	/** Merged nodes whose opt-in `verify` command failed. */
	verifyFailed: number;
}

/** Count each status across the tree (excluding the source root). */
export function summarize(root: PropagateResult): Summary {
	const s: Summary = {
		merged: 0,
		upToDate: 0,
		conflicts: 0,
		errors: 0,
		skipped: 0,
		dirty: 0,
		ignored: 0,
		verifyFailed: 0,
	};
	const walk = (n: PropagateResult) => {
		if (n.reference) return; // a cross-link to a node counted where it is rendered
		if (n.status === 'merged') s.merged++;
		else if (n.status === 'up-to-date') s.upToDate++;
		else if (n.status === 'conflict') s.conflicts++;
		else if (n.status === 'error') s.errors++;
		else if (n.status === 'skipped') s.skipped++;
		else if (n.status === 'dirty') s.dirty++;
		else if (n.status === 'ignored') s.ignored++;
		if (n.verify?.status === 'failed') s.verifyFailed++;
		n.children.forEach(walk);
	};
	walk(root);
	return s;
}

/** Render discovered ancestry families as trees, marking each repo's `stem` wiring. */
export function formatAncestryReport(
	trees: FamilyTree[],
	{color = true} = {},
): string {
	const lines: string[] = [];
	let familyIndex = 0;
	for (const tree of trees) {
		familyIndex++;
		if (trees.length > 1) {
			lines.push(
				color
					? `${DIM}family ${familyIndex}${RESET} ${GRAY}(root: ${tree.root.name}, ${tree.edges.length} repo(s))${RESET}`
					: `family ${familyIndex} (root: ${tree.root.name}, ${tree.edges.length} repo(s))`,
			);
		}
		const byPath = new Map(tree.edges.map((e) => [e.repo.path, e] as const));
		const childrenOfPath = new Map<string | null, DiscoveredEdge[]>();
		for (const e of tree.edges) {
			const key = e.parent ? e.parent.path : null;
			const arr = childrenOfPath.get(key) ?? [];
			arr.push(e);
			childrenOfPath.set(key, arr);
		}
		const renderEdge = (
			edge: DiscoveredEdge,
			prefix: string,
			isLast: boolean,
			isRoot: boolean,
		) => {
			const branch = isRoot ? '' : isLast ? '└─ ' : '├─ ';
			const wired = edge.existingParentUrl !== null;
			const mark = wired ? GREEN + '✓' + RESET : YELLOW + '⚠' + RESET;
			let detail: string;
			if (isRoot) {
				detail = color
					? `${GRAY}(root — no parent)${RESET}`
					: '(root — no parent)';
			} else if (wired) {
				detail = color
					? `${GRAY}stem -> ${shortenUrl(edge.existingParentUrl!)}${RESET}`
					: `stem -> ${shortenUrl(edge.existingParentUrl!)}`;
			} else {
				const url = edge.parent?.originUrl ?? edge.parent?.path ?? null;
				detail =
					url === null
						? color
							? `${GRAY}no stem remote${RESET}`
							: 'no stem remote'
						: color
							? `${GRAY}no stem remote — would add: stem -> ${shortenUrl(url)}${RESET}`
							: `no stem remote — would add: stem -> ${shortenUrl(url)}`;
			}
			const name = isRoot
				? `${CYAN}◆${RESET} ${edge.repo.name}`
				: `${mark} ${edge.repo.name}`;
			lines.push(`${prefix}${branch}${name} ${detail}`);
			const cont = isRoot ? '' : isLast ? '   ' : '│  ';
			const kids = childrenOfPath.get(edge.repo.path) ?? [];
			kids.forEach((c, i) =>
				renderEdge(c, prefix + cont, i === kids.length - 1, false),
			);
		};
		const rootEdge = byPath.get(tree.root.path)!;
		renderEdge(rootEdge, '', true, true);
		if (trees.length > 1) lines.push('');
	}
	return color ? lines.join('\n') : stripAnsi(lines.join('\n'));
}

/** Render rename-remote results as a flat list. */
export function formatRenameResults(
	results: RenameResult[],
	{color = true} = {},
): string {
	const lines: string[] = [];
	for (const r of results) {
		const c =
			r.status === 'renamed'
				? GREEN
				: r.status === 'missing'
					? DIM
					: r.status === 'already'
						? DIM
						: RED;
		const mark =
			r.status === 'renamed'
				? '✓'
				: r.status === 'missing'
					? '•'
					: r.status === 'already'
						? '•'
						: '!';
		const line = `${c}${mark}${RESET} ${r.repo.name} — ${r.message}`;
		lines.push(color ? line : stripAnsi(line));
	}
	return lines.join('\n');
}

/** Render link results as a flat list. */
export function formatLinkResults(
	results: LinkResult[],
	{color = true} = {},
): string {
	const lines: string[] = [];
	for (const r of results) {
		const c = r.status === 'error' ? RED : GREEN;
		const mark = r.status === 'error' ? '!' : '✓';
		const line = `${c}${mark}${RESET} ${r.repo.name} — ${r.message}`;
		lines.push(color ? line : stripAnsi(line));
	}
	return lines.join('\n');
}

function shortenUrl(url: string): string {
	return url
		.replace(/^https?:\/\//, '')
		.replace(/^git@/, '')
		.replace(/\.git$/, '');
}

import type {DriftResult} from './core.js';

/** Render drift (per-repo commits ahead of its `stem` parent). */
export function formatDriftReport(
	results: DriftResult[],
	{color = true} = {},
): string {
	const lines: string[] = [];
	for (const r of results) {
		if (r.ahead.length === 0 && !r.error) continue; // skip clean repos from the report
		const name = `${r.repo.name}${GRAY}@${r.branch}${RESET}`;
		const head = r.error
			? `${RED}!${RESET} ${name} ${GRAY}— ${r.error}${RESET}`
			: `${r.ahead.length > 0 ? YELLOW : DIM}${r.ahead.length > 0 ? '▲' : '•'}${RESET} ${name} ${GRAY}(${r.ahead.length} ahead of ${r.stem})${RESET}`;
		lines.push(color ? head : stripAnsi(head));
		for (const c of r.ahead) {
			const line = `${GRAY}  ${c.sha.slice(0, 8)}  ${c.subject}${RESET}`;
			lines.push(color ? line : stripAnsi(line));
		}
	}
	if (lines.length === 0)
		return 'No drift: every repo is at or behind its `stem` parent.';
	return lines.join('\n');
}

import type {RootStatus} from './core.js';

/** Render a consolidated triage report (one section per wired root). */
export function formatStatusReport(
	results: RootStatus[],
	{color = true} = {},
): string {
	if (results.length === 0) {
		return 'No wired hierarchies found (no repo with a `stem` remote has descendants here). Run `discover` to find unwired repos.';
	}
	const lines: string[] = [];
	for (const r of results) {
		const head = `${CYAN}◆${RESET} ${r.root.name} ${GRAY}(root, ${r.nodeCount} node(s) across ${r.repoCount} repo(s))${RESET}`;
		lines.push(color ? head : stripAnsi(head));

		const c = r.counts;
		const ds = `  downstream: ${c.conflict} conflict, ${c.skipped} blocked, ${c.merged} merged, ${c.upToDate} up to date, ${c.error} error, ${c.dirty} dirty, ${c.ignored} ignored`;
		lines.push(color ? `${DIM}${ds}${RESET}` : ds);

		for (const cf of r.conflicts) {
			const line = `  ${RED}✗${RESET} ${cf.repo.name}${GRAY}@${cf.branch}${RESET} ${GRAY}CONFLICT (${cf.files.length} file(s))${RESET}`;
			lines.push(color ? line : stripAnsi(line));
			for (const f of cf.files) lines.push(`    ${GRAY}${f}${RESET}`);
		}
		if (r.blocked.length > 0) {
			const line = `  ${GRAY}⊘ blocked: ${r.blocked.join(', ')}${RESET}`;
			lines.push(color ? line : stripAnsi(line));
		}
		if (r.ignored.length > 0) {
			const line = `  ${GRAY}– ignored: ${r.ignored.join(', ')}${RESET}`;
			lines.push(color ? line : stripAnsi(line));
		}

		if (r.drift.length > 0) {
			const hdr = `  ${DIM}upstream (candidate backports):${RESET}`;
			lines.push(color ? hdr : stripAnsi(hdr));
			for (const d of r.drift) {
				const line = d.error
					? `    ${RED}!${RESET} ${d.repo.name}${GRAY}@${d.branch} — ${d.error}${RESET}`
					: `    ${YELLOW}▲${RESET} ${d.repo.name}${GRAY}@${d.branch} (${d.ahead.length} ahead of ${d.stem})${RESET}`;
				lines.push(color ? line : stripAnsi(line));
			}
		}
		for (const note of r.notes) {
			const line = `  ${GRAY}– ${note}${RESET}`;
			lines.push(color ? line : stripAnsi(line));
		}
		lines.push('');
	}
	return lines.join('\n').replace(/\n+$/, '\n');
}
