import {afterEach, describe, expect, it} from 'vitest';
import path from 'node:path';
import {
	backport,
	discoverAncestry,
	discoverRepos,
	driftTree,
	linkRemote,
	loadRegistry,
	renameRemotes,
	saveRegistry,
	statusTree,
} from '../src/index.js';
import {hasRemote, getRemoteUrl} from '../src/git.js';
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

function url(name: string): string {
	return `https://github.com/test/${name}.git`;
}

describe('linkRemote', () => {
	it('creates the parent remote when absent, repoints when present', () => {
		const base = tempDir();
		const child = initRepo(base, 'child', {'file.txt': 'x\n'});

		const r1 = linkRemote(child.dir, url('parent'), 'stem');
		expect(r1.status).toBe('linked');
		expect(hasRemote(child.dir, 'stem')).toBe(true);
		expect(getRemoteUrl(child.dir, 'stem')).toBe(url('parent'));

		const r2 = linkRemote(child.dir, url('other'), 'stem');
		expect(r2.status).toBe('repointed');
		expect(getRemoteUrl(child.dir, 'stem')).toBe(url('other'));
	});
});

describe('renameRemotes', () => {
	it('renames `original` -> `stem` only on repos that have `original`', () => {
		const base = tempDir();
		const a = initRepo(base, 'a', {f: '1\n'});
		const b = initRepo(base, 'b', {f: '1\n'});
		const c = initRepo(base, 'c', {f: '1\n'}); // no `original` remote
		setRemote(a.dir, 'original', url('parentA'));
		setRemote(b.dir, 'original', url('parentB'));

		const results = renameRemotes(base, 'original', 'stem');

		// c is not returned (it has no `original`)
		expect(results.map((r) => r.repo.name).sort()).toEqual(['a', 'b']);
		expect(results.every((r) => r.status === 'renamed')).toBe(true);

		expect(hasRemote(a.dir, 'original')).toBe(false);
		expect(getRemoteUrl(a.dir, 'stem')).toBe(url('parentA'));
		expect(hasRemote(b.dir, 'original')).toBe(false);
		expect(getRemoteUrl(b.dir, 'stem')).toBe(url('parentB'));
		expect(hasRemote(c.dir, 'stem')).toBe(false);
	});

	it('does not clobber an existing `stem` pointing elsewhere', () => {
		const base = tempDir();
		const a = initRepo(base, 'a', {f: '1\n'});
		setRemote(a.dir, 'original', url('old'));
		setRemote(a.dir, 'stem', url('different'));

		const results = renameRemotes(base, 'original', 'stem');
		expect(results[0]!.status).toBe('taken');
		// nothing changed: both remotes intact
		expect(getRemoteUrl(a.dir, 'original')).toBe(url('old'));
		expect(getRemoteUrl(a.dir, 'stem')).toBe(url('different'));
	});

	it('dry-run reports the rename without performing it', () => {
		const base = tempDir();
		const a = initRepo(base, 'a', {f: '1\n'});
		setRemote(a.dir, 'original', url('parent'));

		const results = renameRemotes(base, 'original', 'stem', true);
		expect(results[0]!.status).toBe('renamed');
		expect(results[0]!.message).toContain('would rename');
		// nothing changed: `original` still present, `stem` still absent
		expect(getRemoteUrl(a.dir, 'original')).toBe(url('parent'));
		expect(hasRemote(a.dir, 'stem')).toBe(false);
	});
});

describe('discoverAncestry', () => {
	it('groups repos by shared history and proposes a root-first tree', () => {
		const base = tempDir();
		// a (root, 1 commit) -> b (adds a commit) -> c (adds a commit)
		const a = initRepo(base, 'a', {'file.txt': 'v1\n'});
		setRemote(a.dir, 'origin', url('a'));

		const bDir = `${base}/b`;
		git(['clone', a.dir, 'b'], base);
		writeFile(bDir, 'file.txt', 'v2\n');
		commit(bDir, 'b diverges');
		setRemote(bDir, 'origin', url('b'));

		const cDir = `${base}/c`;
		git(['clone', bDir, 'c'], base);
		writeFile(cDir, 'file.txt', 'v3\n');
		commit(cDir, 'c diverges');
		setRemote(cDir, 'origin', url('c'));

		// an unrelated repo -> its own family
		const d = initRepo(base, 'd', {'other.txt': 'x\n'});
		setRemote(d.dir, 'origin', url('d'));

		const trees = discoverAncestry(base, 'stem');

		// two families: {a,b,c} and {d}
		expect(trees.length).toBe(2);

		// the big family: root = a (fewest commits), edges b->a, c->b
		const big = trees.find((t) => t.edges.length === 3)!;
		expect(big).toBeDefined();
		expect(big.root.name).toBe('a');
		const edgeByName = new Map(big.edges.map((e) => [e.repo.name, e] as const));
		expect(edgeByName.get('a')!.parent).toBeNull();
		expect(edgeByName.get('b')!.parent?.name).toBe('a');
		expect(edgeByName.get('c')!.parent?.name).toBe('b');
		// none are wired yet
		expect(big.edges.every((e) => e.existingParentUrl === null)).toBe(true);

		// the singleton family: d, no parent
		const solo = trees.find((t) => t.edges.length === 1)!;
		expect(solo.root.name).toBe('d');
		expect(solo.edges[0]!.parent).toBeNull();
	});
});

// ─── drift, backport, registry ───────────────────────────────────────────────

function headSha(dir: string): string {
	return git(['rev-parse', 'HEAD'], dir).trim();
}

describe('driftTree', () => {
	it('lists commits a child has that its parent lacks', () => {
		const base = tempDir();
		const a = initRepo(base, 'a', {'file.txt': 'v1\n'});
		setRemote(a.dir, 'origin', url('a'));
		const bDir = `${base}/b`;
		git(['clone', a.dir, 'b'], base);
		writeFile(bDir, 'file.txt', 'b-change\n');
		commit(bDir, 'b diverges');
		setRemote(bDir, 'origin', url('b'));
		setRemote(bDir, 'stem', url('a'));

		const repos = discoverRepos(base, 'stem');
		const results = driftTree(repos, 'stem', 'main');

		// a is the root (no stem) -> not reported; b is ahead by 1
		const names = results.map((r) => r.repo.name);
		expect(names).not.toContain('a');
		const b = results.find((r) => r.repo.name === 'b')!;
		expect(b).toBeDefined();
		expect(b.ahead.length).toBe(1);
		expect(b.ahead[0]!.subject).toBe('b diverges');
	});
});

describe('backport', () => {
	it('cherry-picks a descendant commit onto its immediate stem parent', () => {
		const base = tempDir();
		const a = initRepo(base, 'a', {'file.txt': 'v1\n'});
		setRemote(a.dir, 'origin', url('a'));
		const bDir = `${base}/b`;
		git(['clone', a.dir, 'b'], base);
		writeFile(bDir, 'file.txt', 'b-change\n');
		commit(bDir, 'b diverges');
		setRemote(bDir, 'origin', url('b'));
		setRemote(bDir, 'stem', url('a'));

		const sha = headSha(bDir);
		const repos = discoverRepos(base, 'stem');
		const result = backport({fromPath: bDir, commit: sha, repos});

		expect(result.status).toBe('backported');
		expect(result.ancestorName).toBe('a');
		// a now carries the change
		expect(readFile(a.dir, 'file.txt')).toBe('b-change\n');
		expect(git(['log', '-1', '--format=%s', 'HEAD'], a.dir).trim()).toBe(
			'b diverges',
		);
	});

	it('dry-run describes the commit without applying it', () => {
		const base = tempDir();
		const a = initRepo(base, 'a', {'file.txt': 'v1\n'});
		setRemote(a.dir, 'origin', url('a'));
		const bDir = `${base}/b`;
		git(['clone', a.dir, 'b'], base);
		writeFile(bDir, 'file.txt', 'b-change\n');
		commit(bDir, 'b diverges');
		setRemote(bDir, 'origin', url('b'));
		setRemote(bDir, 'stem', url('a'));

		const sha = headSha(bDir);
		const repos = discoverRepos(base, 'stem');
		const result = backport({fromPath: bDir, commit: sha, repos, dryRun: true});

		expect(result.status).toBe('dry-run');
		expect(readFile(a.dir, 'file.txt')).toBe('v1\n'); // unchanged
	});
});

describe('registry (save/load)', () => {
	it('writes one file per family and loads it back with stem wiring', () => {
		const home = tempDir();
		const origHome = process.env.HOME;
		process.env.HOME = home;
		try {
			const base = tempDir();
			const a = initRepo(base, 'a', {'file.txt': 'v1\n'});
			setRemote(a.dir, 'origin', url('a'));
			const bDir = clone(base, a.dir, 'b');
			const cDir = clone(base, bDir, 'c');

			const repos = discoverRepos(base, 'stem');
			const written = saveRegistry(repos, 'stem');
			expect(written.length).toBe(1);
			expect(written[0]).toContain('.offshoot-stems/a.json');

			const loaded = loadRegistry(written[0]!);
			expect(loaded).not.toBeNull();
			expect(loaded!.root).toBe('a');
			expect(loaded!.repos.map((r) => r.name).sort()).toEqual(['a', 'b', 'c']);
			// b and c are wired with stem; a (root) is not
			const byName = new Map(loaded!.repos.map((r) => [r.name, r] as const));
			expect(byName.get('a')!.originalUrl).toBeNull();
			expect(byName.get('b')!.originalUrl).toBe(url('a'));
			expect(byName.get('c')!.originalUrl).toBe(url('b'));
		} finally {
			process.env.HOME = origHome;
		}
	});
});

function clone(parent: string, src: string, name: string): string {
	const dir = `${parent}/${name}`;
	git(['clone', src, name], parent);
	setRemote(dir, 'origin', url(name));
	setRemote(dir, 'stem', src.endsWith('.git') ? src : src);
	// stem should point at the parent's origin URL, not the local clone path:
	setRemote(dir, 'stem', url(parentRepoName(src)));
	return dir;
}
function parentRepoName(src: string): string {
	return path.basename(src).replace(/\.git$/, '');
}

describe('statusTree', () => {
	it('reports downstream merges and upstream drift per wired root', async () => {
		const base = tempDir();
		const a = initRepo(base, 'a', {'file.txt': 'v1\n'});
		setRemote(a.dir, 'origin', url('a'));
		const bDir = `${base}/b`;
		git(['clone', a.dir, 'b'], base);
		setRemote(bDir, 'origin', url('b'));
		setRemote(bDir, 'stem', url('a'));
		const cDir = `${base}/c`;
		git(['clone', bDir, 'c'], base);
		setRemote(cDir, 'origin', url('c'));
		setRemote(cDir, 'stem', url('b'));

		// b diverges on file.txt; a advances on a different file (no conflict)
		writeFile(bDir, 'file.txt', 'b-change\n');
		commit(bDir, 'b diverges');
		writeFile(a.dir, 'other.txt', 'a-change\n');
		commit(a.dir, 'a advances');

		const repos = discoverRepos(base, 'stem');
		const results = await statusTree(repos, 'stem', 'main');

		expect(results.length).toBe(1);
		const st = results[0]!;
		expect(st.root.name).toBe('a');
		expect(st.repoCount).toBe(3);
		expect(st.counts.conflict).toBe(0);
		expect(st.counts.merged).toBe(2); // b and c both merge cleanly
		expect(st.conflicts).toEqual([]);
		expect(st.blocked).toEqual([]);
		// drift: only b is ahead of its parent (a); c is not ahead of b
		expect(st.drift.map((d) => d.repo.name)).toEqual(['b']);
		expect(st.drift[0]!.ahead.length).toBe(1);
		expect(st.drift[0]!.ahead[0]!.subject).toBe('b diverges');
	});
});

// ─── skills install ───────────────────────────────────────────────────────────
import {availableSkills, installSkills, destinationFor} from '../src/skills.js';
import {existsSync} from 'node:fs';
import {join} from 'node:path';

describe('skills install', () => {
	it('copies the bundled skill(s) into <cwd>/.agents/skills (project scope)', () => {
		const cwd = tempDir();
		expect(availableSkills().length).toBeGreaterThan(0);

		const installed = installSkills('project', cwd);
		expect(installed.length).toBeGreaterThan(0);
		for (const entry of installed) {
			expect(existsSync(entry.to)).toBe(true);
		}
		// the reconcile-template-tree skill is the one that ships today
		expect(
			existsSync(
				join(
					destinationFor('project', cwd),
					'reconcile-template-tree',
					'SKILL.md',
				),
			),
		).toBe(true);
	});
});
