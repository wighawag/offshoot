import {describe, it, expect} from 'vitest';
import {formatReport, summarize, type PropagateResult} from '../src/index.js';

function r(
	name: string,
	status: PropagateResult['status'],
	files: string[] = [],
	message = '',
	children: PropagateResult[] = [],
	branch = 'main',
): PropagateResult {
	return {
		repo: {name, path: `/${name}`, originUrl: null, originalUrl: null},
		branch,
		edge: status === 'source' ? 'source' : 'cross-repo',
		parent: null,
		status,
		files,
		message,
		worktree: null,
		verify: null,
		children,
		notes: [],
	};
}

// Realistic propagate output:
//   a (source)
//   ├─ b ✓ merged (2 files)         ── d • up to date   (b succeeded, so d merges)
//   └─ c ✗ conflict (1 file)       ── e ⊘ skipped      (c failed, so e is skipped)
const tree: PropagateResult = r('a', 'source', [], 'source', [
	r(
		'b',
		'merged',
		['web/src/app.html', 'web/package.json'],
		'merged 2 file(s)',
		[r('d', 'up-to-date', [], 'already up to date')],
	),
	r('c', 'conflict', ['web/package.json'], 'conflict in 1 file(s) — aborted', [
		r('e', 'skipped', [], 'parent not updated (conflict)'),
	]),
]);

describe('formatReport', () => {
	it('renders the tree with glyphs, labels, files and messages (no color)', () => {
		const out = formatReport(tree, {color: false});
		const lines = out.split('\n');

		// every line names the DESTINATION branch, not just the repo
		expect(lines[0]).toContain('◆ a@main source');
		expect(lines[1]).toContain('├─');
		expect(lines[1]).toContain('✓ b@main merged');
		expect(lines[1]).toContain('merged 2 file(s)');
		expect(lines[2]).toContain('web/src/app.html');
		expect(lines[3]).toContain('web/package.json');
		// d sits under b (b is not the last child of a), merged-then-up-to-date
		const dLine = lines.find((l) => l.includes('• d@main up to date'));
		expect(dLine).toBeDefined();
		expect(dLine).toContain('already up to date');
		// c is the last child of a
		const cLine = lines.find((l) => l.includes('✗ c@main CONFLICT'));
		expect(cLine).toBeDefined();
		expect(cLine).toContain('conflict in 1 file(s) — aborted');
		expect(cLine).toContain('└─');
		// e is skipped under the conflicted c
		const eLine = lines.find((l) => l.includes('⊘ e@main skipped'));
		expect(eLine).toBeDefined();
		expect(eLine).toContain('parent not updated (conflict)');
		// the conflict file is listed under c
		const cIndex = lines.findIndex((l) => l.includes('✗ c@main CONFLICT'));
		expect(
			lines.slice(cIndex + 1).some((l) => l.includes('web/package.json')),
		).toBe(true);
	});

	it('colorizes by default (contains ANSI escapes)', () => {
		expect(formatReport(tree)).toContain('\x1b[');
	});
});

describe('summarize', () => {
	it('counts statuses excluding the source root', () => {
		expect(summarize(tree)).toEqual({
			merged: 1, // b
			upToDate: 1, // d
			conflicts: 1, // c
			errors: 0,
			skipped: 1, // e
			dirty: 0,
			ignored: 0,
			verifyFailed: 0,
		});
	});
});
