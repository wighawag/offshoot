/**
 * Config lives on an orphan branch, so the template's working tree carries no
 * offshoot-specific file. Reading must never touch the working tree, and
 * writing must never touch the working tree, the index or the current branch.
 */

import {afterEach, describe, expect, it} from 'vitest';
import {existsSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {
	CONFIG_FILE,
	DEFAULT_CONFIG_BRANCH,
	planRepo,
	propagate,
	resolveConfig,
	writeConfig,
} from '../src/index.js';
import {
	branchSha,
	cleanupTempDirs,
	commit,
	currentBranchOf,
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

const CONFIG = JSON.stringify({
	branches: {main: {}, 'variant/full': {stem: 'main'}},
	verify: 'echo verified',
});

describe('resolveConfig', () => {
	it('reads the local config branch without checking anything out', () => {
		const base = tempDir();
		const a = initRepo(base, 'a', {'file.txt': 'v1\n'});
		writeConfigBranch(a.dir, CONFIG);

		const r = resolveConfig(a.dir);
		expect(r.source).toBe('branch');
		expect(r.ref).toBe(`${DEFAULT_CONFIG_BRANCH}:${CONFIG_FILE}`);
		expect(r.config?.branches).toEqual({
			main: {},
			'variant/full': {stem: 'main'},
		});
		expect(r.config?.verify).toBe('echo verified');

		// the working tree is untouched: no config file, still on `main`
		expect(existsSync(join(a.dir, CONFIG_FILE))).toBe(false);
		expect(currentBranchOf(a.dir)).toBe('main');
	});

	it('falls back to origin/<branch> on a fresh clone', () => {
		const base = tempDir();
		const a = initRepo(base, 'a', {'file.txt': 'v1\n'});
		writeConfigBranch(a.dir, CONFIG);
		git(['clone', a.dir, 'clone'], base);
		const clone = join(base, 'clone');

		// no local config branch exists in the clone
		expect(git(['branch', '--list', DEFAULT_CONFIG_BRANCH], clone).trim()).toBe(
			'',
		);

		const r = resolveConfig(clone);
		expect(r.source).toBe('remote-branch');
		expect(r.ref).toBe(`origin/${DEFAULT_CONFIG_BRANCH}:${CONFIG_FILE}`);
		expect(r.config?.branches?.['variant/full']).toEqual({stem: 'main'});
	});

	it('reports absence as `none`, which means today\u2019s defaults', () => {
		const base = tempDir();
		const a = initRepo(base, 'a', {'file.txt': 'v1\n'});

		const r = resolveConfig(a.dir);
		expect(r.source).toBe('none');
		expect(r.config).toBeNull();
		expect(r.error).toBeNull();

		const plan = planRepo({
			name: 'a',
			path: a.dir,
			originUrl: null,
			originalUrl: null,
		});
		expect(plan.branches).toEqual([
			{name: 'main', stems: [], stemBranch: null},
		]);
		expect(plan.primary).toBe('main');
	});

	it('honors an alternative config branch and --no-config', () => {
		const base = tempDir();
		const a = initRepo(base, 'a', {'file.txt': 'v1\n'});
		writeConfigBranch(a.dir, CONFIG, 'offshoot/fanout');

		expect(resolveConfig(a.dir).source).toBe('none');
		const custom = resolveConfig(a.dir, {branch: 'offshoot/fanout'});
		expect(custom.source).toBe('branch');
		expect(custom.config?.verify).toBe('echo verified');

		const off = resolveConfig(a.dir, {
			branch: 'offshoot/fanout',
			enabled: false,
		});
		expect(off.source).toBe('disabled');
		expect(off.config).toBeNull();
	});

	it('treats a same-named branch with no config file as a name collision, not an error', () => {
		const base = tempDir();
		const a = initRepo(base, 'a', {'file.txt': 'v1\n'});
		// somebody's ordinary feature branch that happens to be called `offshoot`
		git(['branch', DEFAULT_CONFIG_BRANCH], a.dir);

		const r = resolveConfig(a.dir);
		expect(r.source).toBe('none');
		expect(r.error).toBeNull();
		expect(r.note).toContain('has no fanout.config.json');

		const plan = planRepo({
			name: 'a',
			path: a.dir,
			originUrl: null,
			originalUrl: null,
		});
		expect(plan.error).toBeNull();
		expect(plan.branches).toEqual([
			{name: 'main', stems: [], stemBranch: null},
		]);
		expect(plan.note).toContain('has no fanout.config.json');
	});

	it('does not let that collision block a whole subtree', async () => {
		const base = tempDir();
		const a = initRepo(base, 'a', {'file.txt': 'v1\n'});
		setRemote(a.dir, 'origin', url('a'));
		git(['clone', a.dir, 'b'], base);
		const b = join(base, 'b');
		setRemote(b, 'origin', url('b'));
		setRemote(b, 'stem', url('a'));
		git(['clone', b, 'c'], base);
		const c = join(base, 'c');
		setRemote(c, 'origin', url('c'));
		setRemote(c, 'stem', url('b'));
		git(['branch', DEFAULT_CONFIG_BRANCH], b);

		writeFile(a.dir, 'file.txt', 'v2\n');
		commit(a.dir, 'change in a');

		const result = await propagate({sourcePath: a.dir, baseDir: base});
		const bNode = result.children[0]!;
		expect(bNode.status).toBe('merged');
		expect(bNode.message).toContain('has no fanout.config.json');
		expect(bNode.children[0]!.status).toBe('merged');
		expect(readFile(c, 'file.txt')).toBe('v2\n');
	});

	it('reports malformed config as an error, with the ref that produced it', () => {
		const base = tempDir();
		const a = initRepo(base, 'a', {'file.txt': 'v1\n'});
		writeConfigBranch(a.dir, '{"branches": [not json');

		const r = resolveConfig(a.dir);
		expect(r.source).toBe('error');
		expect(r.ref).toBe(`${DEFAULT_CONFIG_BRANCH}:${CONFIG_FILE}`);
		expect(r.error).toContain('is invalid');
	});

	it('rejects a config whose shape is wrong (not just unparseable)', () => {
		const base = tempDir();
		const a = initRepo(base, 'a', {'file.txt': 'v1\n'});
		writeConfigBranch(a.dir, JSON.stringify({branches: ['main']}));

		const r = resolveConfig(a.dir);
		expect(r.source).toBe('error');
		expect(r.error).toContain('`branches` must be an object');
	});
});

describe('malformed config in a cascade', () => {
	it('errors the node and attempts no merge, blocking its descendants', async () => {
		const base = tempDir();
		const a = initRepo(base, 'a', {'file.txt': 'v1\n'});
		setRemote(a.dir, 'origin', url('a'));
		git(['clone', a.dir, 'b'], base);
		const b = join(base, 'b');
		setRemote(b, 'origin', url('b'));
		setRemote(b, 'stem', url('a'));
		git(['clone', b, 'c'], base);
		const c = join(base, 'c');
		setRemote(c, 'origin', url('c'));
		setRemote(c, 'stem', url('b'));

		writeConfigBranch(b, '{oops');
		const bBefore = branchSha(b, 'main');
		const cBefore = branchSha(c, 'main');

		writeFile(a.dir, 'file.txt', 'v2\n');
		commit(a.dir, 'change in a');

		const result = await propagate({sourcePath: a.dir, baseDir: base});
		const bNode = result.children[0]!;
		expect(bNode.repo.name).toBe('b');
		expect(bNode.status).toBe('error');
		expect(bNode.message).toContain('is invalid');
		// no merge was attempted anywhere below it
		expect(branchSha(b, 'main')).toBe(bBefore);
		expect(bNode.children[0]!.status).toBe('skipped');
		expect(branchSha(c, 'main')).toBe(cBefore);
	});

	it('--no-config falls back to the defaults instead of erroring', async () => {
		const base = tempDir();
		const a = initRepo(base, 'a', {'file.txt': 'v1\n'});
		setRemote(a.dir, 'origin', url('a'));
		git(['clone', a.dir, 'b'], base);
		const b = join(base, 'b');
		setRemote(b, 'origin', url('b'));
		setRemote(b, 'stem', url('a'));
		writeConfigBranch(b, '{oops');

		writeFile(a.dir, 'file.txt', 'v2\n');
		commit(a.dir, 'change in a');

		const result = await propagate({
			sourcePath: a.dir,
			baseDir: base,
			useConfig: false,
		});
		expect(result.children[0]!.status).toBe('merged');
		expect(readFile(b, 'file.txt')).toBe('v2\n');
	});
});

describe('verify', () => {
	it('never runs unless asked, then reports pass/fail per node', async () => {
		const base = tempDir();
		const a = initRepo(base, 'a', {'file.txt': 'v1\n'});
		setRemote(a.dir, 'origin', url('a'));
		git(['clone', a.dir, 'b'], base);
		const b = join(base, 'b');
		setRemote(b, 'origin', url('b'));
		setRemote(b, 'stem', url('a'));
		writeConfigBranch(b, JSON.stringify({verify: 'test -f file.txt'}));

		writeFile(a.dir, 'file.txt', 'v2\n');
		commit(a.dir, 'change in a');

		const off = await propagate({sourcePath: a.dir, baseDir: base});
		expect(off.children[0]!.status).toBe('merged');
		expect(off.children[0]!.verify).toBeNull(); // opt-in: it did not run

		// undo the merge so the same change can be merged again, this time verified
		git(['reset', '--hard', 'HEAD~1'], b);
		const on = await propagate({
			sourcePath: a.dir,
			baseDir: base,
			verify: true,
		});
		expect(on.children[0]!.verify).toEqual({
			status: 'passed',
			command: 'test -f file.txt',
			message: 'verify passed',
		});
	});

	it('reports a failing verify without pretending the merge did not happen', async () => {
		const base = tempDir();
		const a = initRepo(base, 'a', {'file.txt': 'v1\n'});
		setRemote(a.dir, 'origin', url('a'));
		git(['clone', a.dir, 'b'], base);
		const b = join(base, 'b');
		setRemote(b, 'origin', url('b'));
		setRemote(b, 'stem', url('a'));
		writeConfigBranch(b, JSON.stringify({verify: 'echo boom >&2; exit 3'}));

		writeFile(a.dir, 'file.txt', 'v2\n');
		commit(a.dir, 'change in a');

		const result = await propagate({
			sourcePath: a.dir,
			baseDir: base,
			verify: true,
		});
		expect(result.children[0]!.status).toBe('merged');
		expect(result.children[0]!.verify?.status).toBe('failed');
		expect(result.children[0]!.verify?.message).toContain('boom');
	});

	it('keeps the temporary worktree when verify fails, so it can be inspected', async () => {
		const base = tempDir();
		const a = initRepo(base, 'a', {'file.txt': 'v1\n'});
		setRemote(a.dir, 'origin', url('a'));
		git(['clone', a.dir, 'b'], base);
		const b = join(base, 'b');
		setRemote(b, 'origin', url('b'));
		setRemote(b, 'stem', url('a'));
		writeConfigBranch(b, JSON.stringify({verify: 'exit 1'}));
		git(['checkout', '-b', 'elsewhere'], b); // main merges in a temp worktree

		writeFile(a.dir, 'file.txt', 'v2\n');
		commit(a.dir, 'change in a');

		const result = await propagate({
			sourcePath: a.dir,
			baseDir: base,
			verify: true,
		});
		const node = result.children[0]!;
		expect(node.verify?.status).toBe('failed');
		expect(node.worktree).toBeTruthy();
		expect(node.message).toContain(node.worktree!);
		expect(existsSync(node.worktree!)).toBe(true);
		expect(worktreeCount(b)).toBe(2);

		git(['worktree', 'remove', '--force', node.worktree!], b);
	});
});

describe('writeConfig', () => {
	it('creates the orphan branch with plumbing, touching nothing else', () => {
		const base = tempDir();
		const a = initRepo(base, 'a', {'file.txt': 'v1\n'});
		const headBefore = branchSha(a.dir, 'main');
		// a deliberately dirty tree: writing config must not care
		writeFile(a.dir, 'scratch.txt', 'uncommitted\n');

		const cfg = join(base, 'cfg.json');
		writeFileSync(cfg, CONFIG);
		const r = writeConfig(a.dir, cfg);

		expect(r.ok).toBe(true);
		expect(r.created).toBe(true);
		expect(r.branch).toBe(DEFAULT_CONFIG_BRANCH);

		// readable through the normal path…
		expect(resolveConfig(a.dir).config?.verify).toBe('echo verified');
		// …and nothing else moved
		expect(branchSha(a.dir, 'main')).toBe(headBefore);
		expect(currentBranchOf(a.dir)).toBe('main');
		expect(readFile(a.dir, 'scratch.txt')).toBe('uncommitted\n');
		expect(existsSync(join(a.dir, CONFIG_FILE))).toBe(false);
		// the config branch is an orphan: it shares no merge base with main, which
		// is exactly why it never propagates and never conflicts
		let sharesHistory = true;
		try {
			git(['merge-base', 'main', DEFAULT_CONFIG_BRANCH], a.dir);
		} catch {
			sharesHistory = false;
		}
		expect(sharesHistory).toBe(false);
		// and it holds exactly one file
		expect(
			git(['ls-tree', '--name-only', DEFAULT_CONFIG_BRANCH], a.dir).trim(),
		).toBe(CONFIG_FILE);
	});

	it('commits on top of an existing config branch, keeping its history', () => {
		const base = tempDir();
		const a = initRepo(base, 'a', {'file.txt': 'v1\n'});
		const cfg = join(base, 'cfg.json');

		writeFileSync(cfg, JSON.stringify({verify: 'first'}));
		expect(writeConfig(a.dir, cfg).created).toBe(true);
		writeFileSync(cfg, JSON.stringify({verify: 'second'}));
		const second = writeConfig(a.dir, cfg);

		expect(second.created).toBe(false);
		expect(resolveConfig(a.dir).config?.verify).toBe('second');
		expect(
			git(['rev-list', '--count', DEFAULT_CONFIG_BRANCH], a.dir).trim(),
		).toBe('2');
	});

	it('refuses to write a config it could not read back', () => {
		const base = tempDir();
		const a = initRepo(base, 'a', {'file.txt': 'v1\n'});
		const cfg = join(base, 'cfg.json');
		writeFileSync(cfg, '{"branches": 3}');

		const r = writeConfig(a.dir, cfg);
		expect(r.ok).toBe(false);
		expect(r.message).toContain('refusing to write an invalid config');
		expect(resolveConfig(a.dir).source).toBe('none');
	});
});
