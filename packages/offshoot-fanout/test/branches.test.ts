/**
 * The node is `(repo, branch)`, not `repo`.
 *
 * These cover two of the three failures observed on the live 8-repo tree:
 *   1. silent loss — the update landed on whatever branch the child happened to
 *      have checked out (`variant/full`), and the child's `main` never got it,
 *      while the report said `merged`;
 *   2. no in-repo topology — a repo holding sibling variants as branches could
 *      not express that `variant/full` derives from `main`.
 */

import {afterEach, describe, expect, it} from 'vitest';
import {existsSync} from 'node:fs';
import {propagate, formatReport} from '../src/index.js';
import {
	branchSha,
	cleanupTempDirs,
	commit,
	currentBranchOf,
	fileOnBranch,
	git,
	initRepo,
	readFile,
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

describe('merging into a branch that is not checked out', () => {
	it('lands on the target branch and leaves the checked-out branch untouched', async () => {
		const base = tempDir();
		const a = initRepo(base, 'a', {'file.txt': 'v1\n'});
		setRemote(a.dir, 'origin', url('a'));
		const b = cloneChild(base, a.dir, 'b', url('a'));

		// b works on `variant/full`, exactly like jolly-roger did
		git(['checkout', '-b', 'variant/full'], b);
		writeFile(b, 'variant.txt', 'variant-only\n');
		commit(b, 'variant work');
		const variantBefore = branchSha(b, 'variant/full');

		writeFile(a.dir, 'file.txt', 'v2\n');
		commit(a.dir, 'change in a');

		const result = await propagate({sourcePath: a.dir, baseDir: base});

		const node = result.children[0]!;
		expect(node.repo.name).toBe('b');
		// the destination branch is now reported, not guessed
		expect(node.branch).toBe('main');
		expect(node.status).toBe('merged');
		expect(formatReport(result, {color: false})).toContain('✓ b@main merged');

		// the change reached b's `main`…
		expect(fileOnBranch(b, 'main', 'file.txt')).toBe('v2\n');
		// …and `variant/full` (and the working tree) is exactly as it was
		expect(branchSha(b, 'variant/full')).toBe(variantBefore);
		expect(currentBranchOf(b)).toBe('variant/full');
		expect(readFile(b, 'file.txt')).toBe('v1\n');
		expect(readFile(b, 'variant.txt')).toBe('variant-only\n');
		// the temporary worktree is gone
		expect(worktreeCount(b)).toBe(1);
	});

	it('a dirty tree only blocks the branch that is actually checked out', async () => {
		const base = tempDir();
		const a = initRepo(base, 'a', {'file.txt': 'v1\n'});
		setRemote(a.dir, 'origin', url('a'));
		const b = cloneChild(base, a.dir, 'b', url('a'));

		git(['checkout', '-b', 'scratch'], b);
		writeFile(b, 'dirty.txt', 'uncommitted\n'); // dirty, but on `scratch`

		writeFile(a.dir, 'file.txt', 'v2\n');
		commit(a.dir, 'change in a');

		const result = await propagate({sourcePath: a.dir, baseDir: base});

		expect(result.children[0]!.status).toBe('merged');
		expect(fileOnBranch(b, 'main', 'file.txt')).toBe('v2\n');
		expect(readFile(b, 'dirty.txt')).toBe('uncommitted\n'); // untouched
	});

	it('reports a dirty tree in --dry-run too, never a would-merge a real run refuses', async () => {
		const base = tempDir();
		const a = initRepo(base, 'a', {'file.txt': 'v1\n'});
		setRemote(a.dir, 'origin', url('a'));
		const b = cloneChild(base, a.dir, 'b', url('a'));

		writeFile(b, 'scratch.txt', 'uncommitted\n'); // dirty ON main
		writeFile(a.dir, 'file.txt', 'v2\n');
		commit(a.dir, 'change in a');

		const dry = await propagate({
			sourcePath: a.dir,
			baseDir: base,
			dryRun: true,
		});
		const real = await propagate({sourcePath: a.dir, baseDir: base});

		// the dry-run must predict what the real run does, not contradict it
		expect(dry.children[0]!.status).toBe('dirty');
		expect(real.children[0]!.status).toBe('dirty');
		expect(fileOnBranch(b, 'main', 'file.txt')).toBe('v1\n');
	});

	it('still merges in place (and honors a dirty tree) when the target IS checked out', async () => {
		const base = tempDir();
		const a = initRepo(base, 'a', {'file.txt': 'v1\n'});
		setRemote(a.dir, 'origin', url('a'));
		const b = cloneChild(base, a.dir, 'b', url('a'));

		writeFile(b, 'scratch.txt', 'uncommitted\n'); // dirty ON main
		writeFile(a.dir, 'file.txt', 'v2\n');
		commit(a.dir, 'change in a');

		const result = await propagate({sourcePath: a.dir, baseDir: base});
		expect(result.children[0]!.status).toBe('dirty');
		expect(result.children[0]!.branch).toBe('main');
		expect(fileOnBranch(b, 'main', 'file.txt')).toBe('v1\n');
	});
});

describe('a conflict inside a temporary worktree', () => {
	it('is kept in place with --leave-conflicts, and its path is reported', async () => {
		const base = tempDir();
		const a = initRepo(base, 'a', {'file.txt': 'v1\n'});
		setRemote(a.dir, 'origin', url('a'));
		const b = cloneChild(base, a.dir, 'b', url('a'));

		// b's main diverges on the same line, then b checks out another branch
		writeFile(b, 'file.txt', 'b-change\n');
		commit(b, 'diverge in b');
		git(['checkout', '-b', 'elsewhere'], b);

		writeFile(a.dir, 'file.txt', 'v2\n');
		commit(a.dir, 'change in a');

		const result = await propagate({
			sourcePath: a.dir,
			baseDir: base,
			leaveConflicts: true,
		});

		const node = result.children[0]!;
		expect(node.status).toBe('conflict');
		expect(node.files).toContain('file.txt');
		expect(node.worktree).toBeTruthy();
		expect(node.message).toContain(node.worktree!);
		// the conflict is really there, resolvable by hand
		expect(existsSync(node.worktree!)).toBe(true);
		expect(worktreeCount(b)).toBe(2);
		expect(
			git(['diff', '--name-only', '--diff-filter=U'], node.worktree!).trim(),
		).toBe('file.txt');

		git(['worktree', 'remove', '--force', node.worktree!], b);
	});

	it('is predicted by --dry-run without creating a worktree at all', async () => {
		const base = tempDir();
		const a = initRepo(base, 'a', {'file.txt': 'v1\n'});
		setRemote(a.dir, 'origin', url('a'));
		const b = cloneChild(base, a.dir, 'b', url('a'));

		writeFile(b, 'file.txt', 'b-change\n');
		commit(b, 'diverge in b');
		const mainBefore = branchSha(b, 'main');
		git(['checkout', '-b', 'elsewhere'], b);

		writeFile(a.dir, 'file.txt', 'v2\n');
		commit(a.dir, 'change in a');

		// exercises the `git merge-tree` conflict path: names the conflicting files
		// with no index, no working tree and no worktree involved
		const result = await propagate({
			sourcePath: a.dir,
			baseDir: base,
			dryRun: true,
		});
		const node = result.children[0]!;
		expect(node.status).toBe('conflict');
		expect(node.files).toEqual(['file.txt']);
		expect(node.message).toContain('nothing changed');
		expect(worktreeCount(b)).toBe(1);
		expect(branchSha(b, 'main')).toBe(mainBefore);
		expect(currentBranchOf(b)).toBe('elsewhere');
	});

	it('is cleaned up when the conflict is aborted (no --leave-conflicts)', async () => {
		const base = tempDir();
		const a = initRepo(base, 'a', {'file.txt': 'v1\n'});
		setRemote(a.dir, 'origin', url('a'));
		const b = cloneChild(base, a.dir, 'b', url('a'));

		writeFile(b, 'file.txt', 'b-change\n');
		commit(b, 'diverge in b');
		const mainBefore = branchSha(b, 'main');
		git(['checkout', '-b', 'elsewhere'], b);

		writeFile(a.dir, 'file.txt', 'v2\n');
		commit(a.dir, 'change in a');

		const result = await propagate({sourcePath: a.dir, baseDir: base});
		expect(result.children[0]!.status).toBe('conflict');
		expect(result.children[0]!.worktree).toBeNull();
		expect(worktreeCount(b)).toBe(1);
		expect(branchSha(b, 'main')).toBe(mainBefore);
	});
});

describe('in-repo topology (branches as nodes of the same repo)', () => {
	/** jolly-roger: four sibling variants as branches, plus a scratch branch. */
	function jollyRoger(base: string, parentDir: string): string {
		const dir = cloneChild(base, parentDir, 'jolly-roger', url('parent'));
		for (const branch of ['variant/full', 'variant/offline', 'website', 'work'])
			git(['branch', branch], dir);
		git(['checkout', 'work'], dir); // the working branch, as on the live tree
		return dir;
	}

	it('cascades parent -> main -> variant/full in one pass, in that order', async () => {
		const base = tempDir();
		const parent = initRepo(base, 'parent', {'file.txt': 'v1\n'});
		setRemote(parent.dir, 'origin', url('parent'));
		const jr = jollyRoger(base, parent.dir);
		writeConfigBranch(
			jr,
			JSON.stringify({
				branches: {main: {}, 'variant/full': {stem: 'main'}},
			}),
		);

		const offlineBefore = branchSha(jr, 'variant/offline');
		const websiteBefore = branchSha(jr, 'website');
		const workBefore = branchSha(jr, 'work');

		writeFile(parent.dir, 'file.txt', 'v2\n');
		commit(parent.dir, 'change in parent');

		const result = await propagate({sourcePath: parent.dir, baseDir: base});

		// order is BFS over nodes: parent@main -> jolly-roger@main -> jolly-roger@variant/full
		expect(result.children.map((c) => `${c.repo.name}@${c.branch}`)).toEqual([
			'jolly-roger@main',
		]);
		const mainNode = result.children[0]!;
		expect(mainNode.status).toBe('merged');
		expect(mainNode.edge).toBe('cross-repo');
		expect(mainNode.children.map((c) => `${c.repo.name}@${c.branch}`)).toEqual([
			'jolly-roger@variant/full',
		]);
		const variantNode = mainNode.children[0]!;
		expect(variantNode.status).toBe('merged');
		expect(variantNode.edge).toBe('in-repo');

		// the change reached both listed branches…
		expect(fileOnBranch(jr, 'main', 'file.txt')).toBe('v2\n');
		expect(fileOnBranch(jr, 'variant/full', 'file.txt')).toBe('v2\n');
		// …and no unlisted branch was touched
		expect(branchSha(jr, 'variant/offline')).toBe(offlineBefore);
		expect(branchSha(jr, 'website')).toBe(websiteBefore);
		expect(branchSha(jr, 'work')).toBe(workBefore);
		expect(currentBranchOf(jr)).toBe('work');
		expect(worktreeCount(jr)).toBe(1);
	});

	it('marks in-repo descendants skipped when the branch above them conflicts', async () => {
		const base = tempDir();
		const parent = initRepo(base, 'parent', {'file.txt': 'v1\n'});
		setRemote(parent.dir, 'origin', url('parent'));
		const jr = jollyRoger(base, parent.dir);
		writeConfigBranch(
			jr,
			JSON.stringify({
				branches: {main: {}, 'variant/full': {stem: 'main'}},
			}),
		);

		// jolly-roger's main diverges on the line the parent is about to change
		git(['checkout', 'main'], jr);
		writeFile(jr, 'file.txt', 'jr-change\n');
		commit(jr, 'diverge on main');
		git(['checkout', 'work'], jr);

		writeFile(parent.dir, 'file.txt', 'v2\n');
		commit(parent.dir, 'change in parent');

		const result = await propagate({sourcePath: parent.dir, baseDir: base});
		const mainNode = result.children[0]!;
		expect(mainNode.status).toBe('conflict');
		const variantNode = mainNode.children[0]!;
		expect(variantNode.branch).toBe('variant/full');
		expect(variantNode.status).toBe('skipped');
		expect(formatReport(result, {color: false})).toContain(
			'⊘ jolly-roger@variant/full skipped',
		);
	});

	it('--branch is a global override: one node per repo, config branches ignored', async () => {
		const base = tempDir();
		const parent = initRepo(base, 'parent', {'file.txt': 'v1\n'});
		setRemote(parent.dir, 'origin', url('parent'));
		const jr = jollyRoger(base, parent.dir);
		writeConfigBranch(
			jr,
			JSON.stringify({branches: {main: {}, 'variant/full': {stem: 'main'}}}),
		);
		const variantBefore = branchSha(jr, 'variant/full');

		writeFile(parent.dir, 'file.txt', 'v2\n');
		commit(parent.dir, 'change in parent');

		const result = await propagate({
			sourcePath: parent.dir,
			baseDir: base,
			branch: 'main',
		});
		expect(result.children.map((c) => `${c.repo.name}@${c.branch}`)).toEqual([
			'jolly-roger@main',
		]);
		expect(result.children[0]!.children).toEqual([]);
		expect(branchSha(jr, 'variant/full')).toBe(variantBefore);
	});
});

describe('default node set without config', () => {
	it('uses the checked-out branch when there is no `main`, and says so', async () => {
		const base = tempDir();
		const a = initRepo(base, 'a', {'file.txt': 'v1\n'});
		setRemote(a.dir, 'origin', url('a'));
		const b = cloneChild(base, a.dir, 'b', url('a'));
		git(['branch', '-m', 'main', 'master'], b);

		writeFile(a.dir, 'file.txt', 'v2\n');
		commit(a.dir, 'change in a');

		const result = await propagate({sourcePath: a.dir, baseDir: base});
		const node = result.children[0]!;
		expect(node.branch).toBe('master');
		expect(node.status).toBe('merged');
		expect(node.message).toContain('no `main`');
		expect(readFile(b, 'file.txt')).toBe('v2\n');
	});
});
