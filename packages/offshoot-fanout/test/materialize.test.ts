/**
 * A clone is not a tree until it has the branches its config names.
 *
 * `git clone` creates ONE local branch, so every other node of a repo comes back
 * as a remote-tracking ref the cascade cannot merge into. Measured on the live
 * 11-repo tree: a fresh `clone` followed immediately by `offshoot-fanout
 * --dry-run` reported
 *
 *   ✗ template-commit-reveal@with/pixi-js  CONFLICT — conflict in 0 file(s) merging main
 *   ⊘ template-commit-reveal@with/all      skipped — parent not updated (conflict)
 *   ⊘ reveal-or-die@main                   skipped — parent not updated (skipped)
 *
 * for a tree with nothing wrong with it. "conflict in 0 file(s)" is what an
 * absent ref looks like from inside the cascade, because `git merge-tree` exits
 * 1 both for a real conflict and for "not something we can merge". The last test
 * here is that whole failure, reproduced and then fixed, at three repos.
 */

import {afterEach, describe, expect, it} from 'vitest';
import {
	classifyMembers,
	formatBranchLines,
	materializeBranches,
	propagate,
} from '../src/index.js';
import type {
	BranchOutcome,
	CloneAction,
	CloneOutcome,
	PropagateResult,
} from '../src/index.js';
import {mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {isGitRepo, isRepoRoot} from '../src/git.js';
import {
	branchSha,
	cleanupTempDirs,
	commit,
	git,
	initRepo,
	setRemote,
	tempDir,
	writeConfigBranch,
	writeFile,
} from './helpers.js';

afterEach(cleanupTempDirs);

function byBranch(outcomes: BranchOutcome[]): Record<string, BranchOutcome> {
	return Object.fromEntries(outcomes.map((o) => [o.branch, o]));
}

/** Every node of a report, not just the source's direct children. */
function allNodes(result: PropagateResult): PropagateResult[] {
	return result.children.flatMap((c) => [c, ...allNodes(c)]);
}

function localBranches(dir: string): string[] {
	return git(['for-each-ref', '--format=%(refname:short)', 'refs/heads'], dir)
		.split('\n')
		.map((l) => l.trim())
		.filter(Boolean)
		.sort();
}

/**
 * An "origin" holding the branch set a live repo has: two declared variants, a
 * config branch, and a scratch branch no config mentions.
 */
function originRepo(base: string, name = 'child'): string {
	const repo = initRepo(base, name, {'file.txt': 'v1\n'});
	for (const branch of ['with/pixi-js', 'with/all', 'work'])
		git(['branch', branch], repo.dir);
	writeConfigBranch(
		repo.dir,
		JSON.stringify({
			stem: 'github:test/parent',
			branches: {
				main: {},
				'with/pixi-js': {stem: 'main'},
				'with/all': {stem: 'with/pixi-js'},
			},
		}),
	);
	return repo.dir;
}

/** What `clone` leaves behind: one local branch, every other ref remote-only. */
function freshClone(base: string, src: string, name = 'clone'): string {
	git(['clone', src, name], base);
	return `${base}/${name}`;
}

describe('classifyMembers keeps the branch list it already parsed', () => {
	it('records the declared branches in declaration order', async () => {
		const {members} = await classifyMembers(
			'test/root',
			['test/root', 'test/child'],
			async (fullName) =>
				fullName === 'test/root'
					? JSON.stringify({stem: null})
					: JSON.stringify({
							stem: 'test/root',
							branches: {
								main: {},
								'with/pixi-js': {stem: 'main'},
								'with/all': {stem: 'with/pixi-js'},
							},
						}),
		);
		const child = members.find((m) => m.fullName === 'test/child')!;
		// Declaration order, not sorted: it is the order the config states.
		expect(child.branches).toEqual(['main', 'with/pixi-js', 'with/all']);
	});

	it('is empty for a config that declares no branches', async () => {
		const {members} = await classifyMembers(
			'test/root',
			['test/root'],
			async () => JSON.stringify({stem: null, verify: 'pnpm test'}),
		);
		expect(members[0]!.branches).toEqual([]);
	});

	it('costs the repo its branch list, not the reconstruction, when `branches` is malformed', async () => {
		// This parse is a bare JSON.parse of text fetched from the host, not the
		// validated local read, so a wrong-typed `branches` must not throw.
		const {members} = await classifyMembers(
			'test/root',
			['test/root', 'test/child'],
			async (fullName) =>
				fullName === 'test/root'
					? JSON.stringify({stem: null})
					: JSON.stringify({stem: 'test/root', branches: ['main']}),
		);
		const child = members.find((m) => m.fullName === 'test/child')!;
		expect(child.status).toBe('member');
		expect(child.branches).toEqual([]);
	});
});

describe('materializeBranches', () => {
	it('creates a local tracking branch for every branch the config names', () => {
		const base = tempDir();
		const origin = originRepo(base);
		const clone = freshClone(base, origin);

		expect(localBranches(clone)).toEqual(['main']);

		const outcomes = materializeBranches(
			clone,
			['main', 'with/pixi-js', 'with/all'],
			{configBranch: 'offshoot'},
		);

		expect(localBranches(clone)).toEqual([
			'main',
			'offshoot',
			'with/all',
			'with/pixi-js',
		]);
		const o = byBranch(outcomes);
		expect(o['with/pixi-js']!.action).toBe('created');
		expect(o['with/all']!.action).toBe('created');
		// `main` is already there from the clone; it is reported, not re-made.
		expect(o.main!.action).toBe('existing');
		// The branch really tracks origin, so `git pull` in it does the right thing.
		// Both halves, or the assertion does not cover the claim.
		expect(git(['config', 'branch.with/pixi-js.remote'], clone).trim()).toBe(
			'origin',
		);
		expect(git(['config', 'branch.with/pixi-js.merge'], clone).trim()).toBe(
			'refs/heads/with/pixi-js',
		);
	});

	it('never touches the working tree, the index or HEAD', () => {
		// This is what makes it safe to run on a machine with work in progress, and
		// it was only ever implied.
		const base = tempDir();
		const origin = originRepo(base);
		const clone = freshClone(base, origin);
		writeFile(clone, 'scratch.txt', 'uncommitted\n');

		materializeBranches(clone, ['main', 'with/pixi-js', 'with/all'], {
			configBranch: 'offshoot',
			fresh: true,
		});

		expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], clone).trim()).toBe(
			'main',
		);
		expect(git(['status', '--porcelain'], clone).trim()).toBe('?? scratch.txt');
	});

	it('leaves a branch no config names as a remote-tracking ref', () => {
		// `branches` exists to keep scratch branches out of the cascade WITHOUT
		// naming them, so materialising `work` would undo the point of the field.
		// `tooling` is the same case: a maintainer's local cache of the stem's
		// orphan branch, in no config, and not clone's to invent.
		const base = tempDir();
		const origin = originRepo(base);
		const clone = freshClone(base, origin);

		materializeBranches(clone, ['main', 'with/pixi-js'], {
			configBranch: 'offshoot',
		});

		expect(localBranches(clone)).not.toContain('work');
		expect(git(['rev-parse', '--verify', 'origin/work'], clone).trim()).toMatch(
			/^[0-9a-f]{40}$/,
		);
	});

	it('reports a named branch that origin does not have, instead of thinning silently', () => {
		const base = tempDir();
		const origin = originRepo(base);
		const clone = freshClone(base, origin);

		const outcomes = materializeBranches(
			clone,
			['main', 'with/pixi-js', 'with/never-pushed'],
			{configBranch: 'offshoot', fresh: true},
		);

		const missing = byBranch(outcomes)['with/never-pushed']!;
		expect(missing.action).toBe('missing');
		expect(missing.message).toMatch(/absent from origin/);
		// The rest still lands: one bad entry does not cost the repo its tree.
		expect(localBranches(clone)).toContain('with/pixi-js');
	});

	it('does not claim origin lacks a branch when origin was never asked', () => {
		// `origin/*` in an existing clone is as of its last fetch, while the config
		// naming the branch is read live from the host. Asserting "absent from
		// origin" from a stale cache turns "the maintainer pushed a branch and you
		// are syncing" into a hard failure. Reproduced: origin really does have it.
		const base = tempDir();
		const origin = originRepo(base);
		const clone = freshClone(base, origin);
		git(['branch', 'with/pushed-later'], origin);

		const stale = byBranch(
			materializeBranches(clone, ['with/pushed-later'], {fresh: false}),
		)['with/pushed-later']!;
		expect(stale.action).toBe('missing');
		expect(stale.message).toMatch(/did not refresh/);
		expect(stale.message).toMatch(/git fetch origin/);

		// And once the refs ARE current, it is simply created.
		git(['fetch', '--quiet', 'origin'], clone);
		expect(
			materializeBranches(clone, ['with/pushed-later'], {fresh: true})[0]!
				.action,
		).toBe('created');
	});

	it('reads origin/<branch> as a remote ref, not as whatever that name resolves to', () => {
		// `origin/x` as a rev is a DWIM lookup and a LOCAL branch called `origin/x`
		// is legal, so the unqualified form would report a branch as present on
		// origin and then create it from the wrong commit.
		const base = tempDir();
		const origin = originRepo(base);
		const clone = freshClone(base, origin);
		writeFile(clone, 'decoy.txt', 'decoy\n');
		commit(clone, 'decoy commit');
		git(['branch', 'origin/with/never-pushed'], clone);
		git(['reset', '--hard', 'HEAD~1'], clone);

		const o = byBranch(
			materializeBranches(clone, ['with/never-pushed'], {fresh: true}),
		);
		expect(o['with/never-pushed']!.action).toBe('missing');
		expect(localBranches(clone)).not.toContain('with/never-pushed');
	});

	it('refuses a branch name git would read as an option', () => {
		// The name arrives as JSON from a third-party repo's config branch and ends
		// up in argv.
		const base = tempDir();
		const origin = originRepo(base);
		const clone = freshClone(base, origin);

		const o = byBranch(
			materializeBranches(clone, ['--upload-pack=touch /tmp/pwned'], {
				fresh: true,
			}),
		)['--upload-pack=touch /tmp/pwned']!;
		expect(o.action).toBe('failed');
		expect(o.message).toMatch(/reads as an option/);
	});

	it('never moves a local branch that is already there', () => {
		const base = tempDir();
		const origin = originRepo(base);
		const clone = freshClone(base, origin);

		// Work in progress on a branch the config names, diverged from origin.
		git(['checkout', '-b', 'with/pixi-js', 'origin/with/pixi-js'], clone);
		writeFile(clone, 'wip.txt', 'in progress\n');
		commit(clone, 'wip');
		git(['checkout', 'main'], clone);
		const before = branchSha(clone, 'with/pixi-js');

		const outcomes = materializeBranches(clone, ['main', 'with/pixi-js'], {
			configBranch: 'offshoot',
		});

		expect(byBranch(outcomes)['with/pixi-js']!.action).toBe('existing');
		expect(branchSha(clone, 'with/pixi-js')).toBe(before);
	});

	it('is idempotent: a second run creates nothing and reports everything existing', () => {
		const base = tempDir();
		const origin = originRepo(base);
		const clone = freshClone(base, origin);
		const declared = ['main', 'with/pixi-js', 'with/all'];

		materializeBranches(clone, declared, {configBranch: 'offshoot'});
		const again = materializeBranches(clone, declared, {
			configBranch: 'offshoot',
		});

		expect(again.every((o) => o.action === 'existing')).toBe(true);
	});

	it('creates the config branch too, so `config stem` cannot start a second history', () => {
		// Without a local `offshoot`, setStem finds no parent ref, commits a
		// PARENTLESS config commit, says "created", and prints a push command that
		// origin rejects as non-fast-forward. Measured on a real clone.
		const base = tempDir();
		const origin = originRepo(base);
		const clone = freshClone(base, origin);

		materializeBranches(clone, ['main'], {configBranch: 'offshoot'});

		expect(localBranches(clone)).toContain('offshoot');
		expect(branchSha(clone, 'offshoot')).toBe(
			branchSha(clone, 'origin/offshoot'),
		);
	});

	it('fast-forwards a stale config branch, because a stale one changes the node set', () => {
		// A local `offshoot` outranks `origin/offshoot` in resolveConfig, so once it
		// exists it is the config, and never updating it means a machine keeps
		// fanning out the branch set as of the day it first cloned.
		const base = tempDir();
		const origin = originRepo(base);
		const clone = freshClone(base, origin);
		materializeBranches(clone, ['main'], {configBranch: 'offshoot'});

		// The maintainer publishes a new config; the clone fetches it.
		writeConfigBranch(
			origin,
			JSON.stringify({stem: 'github:test/parent', branches: {main: {}}}),
		);
		git(['fetch', '--quiet', 'origin'], clone);

		const o = byBranch(
			materializeBranches(clone, ['main'], {
				configBranch: 'offshoot',
				fresh: true,
			}),
		).offshoot!;
		expect(o.action).toBe('updated');
		expect(branchSha(clone, 'offshoot')).toBe(
			branchSha(clone, 'origin/offshoot'),
		);
	});

	it('reports a diverged config branch instead of resolving it', () => {
		// Local edits pending a push are the normal output of `config stem`; they
		// must not be thrown away, but they do mean the config read here is not the
		// published one.
		const base = tempDir();
		const origin = originRepo(base);
		const clone = freshClone(base, origin);
		materializeBranches(clone, ['main'], {configBranch: 'offshoot'});
		const before = branchSha(clone, 'offshoot');

		// Both sides move independently.
		writeConfigBranch(clone, JSON.stringify({stem: 'github:test/local'}));
		writeConfigBranch(origin, JSON.stringify({stem: 'github:test/remote'}));
		git(['fetch', '--quiet', 'origin'], clone);
		const local = branchSha(clone, 'offshoot');
		expect(local).not.toBe(before);

		const o = byBranch(
			materializeBranches(clone, ['main'], {
				configBranch: 'offshoot',
				fresh: true,
			}),
		).offshoot!;
		expect(o.action).toBe('existing');
		expect(o.message).toMatch(/diverged/);
		expect(branchSha(clone, 'offshoot')).toBe(local);
	});

	it('does not report an absent config branch: a repo legitimately has none', () => {
		const base = tempDir();
		const plain = initRepo(base, 'plain', {'file.txt': 'v1\n'});
		const clone = freshClone(base, plain.dir);

		const outcomes = materializeBranches(clone, ['main'], {
			configBranch: 'offshoot',
		});

		expect(outcomes.map((o) => o.branch)).toEqual(['main']);
	});

	it('reports without touching anything in a dry run', () => {
		const base = tempDir();
		const origin = originRepo(base);
		const clone = freshClone(base, origin);

		const outcomes = materializeBranches(
			clone,
			['main', 'with/pixi-js', 'with/never-pushed'],
			{configBranch: 'offshoot', dryRun: true, fresh: true},
		);

		expect(localBranches(clone)).toEqual(['main']);
		const o = byBranch(outcomes);
		expect(o['with/pixi-js']!.action).toBe('created');
		// The `missing` case is still detected, which is the reason a dry run
		// against a repo on disk is worth doing at all.
		expect(o['with/never-pushed']!.action).toBe('missing');
	});
});

describe('deciding whether a path already holds a clone', () => {
	it('does not mistake a directory nested in a repo for a clone of it', () => {
		// `--is-inside-work-tree` says yes for any directory under a checkout, so an
		// empty `template-x/` inside one used to be read as a clone of the ENCLOSING
		// repo: its `origin` was inspected and, with no origin to disagree with, a
		// `stem` remote would be wired into the enclosing repo.
		const base = tempDir();
		const outer = initRepo(base, 'outer', {'file.txt': 'v1\n'});
		mkdirSync(join(outer.dir, 'template-x'));

		expect(isGitRepo(join(outer.dir, 'template-x'))).toBe(true);
		expect(isRepoRoot(join(outer.dir, 'template-x'))).toBe(false);
		expect(isRepoRoot(outer.dir)).toBe(true);
		expect(isRepoRoot(join(base, 'never-created'))).toBe(false);
	});
});

describe('the clone report', () => {
	function outcome(
		action: CloneAction,
		declared: string[],
		branches: BranchOutcome[] = [],
	): CloneOutcome {
		return {
			member: {
				fullName: 'test/child',
				name: 'child',
				status: 'member',
				stem: 'github:test/parent',
				reason: null,
				branches: declared,
			},
			dir: '/tmp/child',
			action,
			wired: null,
			message: null,
			branches,
		};
	}

	it('promises branches only for a repo the dry run says it will clone', () => {
		expect(
			formatBranchLines(outcome('cloned', ['main', 'with/all']), {
				dryRun: true,
			}),
		).toEqual(['would create the branch(es) its config names: main, with/all']);
	});

	it('promises nothing for a repo it has just said it will not touch', () => {
		// A skipped repo (a directory that is someone else's clone, or not a repo
		// at all) also has no branch outcomes. Announcing branches for it is the
		// dry-run-contradicts-the-real-run bug, one level up in the reporter.
		for (const action of ['skipped', 'failed', 'existing'] as CloneAction[]) {
			expect(
				formatBranchLines(outcome(action, ['main', 'with/all']), {
					dryRun: true,
				}),
			).toEqual([]);
		}
	});

	it('says nothing at all when branch materialising is off', () => {
		expect(
			formatBranchLines(
				outcome(
					'cloned',
					['main', 'with/all'],
					[{branch: 'with/all', action: 'created', message: null}],
				),
				{enabled: false},
			),
		).toEqual([]);
	});

	it('surfaces every message, not only the ones that fail the run', () => {
		expect(
			formatBranchLines(
				outcome(
					'existing',
					['main'],
					[
						{branch: 'main', action: 'existing', message: null},
						{
							branch: 'with/all',
							action: 'missing',
							message: 'absent from origin',
						},
						{branch: 'offshoot', action: 'existing', message: 'has diverged'},
					],
				),
			),
		).toEqual([
			'! `with/all` — absent from origin',
			'! `offshoot` — has diverged',
		]);
	});

	it('reports created and fast-forwarded separately', () => {
		expect(
			formatBranchLines(
				outcome(
					'existing',
					['main'],
					[
						{branch: 'with/all', action: 'created', message: null},
						{branch: 'offshoot', action: 'updated', message: null},
					],
				),
			),
		).toEqual([
			'created 1 branch(es): with/all',
			'fast-forwarded to origin: offshoot',
		]);
	});
});

describe('the cascade on a fresh clone', () => {
	/**
	 * parent -> child(main -> with/pixi-js -> with/all) -> grandchild, all as
	 * fresh clones, which is the shape `clone` hands back.
	 */
	function tree(base: string): {parent: string; child: string} {
		const parent = initRepo(base, 'parent', {'file.txt': 'v1\n'});
		setRemote(parent.dir, 'origin', 'https://github.com/test/parent.git');

		// The child's origin, as it lives on the host: descended from the parent
		// (so a merge base exists), every branch pushed, config on its own branch.
		git(['clone', '--quiet', parent.dir, 'child-origin'], base);
		const childOrigin = `${base}/child-origin`;
		git(['branch', 'with/pixi-js'], childOrigin);
		git(['branch', 'with/all'], childOrigin);
		git(['branch', 'work'], childOrigin);
		writeConfigBranch(
			childOrigin,
			JSON.stringify({
				stem: 'github:test/parent',
				branches: {
					main: {},
					'with/pixi-js': {stem: 'main'},
					'with/all': {stem: 'with/pixi-js'},
				},
			}),
		);

		// Exactly what `clone` hands back: a plain clone, `origin` at the host URL,
		// `stem` wired, one local branch, every other ref remote-tracking only.
		git(['clone', '--quiet', childOrigin, 'child'], base);
		const child = `${base}/child`;
		setRemote(child, 'origin', 'https://github.com/test/child.git');
		setRemote(child, 'stem', 'https://github.com/test/parent.git');
		return {parent: parent.dir, child};
	}

	it('names the missing branch instead of calling it a conflict', async () => {
		const base = tempDir();
		const {parent, child} = tree(base);
		expect(localBranches(child)).toEqual(['main']);

		const nodes = allNodes(
			await propagate({sourcePath: parent, repos: [child], dryRun: true}),
		);

		// This used to report `conflict in 0 file(s)`, because `git merge-tree`
		// exits 1 for a missing ref exactly as it does for a real conflict.
		expect(nodes.filter((c) => c.status === 'conflict')).toEqual([]);
		const broken = nodes.filter((c) => c.status === 'error');
		expect(broken.map((c) => c.branch)).toEqual(['with/pixi-js']);
		expect(broken[0]!.message).toMatch(/no local branch `with\/pixi-js`/);
		expect(broken[0]!.message).toMatch(/git branch --track/);
		// And everything under it is still blocked, not merged against stale state.
		expect(nodes.find((c) => c.branch === 'with/all')!.status).toBe('skipped');
	});

	it('says the same thing in a real run as in a dry run', async () => {
		// The whole point of --dry-run is that it predicts the real run, so the two
		// disagreeing about a node is worse than either being wrong alone.
		const base = tempDir();
		const {parent, child} = tree(base);

		const dry = allNodes(
			await propagate({sourcePath: parent, repos: [child], dryRun: true}),
		).map((c) => `${c.branch}: ${c.status}`);
		const real = allNodes(
			await propagate({sourcePath: parent, repos: [child]}),
		).map((c) => `${c.branch}: ${c.status}`);

		expect(real).toEqual(dry);
		expect(real).toContain('with/pixi-js: error');
	});

	it('is up to date on every node once the branches are materialised', async () => {
		const base = tempDir();
		const {parent, child} = tree(base);

		materializeBranches(child, ['main', 'with/pixi-js', 'with/all'], {
			configBranch: 'offshoot',
		});

		const nodes = allNodes(
			await propagate({sourcePath: parent, repos: [child], dryRun: true}),
		);

		expect(nodes.map((c) => c.branch).sort()).toEqual([
			'main',
			'with/all',
			'with/pixi-js',
		]);
		expect(nodes.map((c) => `${c.branch}: ${c.status}`)).toEqual([
			'main: up-to-date',
			'with/pixi-js: up-to-date',
			'with/all: up-to-date',
		]);
	});
});
