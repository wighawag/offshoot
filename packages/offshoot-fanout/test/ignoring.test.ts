/**
 * The third observed failure: a phantom repo.
 *
 * `jolly-roger-work` is a linked worktree of `jolly-roger`. It has a `.git`, and
 * it inherits jolly-roger's `stem` remote, so discovery counted it as a repo and
 * every fanout run tried to merge into it and reported "refusing to merge
 * unrelated histories" — a permanent false alarm.
 *
 * Plus the deliberate exclusions: `--ignore` and the registry's `ignore` array.
 */

import {afterEach, describe, expect, it} from 'vitest';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {
	asLinkedWorktree,
	discoverAncestry,
	discoverLinkedWorktrees,
	discoverRepos,
	loadRegistry,
	propagate,
	saveRegistry,
	statusTree,
	formatReport,
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
	writeFile,
} from './helpers.js';

afterEach(cleanupTempDirs);

function url(name: string): string {
	return `https://github.com/test/${name}.git`;
}

function cloneChild(
	base: string,
	src: string,
	name: string,
	parentUrl: string,
): string {
	git(['clone', src, name], base);
	const dir = join(base, name);
	setRemote(dir, 'origin', url(name));
	setRemote(dir, 'stem', parentUrl);
	return dir;
}

describe('linked worktrees are never repos', () => {
	it('are detected as worktrees, with and without a `stem` remote', () => {
		const base = tempDir();
		const withStem = initRepo(base, 'withStem', {'f.txt': '1\n'});
		setRemote(withStem.dir, 'stem', url('somewhere'));
		git(
			['worktree', 'add', '-b', 'work', join(base, 'withStem-work')],
			withStem.dir,
		);

		const withoutStem = initRepo(base, 'plain', {'f.txt': '1\n'});
		git(
			['worktree', 'add', '-b', 'work', join(base, 'plain-work')],
			withoutStem.dir,
		);

		for (const [wt, main] of [
			['withStem-work', 'withStem'],
			['plain-work', 'plain'],
		] as const) {
			const found = asLinkedWorktree(join(base, wt));
			expect(found, wt).not.toBeNull();
			expect(found!.mainName).toBe(main);
		}
		// the repositories themselves are not worktrees of anything
		expect(asLinkedWorktree(withStem.dir)).toBeNull();
		expect(asLinkedWorktree(withoutStem.dir)).toBeNull();

		expect(
			discoverRepos(base, 'stem')
				.map((r) => r.name)
				.sort(),
		).toEqual(['plain', 'withStem']);
		expect(
			discoverLinkedWorktrees(base)
				.map((w) => w.name)
				.sort(),
		).toEqual(['plain-work', 'withStem-work']);
	});

	it('never becomes a node, and is mentioned once as a worktree of its repo', async () => {
		const base = tempDir();
		const a = initRepo(base, 'a', {'file.txt': 'v1\n'});
		setRemote(a.dir, 'origin', url('a'));
		const jr = cloneChild(base, a.dir, 'jolly-roger', url('a'));
		// the phantom: a linked worktree of jolly-roger, inheriting its `stem`
		git(['worktree', 'add', '-b', 'work', join(base, 'jolly-roger-work')], jr);

		writeFile(a.dir, 'file.txt', 'v2\n');
		commit(a.dir, 'change in a');

		const result = await propagate({sourcePath: a.dir, baseDir: base});
		const report = formatReport(result, {color: false});

		expect(result.children.map((c) => c.repo.name)).toEqual(['jolly-roger']);
		expect(report).not.toContain('unrelated histories');
		expect(report).toContain(
			'jolly-roger-work is a linked worktree of jolly-roger',
		);
		expect(fileOnBranch(jr, 'main', 'file.txt')).toBe('v2\n');
	});

	it('is excluded even when named explicitly (a stale registry entry)', async () => {
		const base = tempDir();
		const a = initRepo(base, 'a', {'file.txt': 'v1\n'});
		setRemote(a.dir, 'origin', url('a'));
		const jr = cloneChild(base, a.dir, 'jolly-roger', url('a'));
		const wt = join(base, 'jolly-roger-work');
		git(['worktree', 'add', '-b', 'work', wt], jr);

		writeFile(a.dir, 'file.txt', 'v2\n');
		commit(a.dir, 'change in a');

		const result = await propagate({
			sourcePath: a.dir,
			repos: [a.dir, jr, wt],
		});
		expect(result.children.map((c) => c.repo.name)).toEqual(['jolly-roger']);
		expect(result.notes.join('\n')).toContain('jolly-roger-work');
	});

	it('is mentioned in `status`, which works off an explicit repo list', async () => {
		const base = tempDir();
		const a = initRepo(base, 'a', {'file.txt': 'v1\n'});
		setRemote(a.dir, 'origin', url('a'));
		const jr = cloneChild(base, a.dir, 'jolly-roger', url('a'));
		git(['worktree', 'add', '-b', 'work', join(base, 'jolly-roger-work')], jr);

		const results = await statusTree(discoverRepos(base, 'stem'), 'stem');
		expect(results.length).toBe(1);
		expect(results[0]!.repoCount).toBe(2);
		expect(results[0]!.notes.join('\n')).toContain(
			'jolly-roger-work is a linked worktree of jolly-roger',
		);
	});

	it('is not proposed as a family member by discover', () => {
		const base = tempDir();
		const a = initRepo(base, 'a', {'file.txt': 'v1\n'});
		setRemote(a.dir, 'origin', url('a'));
		const b = cloneChild(base, a.dir, 'b', url('a'));
		git(['worktree', 'add', '-b', 'work', join(base, 'b-work')], b);

		const trees = discoverAncestry(base, 'stem');
		const names = trees.flatMap((t) => t.edges.map((e) => e.repo.name)).sort();
		expect(names).toEqual(['a', 'b']);
	});
});

describe('explicit ignore', () => {
	function treeWithDeprecated() {
		const base = tempDir();
		const a = initRepo(base, 'a', {'file.txt': 'v1\n'});
		setRemote(a.dir, 'origin', url('a'));
		const keep = cloneChild(base, a.dir, 'keep', url('a'));
		const deprecated = cloneChild(base, a.dir, 'deprecated', url('a'));
		writeFile(a.dir, 'file.txt', 'v2\n');
		commit(a.dir, 'change in a');
		return {base, a, keep, deprecated};
	}

	it('excludes a repo by name, and says so rather than hiding it', async () => {
		const {base, a, keep, deprecated} = treeWithDeprecated();
		const before = branchSha(deprecated, 'main');

		const result = await propagate({
			sourcePath: a.dir,
			baseDir: base,
			ignore: ['deprecated'],
		});
		const byName = new Map(result.children.map((c) => [c.repo.name, c]));
		expect(byName.get('keep')!.status).toBe('merged');
		expect(byName.get('deprecated')!.status).toBe('ignored');
		expect(byName.get('deprecated')!.message).toContain('deprecated');
		expect(formatReport(result, {color: false})).toContain(
			'deprecated@main ignored',
		);
		expect(branchSha(deprecated, 'main')).toBe(before);
		expect(fileOnBranch(keep, 'main', 'file.txt')).toBe('v2\n');
	});

	it('excludes a repo by path too', async () => {
		const {base, a, deprecated} = treeWithDeprecated();
		const result = await propagate({
			sourcePath: a.dir,
			baseDir: base,
			ignore: [deprecated],
		});
		const node = result.children.find((c) => c.repo.name === 'deprecated')!;
		expect(node.status).toBe('ignored');
	});

	it('is honored by status, from the registry\u2019s persisted list', async () => {
		const {base, a, deprecated} = treeWithDeprecated();
		const repos = discoverRepos(base, 'stem');
		const results = await statusTree(repos, 'stem', undefined, {
			ignore: ['deprecated'],
		});
		expect(results.length).toBe(1);
		expect(results[0]!.ignored).toEqual(['deprecated@main']);
		expect(results[0]!.counts.merged).toBe(1); // only `keep`
		expect(branchSha(deprecated, 'main')).toBeTruthy();
	});
});

describe('registry ignore', () => {
	it('round-trips, and `discover --save` preserves it rather than clobbering', () => {
		const home = tempDir();
		const origHome = process.env.HOME;
		process.env.HOME = home;
		try {
			const base = tempDir();
			const a = initRepo(base, 'a', {'file.txt': 'v1\n'});
			setRemote(a.dir, 'origin', url('a'));
			cloneChild(base, a.dir, 'b', url('a'));

			const repos = discoverRepos(base, 'stem');
			// first save: an ignore given on the command line is persisted
			const written = saveRegistry(repos, 'stem', undefined, ['deprecated']);
			expect(written.length).toBe(1);
			expect(loadRegistry(written[0]!)!.ignore).toEqual(['deprecated']);

			// a later re-scan, with no --ignore at all, must keep it
			saveRegistry(repos, 'stem');
			expect(loadRegistry(written[0]!)!.ignore).toEqual(['deprecated']);

			// and a new one is merged in, not substituted
			saveRegistry(repos, 'stem', undefined, ['another']);
			expect(loadRegistry(written[0]!)!.ignore).toEqual([
				'deprecated',
				'another',
			]);

			// a registry with no exclusions carries no `ignore` key at all
			const raw = JSON.parse(readFileSync(written[0]!, 'utf8')) as {
				ignore?: string[];
			};
			expect(raw.ignore).toEqual(['deprecated', 'another']);
		} finally {
			process.env.HOME = origHome;
		}
	});

	it('excludes the repo when a saved registry is used (the CLI path)', async () => {
		const home = tempDir();
		const origHome = process.env.HOME;
		process.env.HOME = home;
		try {
			const base = tempDir();
			const a = initRepo(base, 'a', {'file.txt': 'v1\n'});
			setRemote(a.dir, 'origin', url('a'));
			const keep = cloneChild(base, a.dir, 'keep', url('a'));
			const deprecated = cloneChild(base, a.dir, 'deprecated', url('a'));
			const written = saveRegistry(
				discoverRepos(base, 'stem'),
				'stem',
				undefined,
				['deprecated'],
			);

			writeFile(a.dir, 'file.txt', 'v2\n');
			commit(a.dir, 'change in a');

			// exactly what the CLI does with --registry: repo paths + persisted ignore
			const loaded = loadRegistry(written[0]!)!;
			const result = await propagate({
				sourcePath: a.dir,
				repos: loaded.repos.map((r) => r.path),
				ignore: loaded.ignore,
			});
			const byName = new Map(result.children.map((c) => [c.repo.name, c]));
			expect(byName.get('deprecated')!.status).toBe('ignored');
			expect(byName.get('keep')!.status).toBe('merged');
			expect(fileOnBranch(deprecated, 'main', 'file.txt')).toBe('v1\n');
			expect(fileOnBranch(keep, 'main', 'file.txt')).toBe('v2\n');
		} finally {
			process.env.HOME = origHome;
		}
	});

	it('omits the key entirely when there is nothing to ignore', () => {
		const home = tempDir();
		const origHome = process.env.HOME;
		process.env.HOME = home;
		try {
			const base = tempDir();
			const a = initRepo(base, 'a', {'file.txt': 'v1\n'});
			setRemote(a.dir, 'origin', url('a'));
			cloneChild(base, a.dir, 'b', url('a'));

			const written = saveRegistry(discoverRepos(base, 'stem'), 'stem');
			const raw = JSON.parse(readFileSync(written[0]!, 'utf8')) as {
				ignore?: string[];
			};
			expect('ignore' in raw).toBe(false);
			expect(loadRegistry(written[0]!)!.ignore).toEqual([]);
		} finally {
			process.env.HOME = origHome;
		}
	});
});
