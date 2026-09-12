/**
 * Turning "these repos share a commit" into "this is the tree".
 *
 * Shared history is a weak signal: on the real 10-repo tree, the family's root
 * commit is also carried by a bug reproduction, a stranger's copy and a repo
 * nobody maintains any more. So membership is decided by the STATED `stem`
 * field, and everything else is discarded with a reason rather than adopted.
 */

import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {classifyMembers, descendantsOf, resolveToken} from '../src/index.js';
import type {TreeMember} from '../src/index.js';

/** A fake host: repo full name -> raw config text (or null for "no config"). */
function reader(configs: Record<string, string | null>) {
	return async (fullName: string): Promise<string | null> =>
		configs[fullName] ?? null;
}

const stem = (parent: string) => JSON.stringify({stem: parent});

function byName(members: TreeMember[]): Record<string, TreeMember> {
	return Object.fromEntries(members.map((m) => [m.fullName, m]));
}

describe('descendantsOf', () => {
	// The whole family shares the root commit, so discovery from ANY member sees
	// all of them. Asking for a subtree must not quietly clone the family.
	const family = async () =>
		(
			await classifyMembers(
				'wighawag/template-svelte',
				[
					'wighawag/template-svelte',
					'wighawag/template-svelte-tailwind',
					'wighawag/blog',
					'wighawag/jolly-roger',
					'wighawag/bleeps',
				],
				reader({
					'wighawag/template-svelte': JSON.stringify({stem: null}),
					'wighawag/template-svelte-tailwind': stem('wighawag/template-svelte'),
					'wighawag/blog': stem('wighawag/template-svelte-tailwind'),
					'wighawag/jolly-roger': stem('wighawag/template-svelte-tailwind'),
					'wighawag/bleeps': stem('wighawag/jolly-roger'),
				}),
			)
		).members;

	it('takes the whole tree from the true root', async () => {
		expect(descendantsOf('wighawag/template-svelte', await family()).size).toBe(
			5,
		);
	});

	it('excludes ancestors and siblings when a subtree is requested', async () => {
		const members = await family();
		// Re-root: jolly-roger is the request, so its parent and its parent's other
		// child are family, not subtree.
		const reachable = descendantsOf('wighawag/jolly-roger', members);
		expect([...reachable].sort()).toEqual([
			'wighawag/bleeps',
			'wighawag/jolly-roger',
		]);
		expect(reachable.has('wighawag/blog')).toBe(false);
		expect(reachable.has('wighawag/template-svelte-tailwind')).toBe(false);
	});

	it('terminates on a cycle rather than spinning', async () => {
		const {members} = await classifyMembers(
			'wighawag/a',
			['wighawag/a', 'wighawag/b', 'wighawag/c'],
			reader({
				'wighawag/a': stem('wighawag/c'),
				'wighawag/b': stem('wighawag/a'),
				'wighawag/c': stem('wighawag/b'),
			}),
		);
		expect([...descendantsOf('wighawag/a', members)].sort()).toEqual([
			'wighawag/a',
			'wighawag/b',
			'wighawag/c',
		]);
	});
});

describe('resolveToken', () => {
	const saved = {
		GITHUB_TOKEN: process.env.GITHUB_TOKEN,
		GH_TOKEN: process.env.GH_TOKEN,
		PATH: process.env.PATH,
	};

	beforeEach(() => {
		delete process.env.GITHUB_TOKEN;
		delete process.env.GH_TOKEN;
	});

	afterEach(() => {
		for (const [k, v] of Object.entries(saved)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	});

	it('prefers an explicit token over everything else', () => {
		process.env.GITHUB_TOKEN = 'from-env';
		expect(resolveToken('explicit')).toEqual({
			token: 'explicit',
			source: 'option',
		});
	});

	it('reads the environment, GITHUB_TOKEN first', () => {
		process.env.GH_TOKEN = 'gh-env';
		expect(resolveToken().source).toBe('env:GH_TOKEN');
		process.env.GITHUB_TOKEN = 'github-env';
		expect(resolveToken()).toEqual({
			token: 'github-env',
			source: 'env:GITHUB_TOKEN',
		});
	});

	it('reports no credential rather than pretending, when nothing supplies one', () => {
		// No `gh` on PATH: the case that silently halves a tree with private members.
		process.env.PATH = '/nonexistent';
		expect(resolveToken()).toEqual({token: null, source: 'none'});
	});
});

describe('classifyMembers', () => {
	it('builds the real tree from stated edges', async () => {
		const {members, dangling} = await classifyMembers(
			'wighawag/template-svelte',
			[
				'wighawag/template-svelte',
				'wighawag/template-svelte-tailwind',
				'wighawag/jolly-roger',
				'wighawag/bleeps',
			],
			reader({
				'wighawag/template-svelte': JSON.stringify({stem: null}),
				'wighawag/template-svelte-tailwind': stem('wighawag/template-svelte'),
				'wighawag/jolly-roger': stem(
					'github:wighawag/template-svelte-tailwind',
				),
				'wighawag/bleeps': stem('git@github.com:wighawag/jolly-roger.git'),
			}),
		);

		const m = byName(members);
		expect(m['wighawag/template-svelte']!.status).toBe('root');
		expect(m['wighawag/jolly-roger']!.stem).toBe(
			'github:wighawag/template-svelte-tailwind',
		);
		// However the edge was spelled, it resolves to the same parent.
		expect(m['wighawag/bleeps']!.stem).toBe('github:wighawag/jolly-roger');
		expect(dangling).toEqual([]);
	});

	it('discards a repo that shares history but never opted in', async () => {
		const {members} = await classifyMembers(
			'wighawag/template-svelte',
			['wighawag/template-svelte', 'bug-reproduction/tevm-test'],
			reader({'wighawag/template-svelte': JSON.stringify({stem: null})}),
		);
		const other = byName(members)['bug-reproduction/tevm-test']!;
		expect(other.status).toBe('unannotated');
		expect(other.reason).toMatch(/not maintained as part of this tree/);
	});

	it('discards a repo with a config but no stem field, without erroring', async () => {
		// This is every tree that exists today: config is old, the field is new.
		const {members} = await classifyMembers(
			'wighawag/template-svelte',
			['wighawag/template-svelte', 'wighawag/legacy'],
			reader({
				'wighawag/template-svelte': JSON.stringify({stem: null}),
				'wighawag/legacy': JSON.stringify({branches: {main: {}}}),
			}),
		);
		const legacy = byName(members)['wighawag/legacy']!;
		expect(legacy.status).toBe('unannotated');
		expect(legacy.reason).toMatch(/no `stem` field/);
	});

	it('treats another declared root as a different family, not a child', async () => {
		const {members} = await classifyMembers(
			'wighawag/template-svelte',
			['wighawag/template-svelte', '0xronan7/template-onchain-app'],
			reader({
				'wighawag/template-svelte': JSON.stringify({stem: null}),
				'0xronan7/template-onchain-app': JSON.stringify({stem: null}),
			}),
		);
		expect(byName(members)['0xronan7/template-onchain-app']!.status).toBe(
			'foreign-root',
		);
	});

	it('keeps a descendant under a different owner, because the edge says so', async () => {
		const {members} = await classifyMembers(
			'wighawag/template-svelte',
			['wighawag/template-svelte', 'someone-else/my-app'],
			reader({
				'wighawag/template-svelte': JSON.stringify({stem: null}),
				'someone-else/my-app': stem('wighawag/template-svelte'),
			}),
		);
		expect(byName(members)['someone-else/my-app']!.status).toBe('member');
	});

	it('reports an edge whose parent was not found, instead of dropping it', async () => {
		const {members, dangling} = await classifyMembers(
			'wighawag/template-svelte',
			['wighawag/template-svelte', 'wighawag/orphan'],
			reader({
				'wighawag/template-svelte': JSON.stringify({stem: null}),
				'wighawag/orphan': stem('wighawag/private-intermediate'),
			}),
		);
		expect(byName(members)['wighawag/orphan']!.status).toBe('member');
		expect(dangling).toEqual([
			{repo: 'wighawag/orphan', stem: 'github:wighawag/private-intermediate'},
		]);
	});

	it('reports an unreadable config rather than silently skipping the repo', async () => {
		const {members} = await classifyMembers(
			'wighawag/template-svelte',
			['wighawag/template-svelte', 'wighawag/broken', 'wighawag/exploded'],
			async (fullName) => {
				if (fullName === 'wighawag/exploded') throw new Error('HTTP 500');
				if (fullName === 'wighawag/broken') return '{not json';
				return JSON.stringify({stem: null});
			},
		);
		const m = byName(members);
		expect(m['wighawag/broken']!.status).toBe('unreadable');
		expect(m['wighawag/broken']!.reason).toMatch(/not valid JSON/);
		expect(m['wighawag/exploded']!.status).toBe('unreadable');
		expect(m['wighawag/exploded']!.reason).toMatch(/HTTP 500/);
	});

	it('rejects a stem that cannot travel, rather than importing it', async () => {
		const {members} = await classifyMembers(
			'wighawag/template-svelte',
			['wighawag/template-svelte', 'wighawag/local-wired'],
			reader({
				'wighawag/template-svelte': JSON.stringify({stem: null}),
				'wighawag/local-wired': stem('/home/someone/dev/template-svelte'),
			}),
		);
		const bad = byName(members)['wighawag/local-wired']!;
		expect(bad.status).toBe('unreadable');
		expect(bad.reason).toMatch(/local path/);
	});

	it('includes the requested root even when the host search missed it', async () => {
		// Search indexes default branches; the root must be present regardless.
		const {members} = await classifyMembers(
			'wighawag/template-svelte',
			[],
			reader({'wighawag/template-svelte': JSON.stringify({stem: null})}),
		);
		expect(members).toHaveLength(1);
		expect(members[0]!.status).toBe('root');
	});

	it('accepts a root that has no config at all', async () => {
		// The root is identified by the request, not by an annotation, so a tree
		// can be reconstructed before the root itself has been annotated.
		const {members} = await classifyMembers(
			'wighawag/template-svelte',
			['wighawag/template-svelte', 'wighawag/child'],
			reader({'wighawag/child': stem('wighawag/template-svelte')}),
		);
		const m = byName(members);
		expect(m['wighawag/template-svelte']!.status).toBe('root');
		expect(m['wighawag/child']!.status).toBe('member');
	});

	it('does not follow the root upward, even if it stems from somewhere', async () => {
		// Asking for a subtree gives that subtree: the root's own parent is not
		// pulled in, or `clone jolly-roger` would drag the whole template chain.
		const {members} = await classifyMembers(
			'wighawag/jolly-roger',
			['wighawag/jolly-roger', 'wighawag/bleeps'],
			reader({
				'wighawag/jolly-roger': stem('wighawag/template-svelte-shadcn'),
				'wighawag/bleeps': stem('wighawag/jolly-roger'),
			}),
		);
		const m = byName(members);
		expect(m['wighawag/jolly-roger']!.status).toBe('root');
		expect(m['wighawag/jolly-roger']!.stem).toBeNull();
		expect(m['wighawag/bleeps']!.status).toBe('member');
	});
});
