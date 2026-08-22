/**
 * A cross-repo edge has a branch at BOTH ends.
 *
 * The child already says which of its branches receives an update (its root
 * branches). Until `stemBranch` it could not say which branch of the PARENT
 * feeds them, so every child hung off the parent's primary and a repo built on
 * a VARIANT of its parent was wired to the wrong parent by construction.
 *
 * Observed on a live tree: a site built on `with/local-signer`, merged from
 * `main`, reported 13 conflicted files where its real parent gives 3. The ten
 * extra were exactly the files that differ between the two branches, so the
 * ordinary resolution of them reverts the site off the variant it is built on,
 * in files that still compile. That is why an unmatched `stemBranch` is
 * reported loudly rather than falling back to the primary.
 */

import {afterEach, describe, expect, it} from 'vitest';
import {propagate, formatReport} from '../src/index.js';
import {
	cleanupTempDirs,
	commit,
	fileOnBranch,
	git,
	initRepo,
	setRemote,
	tempDir,
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

/**
 * A parent holding a variant branch, and a child built on that variant.
 * Mirrors jolly-roger -> template-commit-reveal.
 */
function treeWithVariant(declareStemBranch: string | null) {
	const base = tempDir();
	const parent = initRepo(base, 'parent', {'shared.txt': 'v1\n'});
	setRemote(parent.dir, 'origin', url('parent'));

	// the parent's variant adds something `main` does not have
	git(['checkout', '-b', 'with/variant'], parent.dir);
	writeFile(parent.dir, 'variant-only.txt', 'from the variant\n');
	commit(parent.dir, 'variant feature');
	git(['checkout', 'main'], parent.dir);

	writeConfigBranch(
		parent.dir,
		JSON.stringify({branches: {main: {}, 'with/variant': {stem: 'main'}}}),
	);

	// the child is cloned FROM the variant, so it carries the variant's file
	const child = cloneChild(base, parent.dir, 'child', url('parent'));
	// cloneChild replaces `origin`, and removing a remote deletes its tracking
	// refs, so fetch the variant from the parent path rather than naming
	// `origin/with/variant`.
	git(['fetch', parent.dir, 'with/variant'], child);
	git(['reset', '--hard', 'FETCH_HEAD'], child);
	writeFile(child, 'child.txt', 'child work\n');
	commit(child, 'child work');

	if (declareStemBranch !== null) {
		writeConfigBranch(
			child,
			JSON.stringify({branches: {main: {stemBranch: declareStemBranch}}}),
		);
	}
	return {base, parent, child};
}

describe('stemBranch: which branch of the parent feeds a child repo', () => {
	it('feeds the child from the named parent branch, not the primary', async () => {
		const {base, parent, child} = treeWithVariant('with/variant');

		// a change on the variant only
		git(['checkout', 'with/variant'], parent.dir);
		writeFile(parent.dir, 'variant-only.txt', 'from the variant, v2\n');
		commit(parent.dir, 'variant change');
		git(['checkout', 'main'], parent.dir);

		const result = await propagate({sourcePath: parent.dir, baseDir: base});
		const report = formatReport(result, {color: false});

		expect(report).toContain('✓ child@main merged');
		// the child received the VARIANT's change, which main does not carry
		expect(fileOnBranch(child, 'main', 'variant-only.txt')).toBe(
			'from the variant, v2\n',
		);
	});

	it('still carries a change made on the parent primary, through the variant', async () => {
		const {base, parent, child} = treeWithVariant('with/variant');

		writeFile(parent.dir, 'shared.txt', 'v2\n');
		commit(parent.dir, 'change on primary');

		const result = await propagate({sourcePath: parent.dir, baseDir: base});
		expect(formatReport(result, {color: false})).toContain(
			'✓ child@main merged',
		);
		// main -> with/variant -> child, in one pass
		expect(fileOnBranch(child, 'main', 'shared.txt')).toBe('v2\n');
	});

	it('without it, the child is fed from the primary and loses the variant', async () => {
		// The behaviour this key exists to correct, pinned so it cannot come back
		// by accident.
		const {base, parent, child} = treeWithVariant(null);

		git(['checkout', 'with/variant'], parent.dir);
		writeFile(parent.dir, 'variant-only.txt', 'from the variant, v2\n');
		commit(parent.dir, 'variant change');
		git(['checkout', 'main'], parent.dir);

		await propagate({sourcePath: parent.dir, baseDir: base});

		// fed from `main`, so the variant's change never arrives
		expect(fileOnBranch(child, 'main', 'variant-only.txt')).toBe(
			'from the variant\n',
		);
	});

	it('reports a stemBranch that names no participating parent branch', async () => {
		const {base, parent} = treeWithVariant('with/typo');

		writeFile(parent.dir, 'shared.txt', 'v2\n');
		commit(parent.dir, 'change');

		const result = await propagate({sourcePath: parent.dir, baseDir: base});
		const report = formatReport(result, {color: false});

		// Named out loud rather than silently absent from the tree.
		expect(report).toContain('with/typo');
		expect(report).toContain('NOT in this cascade');
		// and it really is not merged
		expect(report).not.toContain('✓ child@main merged');
	});

	it('rejects a branch that sets both stem and stemBranch', async () => {
		const {base, parent, child} = treeWithVariant(null);
		writeConfigBranch(
			child,
			JSON.stringify({
				branches: {
					main: {},
					other: {stem: 'main', stemBranch: 'with/variant'},
				},
			}),
		);

		writeFile(parent.dir, 'shared.txt', 'v2\n');
		commit(parent.dir, 'change');

		const result = await propagate({sourcePath: parent.dir, baseDir: base});
		const report = formatReport(result, {color: false});
		expect(report).toMatch(/both .*stem.* and .*stemBranch/);
	});
});
