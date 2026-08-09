/**
 * Standing in the TEMPLATE repository rather than in a project generated from
 * it.
 *
 * `.offshoot.json` does not exist there, and must not: it is created in the
 * projects people scaffold. So the project commands have to refuse - and say
 * something a template author can act on, rather than talking about `--eject`.
 */

import {afterAll, describe, expect, it} from 'vitest';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {update} from '../src/commands/update.js';
import {check} from '../src/commands/check.js';
import {eject} from '../src/commands/eject.js';
import {rename} from '../src/commands/rename.js';
import {doctor} from '../src/commands/doctor.js';
import {scaffold} from '../src/commands/scaffold.js';
import {
	cleanupTempDirs,
	createTemplateRepo,
	defaultTemplateFiles,
	exists,
	git,
	quietLog,
	readFile,
	tempDir,
	trackedFiles,
	writeFile,
} from './helpers.js';

afterAll(cleanupTempDirs);

const here = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(here, '..', 'dist', 'cli.js');

describe('running project commands inside a template repository', () => {
	function configuredTemplate() {
		return createTemplateRepo({
			...defaultTemplateFiles(),
			'offshoot.config.json': JSON.stringify(
				{sourceName: 'demo-template'},
				null,
				2,
			),
		});
	}

	it('has no .offshoot.json, and should not', () => {
		const template = configuredTemplate();
		expect(exists(template.dir, '.offshoot.json')).toBe(false);
		expect(trackedFiles(template.dir)).not.toContain('.offshoot.json');
	});

	it('refuses update, check, rename and eject', async () => {
		const template = configuredTemplate();
		const cwd = template.dir;

		await expect(update({cwd, log: quietLog})).rejects.toThrow(
			/TEMPLATE repository/,
		);
		await expect(check({cwd, log: quietLog})).rejects.toThrow(
			/TEMPLATE repository/,
		);
		await expect(rename({cwd, newName: 'x', log: quietLog})).rejects.toThrow(
			/TEMPLATE repository/,
		);
		await expect(eject({cwd, log: quietLog})).rejects.toThrow(
			/TEMPLATE repository/,
		);
	});

	it('points the author at `offshoot doctor` instead', async () => {
		const template = configuredTemplate();
		await expect(update({cwd: template.dir, log: quietLog})).rejects.toThrow(
			/offshoot doctor/,
		);
		// ...and that command does work there.
		const result = await doctor({cwd: template.dir, log: quietLog});
		expect(result.ok).toBe(true);
	});

	it('exits non-zero from the CLI, so CI notices', () => {
		const template = configuredTemplate();
		let status = 0;
		try {
			execFileSync(process.execPath, [CLI, 'update'], {
				cwd: template.dir,
				stdio: 'pipe',
			});
		} catch (err) {
			status = (err as {status: number}).status;
		}
		expect(status).toBe(1);
	});

	it('falls back to the generic message for a zero-config template', async () => {
		// Without an offshoot.config there is nothing to distinguish a template
		// from any other directory, so the message stays generic rather than
		// guessing.
		const template = createTemplateRepo(defaultTemplateFiles());
		await expect(update({cwd: template.dir, log: quietLog})).rejects.toThrow(
			/No \.offshoot\.json found/,
		);
	});
});

describe('a template that is itself an offshoot project', () => {
	/** Token matches the repo directory name, as a real template's would. */
	function upstreamFiles(): Record<string, string> {
		return {
			'package.json':
				JSON.stringify({name: 'upstream-template', version: '0.0.0'}, null, 2) +
				'\n',
			'README.md': '# Upstream Template\n\nThe upstream-template project.\n',
			'src/index.ts': 'export const NAME = "upstream-template";\n',
		};
	}

	/**
	 * Real scenario: someone scaffolds a project, then turns it into a
	 * template of their own. That repository legitimately contains BOTH an
	 * `.offshoot.json` (its own link upstream) and the role of a template.
	 * Its state file must never be handed down to the projects generated
	 * from it.
	 */
	it('never ships its own .offshoot.json to the projects it generates', async () => {
		const upstream = createTemplateRepo(upstreamFiles(), 'upstream-template');

		// A project scaffolded from upstream, which then becomes a template.
		const workspace = tempDir('offshoot-work-');
		const middle = await scaffold({
			template: upstream.dir,
			argv: ['demo-template'],
			cwd: workspace,
			nonInteractive: true,
			log: quietLog,
		});
		git(['config', 'user.name', 'u'], middle.dir);
		git(['config', 'user.email', 'u@e'], middle.dir);
		expect(exists(middle.dir, '.offshoot.json')).toBe(true);

		// Someone scaffolds from THAT.
		const downstreamCwd = tempDir('offshoot-work-');
		const downstream = await scaffold({
			template: middle.dir,
			argv: ['final-app'],
			cwd: downstreamCwd,
			nonInteractive: true,
			log: quietLog,
		});

		// The downstream project gets its own state, pointing at the middle
		// repo - not a copy of the middle repo's state pointing upstream.
		const state = JSON.parse(readFile(downstream.dir, '.offshoot.json')) as {
			template: string;
			answers: {name?: string};
		};
		expect(state.template).toBe(`file:${middle.dir}`);
		expect(state.answers.name).toBe('final-app');
		expect(state.template).not.toContain('upstream-template');

		// Exactly one state file, and it is the downstream one.
		expect(
			trackedFiles(downstream.dir).filter((f) => f.endsWith('.offshoot.json')),
		).toEqual(['.offshoot.json']);
	});

	it('keeps updating cleanly from the middle template afterwards', async () => {
		const upstream = createTemplateRepo(upstreamFiles(), 'upstream-template');
		const workspace = tempDir('offshoot-work-');
		const middle = await scaffold({
			template: upstream.dir,
			argv: ['demo-template'],
			cwd: workspace,
			nonInteractive: true,
			log: quietLog,
		});
		git(['config', 'user.name', 'u'], middle.dir);
		git(['config', 'user.email', 'u@e'], middle.dir);

		const downstreamCwd = tempDir('offshoot-work-');
		const downstream = await scaffold({
			template: middle.dir,
			argv: ['final-app'],
			cwd: downstreamCwd,
			nonInteractive: true,
			log: quietLog,
		});
		git(['config', 'user.name', 'u'], downstream.dir);
		git(['config', 'user.email', 'u@e'], downstream.dir);

		// The middle template moves on.
		writeFile(
			middle.dir,
			'src/added.ts',
			'export const added = "demo-template";\n',
		);
		git(['add', '-A'], middle.dir);
		git(['commit', '--no-verify', '-m', 'middle improves'], middle.dir);

		const result = await update({cwd: downstream.dir, log: quietLog});
		expect(result.conflicted).toEqual([]);
		expect(result.updated).toBe(true);
		expect(readFile(downstream.dir, 'src/added.ts')).toBe(
			'export const added = "final-app";\n',
		);
		// Still exactly one state file, still its own.
		expect(
			(
				JSON.parse(readFile(downstream.dir, '.offshoot.json')) as {
					answers: {name?: string};
				}
			).answers.name,
		).toBe('final-app');
	});
});
