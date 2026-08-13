import {describe, it, expect} from 'vitest';
import {buildTree, childrenOf, type Repo} from '../src/core.js';

// Hierarchy:
//   a (root template)
//   ├─ b ── d
//   └─ c
const repos: Repo[] = [
	{
		name: 'a',
		path: '/a',
		originUrl: 'git@github.com:me/a.git',
		originalUrl: null,
	},
	{
		name: 'b',
		path: '/b',
		originUrl: 'https://github.com/me/b.git',
		originalUrl: 'git@github.com:me/a.git',
	},
	{
		name: 'c',
		path: '/c',
		originUrl: 'git@github.com:me/c.git',
		originalUrl: 'https://github.com/me/a',
	},
	{
		name: 'd',
		path: '/d',
		originUrl: 'git@github.com:me/d.git',
		originalUrl: 'git@github.com:me/b.git',
	},
];

describe('buildTree / childrenOf', () => {
	it('resolves children across SSH/HTTPS URL variants', () => {
		const tree = buildTree(repos);
		expect(
			childrenOf(repos[0]!, tree)
				.map((r) => r.name)
				.sort(),
		).toEqual(['b', 'c']);
		expect(childrenOf(repos[1]!, tree).map((r) => r.name)).toEqual(['d']);
		expect(childrenOf(repos[2]!, tree)).toEqual([]);
		expect(childrenOf(repos[3]!, tree)).toEqual([]);
	});

	it('does not treat a repo as its own child', () => {
		const self: Repo = {...repos[0]!, originalUrl: repos[0]!.originUrl};
		const tree2 = buildTree([self, ...repos]);
		expect(
			childrenOf(self, tree2)
				.map((r) => r.name)
				.sort(),
		).toEqual(['b', 'c']);
	});
});
