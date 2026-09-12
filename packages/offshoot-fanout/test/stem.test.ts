/**
 * The parent REPO, published in config so a tree survives the machine holding it.
 *
 * Two properties matter most here and are asserted rather than assumed:
 * absence of the field stays valid forever (every existing tree has none), and
 * the `stem` REMOTE keeps winning for merges, because pointing it at a sibling
 * checkout on disk is how a maintainer actually works on a tree.
 */

import {afterEach, describe, expect, it} from 'vitest';
import {
	CONFIG_FILE,
	DEFAULT_CONFIG_BRANCH,
	parseStem,
	resolveConfig,
	resolveParent,
	serializeConfig,
	setStem,
	stemUrl,
} from '../src/index.js';
import {
	cleanupTempDirs,
	git,
	initRepo,
	setRemote,
	tempDir,
	writeConfigBranch,
} from './helpers.js';

afterEach(cleanupTempDirs);

describe('parseStem', () => {
	it('canonicalizes every spelling of the same repo to one id', () => {
		const expected = 'github:wighawag/jolly-roger';
		for (const written of [
			'wighawag/jolly-roger',
			'github:wighawag/jolly-roger',
			'git@github.com:wighawag/jolly-roger.git',
			'https://github.com/wighawag/jolly-roger',
			'https://github.com/wighawag/jolly-roger.git',
			'ssh://git@github.com/wighawag/jolly-roger.git',
		]) {
			expect(parseStem(written).id, written).toBe(expected);
		}
	});

	it('keeps the owner and name available for cloning and folder naming', () => {
		const s = parseStem('github:wighawag/template-svelte');
		expect(s.owner).toBe('wighawag');
		expect(s.name).toBe('template-svelte');
		expect(s.path).toBe('wighawag/template-svelte');
	});

	it('emits ssh or https on demand, so a clone matches the tree it joins', () => {
		const s = parseStem('wighawag/bleeps');
		expect(stemUrl(s, 'ssh')).toBe('git@github.com:wighawag/bleeps.git');
		expect(stemUrl(s, 'https')).toBe('https://github.com/wighawag/bleeps.git');
	});

	it('keeps a self-hosted URL as a URL, since it has no short spelling', () => {
		const s = parseStem('https://git.example.com/team/thing.git');
		expect(s.id).toBe('https://git.example.com/team/thing');
		expect(s.provider).toBe('other');
		expect(stemUrl(s, 'ssh')).toBe('https://git.example.com/team/thing');
	});

	it('refuses a local path, which is exactly what does not travel', () => {
		expect(() => parseStem('/home/me/dev/template-svelte')).toThrow(
			/not a local path/,
		);
		expect(() => parseStem('../template-svelte')).toThrow(/not a local path/);
	});

	it('refuses a bare name, which cannot identify a repo on a host', () => {
		expect(() => parseStem('template-svelte')).toThrow(/owner\/name/);
	});
});

describe('resolveParent: precedence between config and remote', () => {
	it('uses the remote when there is no config field (every tree today)', () => {
		const r = resolveParent({
			remoteUrl: 'git@github.com:wighawag/template-svelte.git',
		});
		expect(r.source).toBe('remote');
		expect(r.url).toBe('git@github.com:wighawag/template-svelte.git');
	});

	it('uses the config when the machine has no remote yet (a fresh clone)', () => {
		const r = resolveParent({
			remoteUrl: null,
			configStem: 'github:wighawag/template-svelte',
		});
		expect(r.source).toBe('config');
		expect(r.url).toBe('https://github.com/wighawag/template-svelte.git');
	});

	it('reports agreement across ssh vs https rather than calling it drift', () => {
		const r = resolveParent({
			remoteUrl: 'git@github.com:Wighawag/Template-Svelte.git',
			configStem: 'github:wighawag/template-svelte',
		});
		expect(r.source).toBe('both');
		expect(r.conflict).toBeNull();
	});

	it('surfaces a real disagreement, and still merges from the remote', () => {
		const r = resolveParent({
			remoteUrl: 'git@github.com:someone/other-template.git',
			configStem: 'github:wighawag/template-svelte',
		});
		expect(r.source).toBe('mismatch');
		expect(r.conflict).toEqual({
			config: 'github:wighawag/template-svelte',
			remote: 'git@github.com:someone/other-template.git',
		});
		// The remote is what git fetches, so it is what the report must name.
		expect(r.url).toBe('git@github.com:someone/other-template.git');
	});

	it('does NOT cry drift when the remote is a local clone of that same parent', () => {
		const base = tempDir();
		const parent = initRepo(base, 'template-svelte', {'a.txt': 'v1\n'});
		setRemote(
			parent.dir,
			'origin',
			'git@github.com:wighawag/template-svelte.git',
		);

		const r = resolveParent({
			remoteUrl: parent.dir,
			configStem: 'github:wighawag/template-svelte',
		});
		expect(r.source).toBe('both');
	});

	it('distinguishes a declared root from an unannotated repo', () => {
		expect(resolveParent({remoteUrl: null, configStem: null}).source).toBe(
			'declared-root',
		);
		expect(resolveParent({remoteUrl: null}).source).toBe('none');
	});

	it('reports a declared root that nevertheless has a parent remote', () => {
		const r = resolveParent({
			remoteUrl: 'git@github.com:wighawag/template-svelte.git',
			configStem: null,
		});
		expect(r.source).toBe('mismatch');
	});
});

describe('the stem field in fanout.config.json', () => {
	it('is read back canonicalized, however it was written', () => {
		const base = tempDir();
		const a = initRepo(base, 'a', {'file.txt': 'v1\n'});
		writeConfigBranch(
			a.dir,
			JSON.stringify({stem: 'git@github.com:wighawag/template-svelte.git'}),
		);
		expect(resolveConfig(a.dir).config?.stem).toBe(
			'github:wighawag/template-svelte',
		);
	});

	it('keeps null distinct from absent', () => {
		const base = tempDir();
		const rootRepo = initRepo(base, 'root', {'f.txt': 'v\n'});
		writeConfigBranch(rootRepo.dir, JSON.stringify({stem: null}));
		const withNull = resolveConfig(rootRepo.dir).config!;
		expect('stem' in withNull).toBe(true);
		expect(withNull.stem).toBeNull();

		const legacy = initRepo(base, 'legacy', {'f.txt': 'v\n'});
		writeConfigBranch(legacy.dir, JSON.stringify({branches: {main: {}}}));
		expect('stem' in resolveConfig(legacy.dir).config!).toBe(false);
	});

	it('refuses a config whose stem cannot identify a repo', () => {
		const base = tempDir();
		const a = initRepo(base, 'a', {'f.txt': 'v\n'});
		writeConfigBranch(a.dir, JSON.stringify({stem: '/home/me/dev/parent'}));
		const r = resolveConfig(a.dir);
		expect(r.source).toBe('error');
		expect(r.error).toMatch(/stem/);
	});

	it('serializes stem first, so the file reads identity-then-detail', () => {
		expect(
			serializeConfig({
				verify: 'pnpm check',
				branches: {main: {}},
				stem: 'github:wighawag/template-svelte',
			}),
		).toBe(
			`{\n  "stem": "github:wighawag/template-svelte",\n  "branches": {\n    "main": {}\n  },\n  "verify": "pnpm check"\n}\n`,
		);
	});
});

describe('setStem: publishing an edge that exists only on this machine', () => {
	it('adds the field while preserving the rest of the config', () => {
		const base = tempDir();
		const a = initRepo(base, 'a', {'f.txt': 'v\n'});
		writeConfigBranch(
			a.dir,
			JSON.stringify({
				branches: {main: {}, 'with/all': {stem: 'main'}},
				verify: 'pnpm check',
			}),
		);

		const result = setStem(a.dir, 'wighawag/template-svelte');
		expect(result.ok).toBe(true);

		const after = resolveConfig(a.dir).config!;
		expect(after.stem).toBe('github:wighawag/template-svelte');
		expect(after.branches).toEqual({main: {}, 'with/all': {stem: 'main'}});
		expect(after.verify).toBe('pnpm check');
	});

	it('creates the orphan branch when a repo has no config at all', () => {
		const base = tempDir();
		const a = initRepo(base, 'a', {'f.txt': 'v\n'});
		const result = setStem(a.dir, 'wighawag/jolly-roger');
		expect(result.ok).toBe(true);
		expect(result.created).toBe(true);
		expect(resolveConfig(a.dir).config?.stem).toBe(
			'github:wighawag/jolly-roger',
		);
	});

	it('never touches the working tree, the index or the current branch', () => {
		const base = tempDir();
		const a = initRepo(base, 'a', {'f.txt': 'v\n'});
		const before = git(['rev-parse', 'HEAD'], a.dir).trim();

		setStem(a.dir, 'wighawag/jolly-roger');

		expect(git(['rev-parse', 'HEAD'], a.dir).trim()).toBe(before);
		expect(git(['status', '--porcelain'], a.dir).trim()).toBe('');
		expect(git(['branch', '--show-current'], a.dir).trim()).toBe('main');
	});

	it('is a no-op when the field already says the same thing', () => {
		const base = tempDir();
		const a = initRepo(base, 'a', {'f.txt': 'v\n'});
		setStem(a.dir, 'wighawag/jolly-roger');
		const second = setStem(a.dir, 'github:wighawag/jolly-roger');
		expect(second.ok).toBe(true);
		expect(second.commit).toBeNull();
		expect(second.message).toMatch(/nothing to do/);
	});

	it('records a root as null, which is a statement and not a gap', () => {
		const base = tempDir();
		const a = initRepo(base, 'a', {'f.txt': 'v\n'});
		expect(setStem(a.dir, null).ok).toBe(true);
		const config = resolveConfig(a.dir).config!;
		expect('stem' in config).toBe(true);
		expect(config.stem).toBeNull();
	});

	it('refuses to write a stem that would not travel', () => {
		const base = tempDir();
		const a = initRepo(base, 'a', {'f.txt': 'v\n'});
		const result = setStem(a.dir, '/home/me/dev/parent');
		expect(result.ok).toBe(false);
		expect(result.message).toMatch(/local path/);
		expect(resolveConfig(a.dir).source).toBe('none');
	});

	it('leaves an unrelated file on the config branch alone', () => {
		// The config branch holds exactly one file today, so this pins the shape
		// rather than silently dropping anything a future version adds.
		const base = tempDir();
		const a = initRepo(base, 'a', {'f.txt': 'v\n'});
		writeConfigBranch(a.dir, JSON.stringify({branches: {main: {}}}));
		setStem(a.dir, 'wighawag/parent');
		const files = git(
			['ls-tree', '--name-only', DEFAULT_CONFIG_BRANCH],
			a.dir,
		).trim();
		expect(files).toBe(CONFIG_FILE);
	});
});
