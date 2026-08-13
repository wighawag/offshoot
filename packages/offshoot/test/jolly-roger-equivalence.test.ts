/**
 * ACCEPTANCE TARGET
 *
 *   `offshoot new wighawag/jolly-roger my-app` must produce output equivalent
 *   to today's `create-jolly-roger my-app`, with the same name substitutions
 *   applied.
 *
 * Run against the real template, so the migration is provably non-regressive.
 *
 * Two conclusions this test encodes (both written up in the README, section
 * "Migrating create-jolly-roger"):
 *
 *  1. The generic `rename` strategy covers EVERY pattern in
 *     create-jolly-roger's anchored list, so jolly-roger needs no `patterns`
 *     config. It also fixes one occurrence the anchored list misses.
 *
 *  2. The name "my-app" genuinely collides with the template: jolly-roger
 *     ships SvelteKit's stock `web/README.md`, which contains the literal
 *     string `my-app` ("npx sv create my-app"). The uniqueness gate therefore
 *     fires for that exact name - correctly, since after replacement offshoot
 *     could no longer tell the two apart on a later update. Equivalence is
 *     asserted with `--force` (same name, same substitutions) and separately
 *     on the clean path with a non-colliding name.
 */

import {afterAll, describe, expect, it} from 'vitest';
import {cpSync, readFileSync, existsSync} from 'node:fs';
import {join} from 'node:path';
import {buildTree} from '../src/pipeline.js';
import {loadTemplateConfig, resolveConfig} from '../src/config.js';
import {parseSource, resolveRef, downloadTemplate} from '../src/source.js';
import {readTree} from '../src/vfs.js';
import {scaffold} from '../src/commands/scaffold.js';
import {RoundTripError} from '../src/transforms/rename.js';
import type {VirtualFile} from '../src/types.js';
import {
	buildReplacements,
	processAllFiles,
} from './reference-create-jolly-roger.js';
import {cleanupTempDirs, quietLog, tempDir} from './helpers.js';

afterAll(cleanupTempDirs);

const TEMPLATE = 'wighawag/jolly-roger';
const NAME = 'my-app';
/** A name that does not appear in the template. */
const CLEAN_NAME = 'my-pirate-app';

/**
 * Pinned to a fixed jolly-roger commit rather than live `main`, so upstream
 * evolution of the template can't silently break this equivalence suite (and
 * with it every publish from this monorepo). This SHA predates the `contracts/`
 * delegation library that create-jolly-roger's anchored patterns don't cover;
 * the assertions below describe the template at exactly this commit. To
 * re-verify equivalence against a newer jolly-roger, bump this SHA and update
 * the expected `extra` list to match (offshoot supports any full commit SHA as
 * a ref, same as a branch).
 */
const PINNED_REF = '3890d482dc8a0411be07ff981a2eb878563000d2';

/**
 * The occurrences `offshoot rename` changes that create-jolly-roger's *anchored*
 * pattern list does not, at PINNED_REF. These are places the template name
 * appears that no anchored pattern targets, so create-jolly-roger leaves the
 * template's name behind and `rename` (which rewrites every occurrence) does not:
 * the delegation contracts/tests, plus a log path in the e2e script. This list
 * is expected to grow as the template gains more code containing its own name;
 * regenerate it when bumping PINNED_REF. (`differences` staying empty is the
 * stronger invariant: rename never MISSES anything the reference catches.)
 */
const EXTRA_OVER_REFERENCE = [
	'contracts/src/core/Delegation.sol:58',
	'contracts/src/core/Delegation.sol:83',
	'contracts/test/js/Delegation.test.ts:60',
	'contracts/test/js/SignatureUtils.test.ts:97',
	'contracts/test/solidity/core/Delegation.t.sol:85',
	'contracts/test/solidity/core/Delegation.t.sol:528',
	'contracts/test/solidity/core/Delegation.t.sol:565',
	'contracts/test/solidity/core/UsingDelegation.t.sol:64',
	'contracts/test/solidity/core/UsingDelegation.t.sol:102',
	'contracts/test/solidity/core/UsingDelegation.t.sol:201',
	'scripts/run-e2e-tests.sh:85',
];

/** Skipped rather than failed when there is no network. */
async function fetchTemplate(): Promise<
	{dir: string; sha: string} | undefined
> {
	try {
		const source = parseSource(TEMPLATE);
		const {sha} = await resolveRef(source, PINNED_REF);
		const dir = await downloadTemplate(source, sha);
		return {dir, sha};
	} catch {
		return undefined;
	}
}

const fetched = await fetchTemplate();
const describeOnline = fetched ? describe : describe.skip;

describeOnline('acceptance: equivalence with create-jolly-roger', () => {
	const templateDir = fetched?.dir ?? '';

	async function offshootOutput(
		name: string,
		force: boolean,
	): Promise<Map<string, VirtualFile>> {
		const {config: raw} = await loadTemplateConfig(templateDir);
		const config = resolveConfig(raw, {inferredSourceName: 'jolly-roger'});
		const files = buildTree({
			dir: templateDir,
			config,
			answers: {name},
			template: 'github:wighawag/jolly-roger',
			ref: fetched?.sha ?? '',
			operation: 'scaffold',
			force,
			log: quietLog,
		});
		return new Map(files.map((f) => [f.path, f]));
	}

	/** Run the real create-jolly-roger algorithm over a copy of the template. */
	function referenceOutput(name: string): Map<string, VirtualFile> {
		const dir = tempDir('offshoot-reference-');
		const target = join(dir, 'out');
		cpSync(templateDir, target, {recursive: true});
		processAllFiles(target, buildReplacements(name));
		const files = readTree(target, {
			skipDirs: ['node_modules', '.git'],
			skipFiles: [],
			exclude: [],
		});
		return new Map(files.map((f) => [f.path, f]));
	}

	function compare(
		ours: Map<string, VirtualFile>,
		reference: Map<string, VirtualFile>,
	): {differences: string[]; changedByReference: number; extra: string[]} {
		const differences: string[] = [];
		const extra: string[] = [];
		let changedByReference = 0;

		for (const [path, referenceFile] of reference) {
			if (referenceFile.binary) continue;
			const ourFile = ours.get(path);
			if (!ourFile) {
				differences.push(`${path}: missing from offshoot output`);
				continue;
			}
			if (ourFile.binary) continue;

			const referenceLines = referenceFile.content.toString('utf8').split('\n');
			const ourLines = ourFile.content.toString('utf8').split('\n');
			const originalLines = readFileSync(
				join(templateDir, ...path.split('/')),
				'utf8',
			).split('\n');

			for (let i = 0; i < referenceLines.length; i++) {
				const before = originalLines[i];
				const referenceLine = referenceLines[i];
				const ourLine = ourLines[i];
				if (referenceLine === undefined) continue;

				if (before !== undefined && referenceLine !== before) {
					// The reference changed this line: we must produce the same.
					changedByReference++;
					if (ourLine !== referenceLine) {
						differences.push(
							`${path}:${i + 1}\n  reference: ${referenceLine}\n  offshoot:  ${ourLine}`,
						);
					}
				} else if (ourLine !== referenceLine) {
					extra.push(`${path}:${i + 1}`);
				}
			}
		}

		return {differences, changedByReference, extra};
	}

	it('applies every substitution create-jolly-roger applies, for the same name', async () => {
		const {differences, changedByReference} = compare(
			await offshootOutput(NAME, true),
			referenceOutput(NAME),
		);
		expect(changedByReference).toBeGreaterThan(0);
		expect(differences).toEqual([]);
	});

	it('leaves no occurrence of any create-jolly-roger source pattern behind', async () => {
		const ours = await offshootOutput(NAME, true);
		const patterns = buildReplacements(NAME).map(([from]) => from);

		const leftovers: string[] = [];
		for (const [path, file] of ours) {
			if (file.binary || file.skip) continue;
			const text = file.content.toString('utf8');
			for (const pattern of patterns) {
				if (text.includes(pattern)) leftovers.push(`${path}: ${pattern}`);
			}
		}
		expect(leftovers).toEqual([]);
	});

	it('differs from the reference only where anchored patterns miss the name', async () => {
		const {extra} = compare(
			await offshootOutput(NAME, true),
			referenceOutput(NAME),
		);

		// The extras are occurrences of the template name that no anchored
		// create-jolly-roger pattern targets (the delegation contracts/tests, and
		// scripts/run-e2e-tests.sh:85's `jolly-roger-e2e-node.log`), so
		// create-jolly-roger leaves the name in the generated project and
		// `rename` (which rewrites every occurrence) does not.
		expect(extra).toEqual(EXTRA_OVER_REFERENCE);
	});

	it('fixes that occurrence', async () => {
		const ours = await offshootOutput(NAME, true);
		const reference = referenceOutput(NAME);
		const path = 'scripts/run-e2e-tests.sh';

		expect(reference.get(path)?.content.toString('utf8')).toContain(
			'jolly-roger-e2e-node.log',
		);
		expect(ours.get(path)?.content.toString('utf8')).toContain(
			'my-app-e2e-node.log',
		);
	});

	it('still covers the anchored list with a non-colliding name', async () => {
		const {differences, changedByReference, extra} = compare(
			await offshootOutput(CLEAN_NAME, false),
			referenceOutput(CLEAN_NAME),
		);
		expect(changedByReference).toBeGreaterThan(0);
		expect(differences).toEqual([]);
		expect(extra).toEqual(EXTRA_OVER_REFERENCE);
	});

	it('FINDING: refuses the name `my-app` without --force, because the template already contains it', async () => {
		let error: RoundTripError | undefined;
		try {
			await offshootOutput(NAME, false);
		} catch (err) {
			error = err as RoundTripError;
		}

		expect(error).toBeInstanceOf(RoundTripError);
		// SvelteKit's stock README: "# create a new project in my-app".
		expect(error?.files).toEqual(['web/README.md']);
		expect(error?.reverse).toBeGreaterThan(error?.forward ?? 0);
		expect(error?.report).toContain('web/README.md');
		expect(error?.report).toContain('--force');
	});

	it('scaffolds end to end, exactly as the acceptance line reads', async () => {
		const cwd = tempDir('offshoot-acceptance-');
		const result = await scaffold({
			template: TEMPLATE,
			argv: [NAME],
			cwd,
			nonInteractive: true,
			// See the FINDING above; without it the gate correctly refuses.
			force: true,
			log: quietLog,
		});

		const read = (...parts: string[]) =>
			readFileSync(join(result.dir, ...parts), 'utf8');

		expect(read('package.json')).toContain('"name": "my-app"');
		expect(read('web', 'package.json')).toContain('"name": "my-app-web"');
		expect(read('contracts', 'package.json')).toContain(
			'"name": "my-app-contracts"',
		);
		expect(read('web', 'src', 'web-config.json')).toContain('"name": "My App"');
		expect(read('web', 'src', 'web-config.json')).toContain(
			'"title": "My App"',
		);
		expect(read('web', 'e2e', 'tests', 'home.e2e.ts')).toContain('/my app/i');
		expect(read('web', 'e2e', 'tests', 'home.e2e.ts')).toContain(
			'img[alt="My App"]',
		);
		expect(read('README.md')).toContain(
			'"my-app-contracts/abis/GreetingsRegistry.js"',
		);

		// Lockfiles are committed, but untransformed.
		expect(existsSync(join(result.dir, 'pnpm-lock.yaml'))).toBe(true);

		// And the project is ready for `offshoot update`.
		const state = JSON.parse(read('.offshoot.json')) as {
			template: string;
			ref: string;
			sourceName: string;
		};
		expect(state.template).toBe('github:wighawag/jolly-roger');
		expect(state.sourceName).toBe('jolly-roger');
		expect(state.ref).toMatch(/^[0-9a-f]{40}$/);
	});

	it('doctor reports the template as usable, and names the risky spot', async () => {
		const {doctor} = await import('../src/commands/doctor.js');
		const result = await doctor({
			cwd: templateDir,
			sourceName: 'jolly-roger',
			log: quietLog,
		});

		expect(result.occurrences.length).toBeGreaterThan(0);
		expect(result.filesWithToken).toContain('package.json');
		expect(result.errors).toEqual([]);

		const forMyApp = await doctor({
			cwd: templateDir,
			sourceName: 'jolly-roger',
			name: 'my-app',
			log: quietLog,
		});
		expect(forMyApp.errors.join('\n')).toContain('Round-trip check FAILED');
	});
});
