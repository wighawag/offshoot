import {afterEach, describe, expect, it} from 'vitest';
import {propagate, formatReport} from '../src/index.js';
import {
	cleanupTempDirs,
	commit,
	git,
	initRepo,
	readFile,
	setRemote,
	tempDir,
	writeFile,
} from './helpers.js';

afterEach(cleanupTempDirs);

/** A stable, fake GitHub-style URL per repo name so a child's `stem` matches the parent's `origin`. */
function url(name: string): string {
	return `https://github.com/test/${name}.git`;
}

/** Clone `src` into `parent/name` and wire up `origin` + `stem` (parent) remotes. */
function cloneChild(
	parent: string,
	src: string,
	name: string,
	parentUrl: string,
): string {
	git(['clone', src, name], parent);
	const dir = `${parent}/${name}`;
	setRemote(dir, 'origin', url(name));
	setRemote(dir, 'stem', parentUrl);
	return dir;
}

describe('propagate (integration with real git repos)', () => {
	it('cascades a change from the root down through shared history', async () => {
		const base = tempDir();
		const a = initRepo(base, 'a', {'file.txt': 'v1\n'});
		setRemote(a.dir, 'origin', url('a'));

		const bDir = cloneChild(base, a.dir, 'b', url('a'));
		const cDir = cloneChild(base, bDir, 'c', url('b'));

		// change at the root
		writeFile(a.dir, 'file.txt', 'v2\n');
		commit(a.dir, 'change in a');

		const result = await propagate({sourcePath: a.dir, baseDir: base});

		// b merged, and c merged via the cascaded (now-updated) b
		expect(result.children.map((c) => c.repo.name)).toEqual(['b']);
		expect(result.children[0]!.status).toBe('merged');
		expect(result.children[0]!.children.map((c) => c.repo.name)).toEqual(['c']);
		expect(result.children[0]!.children[0]!.status).toBe('merged');

		// the change actually reached the leaf
		expect(readFile(cDir, 'file.txt')).toBe('v2\n');
	});

	it('marks descendants `skipped` when an intermediate conflicts (the regression case)', async () => {
		const base = tempDir();
		const a = initRepo(base, 'a', {'file.txt': 'v1\n'});
		setRemote(a.dir, 'origin', url('a'));

		const bDir = cloneChild(base, a.dir, 'b', url('a'));
		const cDir = cloneChild(base, bDir, 'c', url('b'));

		// b diverges on the same line that a is about to change -> conflict
		writeFile(bDir, 'file.txt', 'b-change\n');
		commit(bDir, 'diverge in b');
		// a changes the same line
		writeFile(a.dir, 'file.txt', 'v2\n');
		commit(a.dir, 'change in a');

		const result = await propagate({sourcePath: a.dir, baseDir: base});
		const report = formatReport(result, {color: false});

		const b = result.children[0]!;
		expect(b.repo.name).toBe('b');
		expect(b.status).toBe('conflict');
		expect(b.files).toContain('file.txt');

		// c must appear (this is the bug: it used to be silently dropped) and be skipped
		expect(b.children.map((c) => c.repo.name)).toEqual(['c']);
		const c = b.children[0]!;
		expect(c.status).toBe('skipped');
		expect(c.message).toContain('conflict');
		expect(report).toContain('⊘ c@main skipped');

		// the conflict was aborted, so b and c are untouched
		expect(readFile(bDir, 'file.txt')).toBe('b-change\n');
		expect(readFile(cDir, 'file.txt')).toBe('v1\n');
	});

	it('--dry-run reports would-merge without changing any branch', async () => {
		const base = tempDir();
		const a = initRepo(base, 'a', {'file.txt': 'v1\n'});
		setRemote(a.dir, 'origin', url('a'));
		const bDir = cloneChild(base, a.dir, 'b', url('a'));

		const bHeadBefore = git(['rev-parse', 'HEAD'], bDir).trim();
		writeFile(a.dir, 'file.txt', 'v2\n');
		commit(a.dir, 'change in a');

		const result = await propagate({
			sourcePath: a.dir,
			baseDir: base,
			dryRun: true,
		});

		expect(result.children[0]!.status).toBe('merged');
		expect(result.children[0]!.message).toContain('dry-run');
		// dry-run must not have moved b's HEAD
		expect(git(['rev-parse', 'HEAD'], bDir).trim()).toBe(bHeadBefore);
		expect(readFile(bDir, 'file.txt')).toBe('v1\n');
	});
});
