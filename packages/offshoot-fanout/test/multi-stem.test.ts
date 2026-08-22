/**
 * A node with several stems: an integration branch (`extended/complete`) that
 * combines independent extensions of `main`, rather than chaining them, which
 * would make each extension inherit the previous one.
 *
 * The node graph stops being a tree here, so the two things worth proving are
 * ORDER (an integration node waits for every stem, and is never merged against
 * one stem's stale state) and HONESTY (it is reported once, counted once, and a
 * partial merge says what landed and what blocked).
 */

import {afterEach, describe, expect, it} from 'vitest';
import {join} from 'node:path';
import {
	formatReport,
	propagate,
	planRepo,
	summarize,
	driftTree,
	discoverRepos,
	resolveConfig,
} from '../src/index.js';
import {
	branchSha,
	cleanupTempDirs,
	commit,
	fileOnBranch,
	git,
	initRepo,
	setRemote,
	tempDir,
	worktreeCount,
	writeConfigBranch,
	writeFile,
} from './helpers.js';

afterEach(cleanupTempDirs);

function url(name: string): string {
	return `https://github.com/test/${name}.git`;
}

const DIAMOND = JSON.stringify({
	branches: {
		main: {},
		'extended/a': {stem: 'main'},
		'extended/b': {stem: 'main'},
		'extended/complete': {stem: ['extended/a', 'extended/b']},
	},
});

/**
 * parent ─→ child@main ─┬─→ extended/a ─┐
 *                       └─→ extended/b ─┴─→ extended/complete
 * Each extension owns one file, so combining them is a clean merge and any
 * cross-contamination is visible as a file that should not be there.
 */
function diamond(config = DIAMOND) {
	const base = tempDir();
	const parent = initRepo(base, 'parent', {'file.txt': 'v1\n'});
	setRemote(parent.dir, 'origin', url('parent'));

	git(['clone', parent.dir, 'child'], base);
	const child = join(base, 'child');
	setRemote(child, 'origin', url('child'));
	setRemote(child, 'stem', url('parent'));

	git(['checkout', '-q', '-b', 'extended/a'], child);
	writeFile(child, 'a.txt', 'a\n');
	commit(child, 'extension a');

	git(['checkout', '-q', 'main'], child);
	git(['checkout', '-q', '-b', 'extended/b'], child);
	writeFile(child, 'b.txt', 'b\n');
	commit(child, 'extension b');

	git(['checkout', '-q', '-b', 'extended/complete', 'main'], child);
	git(['checkout', '-q', 'main'], child);

	writeConfigBranch(child, config);
	return {base, parent, child};
}

describe('an integration node with several stems', () => {
	it('merges every stem, and only after all of them are done', async () => {
		const {base, parent, child} = diamond();

		writeFile(parent.dir, 'file.txt', 'v2\n');
		commit(parent.dir, 'change in parent');

		const result = await propagate({sourcePath: parent.dir, baseDir: base});
		const report = formatReport(result, {color: false});

		const main = result.children[0]!;
		expect(`${main.repo.name}@${main.branch}`).toBe('child@main');
		expect(main.status).toBe('merged');

		// `complete` is rendered in full under its FIRST stem, cross-linked under
		// the other, so it appears once as a node and once as a reference
		const a = main.children.find((c) => c.branch === 'extended/a')!;
		const b = main.children.find((c) => c.branch === 'extended/b')!;
		expect(a.status).toBe('merged');
		expect(b.status).toBe('merged');

		const complete = a.children.find((c) => c.branch === 'extended/complete')!;
		expect(complete.status).toBe('merged');
		expect(complete.edge).toBe('in-repo');
		expect(complete.parents.map((p) => p.branch).sort()).toEqual([
			'extended/a',
			'extended/b',
		]);
		expect(complete.reference).toBeNull();

		// the stub points at the stem the node is rendered under, in declared order
		const stub = b.children.find((c) => c.branch === 'extended/complete')!;
		expect(stub.reference).toBe('child@extended/a');
		expect(report).toContain(
			'↳ child@extended/complete (also merges from here; shown under child@extended/a)',
		);

		// counted once, not twice
		expect(summarize(result).merged).toBe(4); // main, a, b, complete

		// the integration branch really has all three inputs
		expect(fileOnBranch(child, 'extended/complete', 'file.txt')).toBe('v2\n');
		expect(fileOnBranch(child, 'extended/complete', 'a.txt')).toBe('a\n');
		expect(fileOnBranch(child, 'extended/complete', 'b.txt')).toBe('b\n');
		// and the extensions stayed independent of each other
		expect(() => fileOnBranch(child, 'extended/a', 'b.txt')).toThrow();
		expect(() => fileOnBranch(child, 'extended/b', 'a.txt')).toThrow();
		expect(worktreeCount(child)).toBe(1);
	});

	it('is merged after BOTH stems even when one is reached much later', async () => {
		// `extended/b` is itself downstream of `extended/a`, so a naive BFS would
		// reach `complete` through `a` first and merge it against a stale `b`.
		const {base, parent, child} = diamond(
			JSON.stringify({
				branches: {
					main: {},
					'extended/a': {stem: 'main'},
					'extended/b': {stem: 'extended/a'},
					'extended/complete': {stem: ['extended/a', 'extended/b']},
				},
			}),
		);

		writeFile(parent.dir, 'file.txt', 'v2\n');
		commit(parent.dir, 'change in parent');

		const result = await propagate({sourcePath: parent.dir, baseDir: base});
		const main = result.children[0]!;
		const a = main.children.find((c) => c.branch === 'extended/a')!;
		const b = a.children.find((c) => c.branch === 'extended/b')!;
		expect(b.status).toBe('merged');

		// complete hangs off `a` (its first stem) but ran after `b` finished:
		// it carries b's file, which is only reachable through the longer path
		const complete = a.children.find((c) => c.branch === 'extended/complete')!;
		expect(complete.status).toBe('merged');
		expect(fileOnBranch(child, 'extended/complete', 'b.txt')).toBe('b\n');
		expect(fileOnBranch(child, 'extended/complete', 'file.txt')).toBe('v2\n');
	});

	it('is skipped when ANY stem fails, and keeps what already landed', async () => {
		const {base, parent, child} = diamond();

		// extended/b diverges on the line the parent is about to change
		git(['checkout', '-q', 'extended/b'], child);
		writeFile(child, 'file.txt', 'b-change\n');
		commit(child, 'diverge on b');
		git(['checkout', '-q', 'main'], child);
		const completeBefore = branchSha(child, 'extended/complete');

		writeFile(parent.dir, 'file.txt', 'v2\n');
		commit(parent.dir, 'change in parent');

		const result = await propagate({sourcePath: parent.dir, baseDir: base});
		const main = result.children[0]!;
		const a = main.children.find((c) => c.branch === 'extended/a')!;
		const b = main.children.find((c) => c.branch === 'extended/b')!;
		expect(a.status).toBe('merged');
		expect(b.status).toBe('conflict');

		const complete = a.children.find((c) => c.branch === 'extended/complete')!;
		expect(complete.status).toBe('skipped');
		expect(complete.message).toContain('parent not updated (conflict)');
		// nothing was merged into it: not even the stem that succeeded
		expect(branchSha(child, 'extended/complete')).toBe(completeBefore);
	});

	it('reports which stem conflicted, and that the earlier one already merged', async () => {
		const {base, parent, child} = diamond();

		// make the two extensions touch the same line, so a+b conflicts at `complete`
		git(['checkout', '-q', 'extended/a'], child);
		writeFile(child, 'shared.txt', 'from-a\n');
		commit(child, 'a claims shared.txt');
		git(['checkout', '-q', 'extended/b'], child);
		writeFile(child, 'shared.txt', 'from-b\n');
		commit(child, 'b claims shared.txt');
		git(['checkout', '-q', 'main'], child);

		const result = await propagate({sourcePath: parent.dir, baseDir: base});
		const main = result.children[0]!;
		const a = main.children.find((c) => c.branch === 'extended/a')!;
		const complete = a.children.find((c) => c.branch === 'extended/complete')!;

		expect(complete.status).toBe('conflict');
		expect(complete.files).toContain('shared.txt');
		expect(complete.message).toContain('merging extended/b');
		expect(complete.message).toContain('extended/a already merged');
		// decision: the first merge is kept, so re-running continues from there
		expect(fileOnBranch(child, 'extended/complete', 'a.txt')).toBe('a\n');
		// the conflicted merge itself was aborted, so nothing half-resolved is committed
		expect(() => fileOnBranch(child, 'extended/complete', 'b.txt')).toThrow();
		expect(worktreeCount(child)).toBe(1);
	});

	it('predicts the whole thing in --dry-run, flagging the approximation', async () => {
		const {base, parent, child} = diamond();
		const completeBefore = branchSha(child, 'extended/complete');

		writeFile(parent.dir, 'file.txt', 'v2\n');
		commit(parent.dir, 'change in parent');

		const result = await propagate({
			sourcePath: parent.dir,
			baseDir: base,
			dryRun: true,
		});
		const main = result.children[0]!;
		const a = main.children.find((c) => c.branch === 'extended/a')!;
		const complete = a.children.find((c) => c.branch === 'extended/complete')!;

		expect(complete.status).toBe('merged');
		expect(complete.files.sort()).toEqual(['a.txt', 'b.txt']);
		expect(complete.message).toContain('extended/a and extended/b');
		expect(complete.message).toContain(
			'stems after the first predicted against the current branch',
		);
		expect(branchSha(child, 'extended/complete')).toBe(completeBefore);
		expect(worktreeCount(child)).toBe(1);
	});

	it('is not reported as drifting from the stems it just merged', async () => {
		const {base, child} = diamond();
		await propagate({sourcePath: join(base, 'parent'), baseDir: base});

		const drift = driftTree(discoverRepos(base, 'stem'), 'stem').filter(
			(d) => d.repo.name === 'child',
		);
		const complete = drift.find((d) => d.branch === 'extended/complete')!;
		expect(complete.stem).toBe('extended/a + extended/b');
		// every commit it has comes from one stem or the other, plus its own merges
		expect(
			complete.ahead.every((c) => /^Merge |offshoot-fanout/.test(c.subject)),
		).toBe(true);
		expect(fileOnBranch(child, 'extended/complete', 'b.txt')).toBe('b\n');
	});
});

describe('multi-stem config', () => {
	it('accepts a string or an array, and rejects nonsense', () => {
		const base = tempDir();
		const repo = initRepo(base, 'r', {'f.txt': '1\n'});

		writeConfigBranch(repo.dir, DIAMOND);
		const plan = planRepo({
			name: 'r',
			path: repo.dir,
			originUrl: null,
			originalUrl: null,
		});
		expect(plan.error).toBeNull();
		expect(plan.branches).toEqual([
			{name: 'main', stems: [], stemBranch: null},
			{name: 'extended/a', stems: ['main'], stemBranch: null},
			{name: 'extended/b', stems: ['main'], stemBranch: null},
			{
				name: 'extended/complete',
				stems: ['extended/a', 'extended/b'],
				stemBranch: null,
			},
		]);

		for (const [bad, expected] of [
			[JSON.stringify({branches: {main: {}, x: {stem: []}}}), 'empty array'],
			[
				JSON.stringify({branches: {main: {}, x: {stem: ['main', 'main']}}}),
				'same branch twice',
			],
			[
				JSON.stringify({branches: {main: {}, x: {stem: ['main', 3]}}}),
				'must be a string or an array of strings',
			],
		] as const) {
			writeConfigBranch(repo.dir, bad);
			const r = resolveConfig(repo.dir);
			expect(r.source, bad).toBe('error');
			expect(r.error).toContain(expected);
		}
	});

	it('rejects a stem cycle that a single-stem walk would miss', () => {
		const base = tempDir();
		const repo = initRepo(base, 'r', {'f.txt': '1\n'});
		writeConfigBranch(
			repo.dir,
			JSON.stringify({
				branches: {
					main: {},
					x: {stem: ['main', 'z']},
					y: {stem: 'x'},
					z: {stem: 'y'},
				},
			}),
		);

		const plan = planRepo({
			name: 'r',
			path: repo.dir,
			originUrl: null,
			originalUrl: null,
		});
		expect(plan.error).toContain('stem cycle');
		expect(plan.error).toContain('`x`, `y`, `z`');
	});
});
