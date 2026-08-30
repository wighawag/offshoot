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
	formatStatusReport,
	summarize,
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

/**
 * An exclusion is a property of the node itself; being blocked is a property of
 * what happened above it. The two used to be tested in the wrong order, so an
 * ignored repo under a conflicting ancestor printed `skipped — parent not
 * updated (conflict)`: word for word what a repo that IS in the cascade prints
 * while it waits for the conflict to be fixed. That is the one moment the
 * exclusion has to be legible, because a maintainer reading `skipped` concludes
 * the protection is off and either works around it with `--repos` or trusts a
 * re-run after fixing the parent.
 */
describe('an exclusion outranks a block', () => {
	/** a -> b -> hand-port, with hand-port deliberately excluded. */
	function chain() {
		const base = tempDir();
		const a = initRepo(base, 'a', {'file.txt': 'v1\n'});
		setRemote(a.dir, 'origin', url('a'));
		const b = cloneChild(base, a.dir, 'b', url('a'));
		const handPort = cloneChild(base, b, 'hand-port', url('b'));
		return {base, a, b, handPort};
	}

	/** Diverge b on the line a is about to change, so b conflicts. */
	function conflictInB(aDir: string, bDir: string) {
		writeFile(bDir, 'file.txt', 'b-change\n');
		commit(bDir, 'diverge in b');
		writeFile(aDir, 'file.txt', 'v2\n');
		commit(aDir, 'change in a');
	}

	const lineFor = (report: string, label: string) =>
		report.split('\n').find((l) => l.includes(label)) ?? '';

	it('reports `ignored`, not `skipped`, when the parent conflicts', async () => {
		const {base, a, b, handPort} = chain();
		conflictInB(a.dir, b);
		const before = branchSha(handPort, 'main');

		const result = await propagate({
			sourcePath: a.dir,
			baseDir: base,
			ignore: ['hand-port'],
		});
		const report = formatReport(result, {color: false});

		const bNode = result.children[0]!;
		expect(bNode.repo.name).toBe('b');
		expect(bNode.status).toBe('conflict');

		const node = bNode.children[0]!;
		expect(node.repo.name).toBe('hand-port');
		expect(node.status).toBe('ignored');
		expect(node.message).toContain('hand-port');
		expect(node.message).not.toContain('parent not updated');

		// the wording is the actual interface: assert on the rendered report
		expect(lineFor(report, 'hand-port@main')).toContain(
			'hand-port@main ignored',
		);
		expect(report).not.toContain('hand-port@main skipped');
		expect(report).not.toContain('hand-port@main skipped — parent not updated');
		expect(summarize(result).ignored).toBe(1);
		expect(summarize(result).skipped).toBe(0);

		expect(branchSha(handPort, 'main')).toBe(before);
	});

	it('reads the same before and after the parent conflict is resolved', async () => {
		const {base, a, b, handPort} = chain();
		conflictInB(a.dir, b);
		const before = branchSha(handPort, 'main');

		const whileBlocked = formatReport(
			await propagate({
				sourcePath: a.dir,
				baseDir: base,
				ignore: ['hand-port'],
			}),
			{color: false},
		);

		// resolve b by landing a's content there, so the next run merges cleanly
		writeFile(b, 'file.txt', 'v2\n');
		commit(b, 'resolve in b');

		const resolved = await propagate({
			sourcePath: a.dir,
			baseDir: base,
			ignore: ['hand-port'],
		});
		expect(resolved.children[0]!.status).not.toBe('conflict');
		const afterResolve = formatReport(resolved, {color: false});

		// same registry, same flag: the exclusion must read identically either way
		expect(lineFor(whileBlocked, 'hand-port@main')).toBe(
			lineFor(afterResolve, 'hand-port@main'),
		);
		expect(lineFor(afterResolve, 'hand-port@main')).toContain('ignored');
		expect(branchSha(handPort, 'main')).toBe(before);
	});

	it('is counted as ignored, not blocked, by status', async () => {
		const {base, a, b} = chain();
		conflictInB(a.dir, b);

		const results = await statusTree(
			discoverRepos(base, 'stem'),
			'stem',
			undefined,
			{ignore: ['hand-port']},
		);
		expect(results.length).toBe(1);
		const status = results[0]!;
		expect(status.counts.conflict).toBe(1); // b
		expect(status.ignored).toEqual(['hand-port@main']);
		expect(status.blocked).toEqual([]);
		expect(status.counts.ignored).toBe(1);
		expect(status.counts.skipped).toBe(0);

		const report = formatStatusReport(results, {color: false});
		expect(report).toContain('ignored: hand-port@main');
		expect(report).not.toContain('blocked: hand-port@main');
	});

	/**
	 * The decided behaviour, asserted so it stays a decision: an ignored node
	 * still blocks its own children. The cascade merges a node's current local
	 * ref into its children, and an ignored node never received the change, so
	 * there is no route through it. Its children say so, naming the exclusion.
	 */
	it('still blocks its own children, naming the exclusion as the cause', async () => {
		const base = tempDir();
		const a = initRepo(base, 'a', {'file.txt': 'v1\n'});
		setRemote(a.dir, 'origin', url('a'));
		const handPort = cloneChild(base, a.dir, 'hand-port', url('a'));
		const downstream = cloneChild(
			base,
			handPort,
			'downstream',
			url('hand-port'),
		);
		writeFile(a.dir, 'file.txt', 'v2\n');
		commit(a.dir, 'change in a');

		const result = await propagate({
			sourcePath: a.dir,
			baseDir: base,
			ignore: ['hand-port'],
		});
		const report = formatReport(result, {color: false});

		const node = result.children[0]!;
		expect(node.repo.name).toBe('hand-port');
		expect(node.status).toBe('ignored');

		const child = node.children[0]!;
		expect(child.repo.name).toBe('downstream');
		expect(child.status).toBe('skipped');
		expect(child.message).toBe('parent not updated (ignored)');
		expect(report).toContain(
			'downstream@main skipped — parent not updated (ignored)',
		);

		// and nothing below the exclusion was touched
		expect(fileOnBranch(handPort, 'main', 'file.txt')).toBe('v1\n');
		expect(fileOnBranch(downstream, 'main', 'file.txt')).toBe('v1\n');
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
