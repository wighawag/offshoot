/**
 * Template configuration, the author-facing commands, and the library API.
 */

import {afterAll, describe, expect, it} from 'vitest';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {scaffold} from '../src/commands/scaffold.js';
import {update} from '../src/commands/update.js';
import {doctor} from '../src/commands/doctor.js';
import {eject} from '../src/commands/eject.js';
import {check} from '../src/commands/check.js';
import {defineConfig} from '../src/config.js';
import type {OffshootState} from '../src/types.js';
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

async function scaffoldFrom(repoDir: string, name = 'my-app') {
	const cwd = tempDir('offshoot-work-');
	const result = await scaffold({
		template: repoDir,
		argv: [name],
		cwd,
		nonInteractive: true,
		log: quietLog,
	});
	git(['config', 'user.name', 'Test User'], result.dir);
	git(['config', 'user.email', 'user@example.com'], result.dir);
	return result;
}

function stateOf(root: string): OffshootState {
	return JSON.parse(
		readFileSync(join(root, '.offshoot.json'), 'utf8'),
	) as OffshootState;
}

describe('template configuration', () => {
	it('composes patterns then rename', async () => {
		const template = createTemplateRepo({
			'offshoot.config.json': JSON.stringify({
				sourceName: 'demo-template',
				transforms: [
					{
						type: 'patterns',
						patterns: [
							{
								from: 'SPDX-License-Identifier: MIT',
								to: 'SPDX-License-Identifier: MIT',
							},
						],
					},
					{type: 'rename'},
				],
			}),
			'package.json': '{"name": "demo-template"}\n',
			'LICENSE.ts':
				"// SPDX-License-Identifier: MIT\nconst p = 'demo-template';\n",
		});
		const project = await scaffoldFrom(template.dir);
		expect(readFile(project.dir, 'LICENSE.ts')).toBe(
			"// SPDX-License-Identifier: MIT\nconst p = 'my-app';\n",
		);
	});

	it('honours a js config with a function-valued replacement', async () => {
		const template = createTemplateRepo({
			'offshoot.config.mjs': `export default {
				sourceName: "demo-template",
				prompts: [
					{name: "name", type: "text", initial: "demo-template"},
					{name: "author", type: "text", initial: "nobody"},
				],
				transforms: [
					{type: "patterns", patterns: [{from: "@AUTHOR@", to: (a) => String(a.author)}]},
					{type: "rename"},
				],
			};\n`,
			'package.json': '{"name": "demo-template", "author": "@AUTHOR@"}\n',
		});
		const cwd = tempDir('offshoot-work-');
		const project = await scaffold({
			template: template.dir,
			argv: ['my-app', 'author=Ronan'],
			cwd,
			nonInteractive: true,
			log: quietLog,
		});
		expect(readFile(project.dir, 'package.json')).toBe(
			'{"name": "my-app", "author": "Ronan"}\n',
		);
		expect(stateOf(project.dir).answers.author).toBe('Ronan');
	});

	it('loads a typed offshoot.config.ts via defineConfig', async () => {
		const template = createTemplateRepo({
			'offshoot.config.ts': `import {defineConfig} from "offshoot";
export default defineConfig({
	sourceName: "demo-template",
	skipFiles: ["pnpm-lock.yaml", "KEEP.md"],
});\n`,
			'package.json': '{"name": "demo-template"}\n',
			'KEEP.md': 'demo-template stays\n',
		});
		const project = await scaffoldFrom(template.dir);
		expect(readFile(project.dir, 'package.json')).toContain('my-app');
		expect(readFile(project.dir, 'KEEP.md')).toBe('demo-template stays\n');
	});

	it('registers a custom Transform supplied by the template', async () => {
		const template = createTemplateRepo({
			'offshoot.config.mjs': `export default {
				sourceName: "demo-template",
				transforms: [
					{type: "rename"},
					{
						name: "banner",
						apply(files, answers) {
							return files.map((f) =>
								f.path === "README.md"
									? {...f, content: Buffer.concat([Buffer.from("<!-- built by " + answers.name + " -->\\n"), f.content])}
									: f,
							);
						},
					},
				],
			};\n`,
			'package.json': '{"name": "demo-template"}\n',
			'README.md': '# Demo Template\n',
		});
		const project = await scaffoldFrom(template.dir);
		expect(readFile(project.dir, 'README.md')).toBe(
			'<!-- built by my-app -->\n# My App\n',
		);
	});

	it('excludes files that must never reach the generated project', async () => {
		const template = createTemplateRepo({
			'offshoot.config.json': JSON.stringify({
				sourceName: 'demo-template',
				exclude: ['.github/**', 'AUTHORING.md'],
			}),
			'package.json': '{"name": "demo-template"}\n',
			'.github/workflows/template-ci.yml': 'name: template ci\n',
			'AUTHORING.md': 'notes for the template author\n',
			'README.md': '# Demo Template\n',
		});
		const project = await scaffoldFrom(template.dir);
		expect(exists(project.dir, '.github/workflows/template-ci.yml')).toBe(
			false,
		);
		expect(exists(project.dir, 'AUTHORING.md')).toBe(false);
		expect(exists(project.dir, 'README.md')).toBe(true);
	});

	it("never ships the template's own offshoot.config", async () => {
		const template = createTemplateRepo({
			'offshoot.config.json': JSON.stringify({sourceName: 'demo-template'}),
			'package.json': '{"name": "demo-template"}\n',
		});
		const project = await scaffoldFrom(template.dir);
		expect(exists(project.dir, 'offshoot.config.json')).toBe(false);
	});

	it('commits skip-listed files untransformed', async () => {
		const template = createTemplateRepo({
			'package.json': '{"name": "demo-template"}\n',
			'pnpm-lock.yaml': 'packages:\n  demo-template: 1\n',
		});
		const project = await scaffoldFrom(template.dir);
		expect(trackedFiles(project.dir)).toContain('pnpm-lock.yaml');
		expect(readFile(project.dir, 'pnpm-lock.yaml')).toBe(
			'packages:\n  demo-template: 1\n',
		);
	});

	it('seeds skipIfExists files once and never updates them', async () => {
		const template = createTemplateRepo({
			'offshoot.config.json': JSON.stringify({
				sourceName: 'demo-template',
				skipIfExists: ['.env.example'],
			}),
			'package.json': '{"name": "demo-template"}\n',
			'.env.example': 'KEY=template-value\n',
		});
		const project = await scaffoldFrom(template.dir);
		expect(readFile(project.dir, '.env.example')).toBe('KEY=template-value\n');

		// The user edits it, and the template changes it too.
		writeFile(project.dir, '.env.example', 'KEY=my-own-value\n');
		git(['add', '-A'], project.dir);
		git(['commit', '--no-verify', '-m', 'my env'], project.dir);

		writeFile(template.dir, '.env.example', 'KEY=changed-upstream\n');
		writeFile(template.dir, 'other.txt', 'other\n');
		template.commit('change the seeded file and add another');

		const result = await update({cwd: project.dir, log: quietLog});
		expect(result.conflicted).toEqual([]);
		expect(readFile(project.dir, '.env.example')).toBe('KEY=my-own-value\n');
		expect(exists(project.dir, 'other.txt')).toBe(true);
	});

	it('supports a configurable template branch name', async () => {
		const template = createTemplateRepo({
			'offshoot.config.json': JSON.stringify({
				sourceName: 'demo-template',
				branch: 'upstream-template',
			}),
			'package.json': '{"name": "demo-template"}\n',
		});
		const project = await scaffoldFrom(template.dir);

		expect(git(['branch', '--list'], project.dir)).toContain(
			'upstream-template',
		);
		expect(stateOf(project.dir).branch).toBe('upstream-template');

		writeFile(template.dir, 'new.txt', 'new\n');
		template.commit('more');
		const result = await update({cwd: project.dir, log: quietLog});
		expect(result.updated).toBe(true);
		expect(result.branch).toBe('upstream-template');
	});

	it('reads the config from the fetched ref, so authors can evolve it', async () => {
		const template = createTemplateRepo({
			'package.json': '{"name": "demo-template"}\n',
			'keep.txt': 'demo-template\n',
		});
		const project = await scaffoldFrom(template.dir);
		expect(readFile(project.dir, 'keep.txt')).toBe('my-app\n');

		// The author adds a config in a later commit.
		writeFile(
			template.dir,
			'offshoot.config.json',
			JSON.stringify({sourceName: 'demo-template', skipFiles: ['keep.txt']}),
		);
		writeFile(template.dir, 'keep.txt', 'demo-template updated\n');
		template.commit('add an offshoot config');

		await update({cwd: project.dir, log: quietLog});
		expect(readFile(project.dir, 'keep.txt')).toBe('demo-template updated\n');
	});

	it('defineConfig is a pass-through typed helper', () => {
		const config = defineConfig({sourceName: 'x'});
		expect(config).toEqual({sourceName: 'x'});
	});
});

describe('offshoot doctor', () => {
	it('inventories occurrences and passes a healthy template', async () => {
		const template = createTemplateRepo(defaultTemplateFiles());
		const result = await doctor({cwd: template.dir, log: quietLog});

		expect(result.sourceName).toBe('demo-template');
		expect(result.occurrences.length).toBeGreaterThan(0);
		expect(result.filesWithToken).toContain('package.json');
		expect(result.errors).toEqual([]);
		expect(result.ok).toBe(true);
	});

	it('flags occurrences that look like ordinary words', async () => {
		const template = createTemplateRepo({
			'package.json': '{"name": "demo-template"}\n',
			// "demo template" here is prose, not a project reference.
			'README.md': 'This is a demo template for building things.\n',
		});
		const result = await doctor({cwd: template.dir, log: quietLog});
		expect(result.warnings.join('\n')).toContain('ordinary words');
		expect(
			result.occurrences.some((o) => o.bare && o.path === 'README.md'),
		).toBe(true);
	});

	it('warns about a token that is too short or a single word', async () => {
		const template = createTemplateRepo(
			{'package.json': '{"name": "app"}\n'},
			'app',
		);
		const result = await doctor({cwd: template.dir, log: quietLog});
		expect(result.warnings.join('\n')).toMatch(/characters|single word/);
		expect(result.errors.join('\n')).toContain('generic word');
		expect(result.ok).toBe(false);
	});

	it('fails when the token appears nowhere', async () => {
		const template = createTemplateRepo({
			'package.json': '{"name": "something-else"}\n',
		});
		const result = await doctor({cwd: template.dir, log: quietLog});
		expect(result.errors.join('\n')).toContain('No occurrence');
		expect(result.ok).toBe(false);
	});

	it('fails the round-trip probe for a name the author asks about', async () => {
		const template = createTemplateRepo({
			'package.json': '{"name": "demo-template"}\n',
			'src/widget.ts': 'export const widget = 1;\n',
		});
		const result = await doctor({
			cwd: template.dir,
			name: 'widget',
			log: quietLog,
		});
		expect(result.errors.join('\n')).toContain('Round-trip check FAILED');
		expect(result.ok).toBe(false);
	});
});

describe('offshoot check and eject', () => {
	it('reports the newer ref without touching the project', async () => {
		const template = createTemplateRepo(defaultTemplateFiles());
		const project = await scaffoldFrom(template.dir);

		expect((await check({cwd: project.dir, log: quietLog})).behind).toBe(false);

		writeFile(template.dir, 'new.txt', 'new\n');
		const newer = template.commit('newer');

		const result = await check({cwd: project.dir, log: quietLog});
		expect(result.behind).toBe(true);
		expect(result.latest).toBe(newer);
		expect(exists(project.dir, 'new.txt')).toBe(false);
	});

	it('cuts the link permanently', async () => {
		const template = createTemplateRepo(defaultTemplateFiles());
		const project = await scaffoldFrom(template.dir);

		const result = await eject({cwd: project.dir, log: quietLog});
		expect(result.branchDeleted).toBe(true);
		expect(exists(project.dir, '.offshoot.json')).toBe(false);
		expect(git(['branch', '--list'], project.dir)).not.toContain('template');

		writeFile(template.dir, 'new.txt', 'new\n');
		template.commit('newer');
		await expect(update({cwd: project.dir, log: quietLog})).rejects.toThrow(
			/\.offshoot\.json/,
		);
	});
});

describe('update guards', () => {
	it('refuses a dirty working tree', async () => {
		const template = createTemplateRepo(defaultTemplateFiles());
		const project = await scaffoldFrom(template.dir);
		writeFile(project.dir, 'src/index.ts', 'dirty\n');

		writeFile(template.dir, 'new.txt', 'new\n');
		template.commit('newer');

		await expect(update({cwd: project.dir, log: quietLog})).rejects.toThrow(
			/not clean/,
		);
	});

	it('is a no-op when already at the newest ref', async () => {
		const template = createTemplateRepo(defaultTemplateFiles());
		const project = await scaffoldFrom(template.dir);
		const result = await update({cwd: project.dir, log: quietLog});
		expect(result.upToDate).toBe(true);
		expect(result.updated).toBe(false);
	});

	it('can update to an explicit older or tagged ref', async () => {
		const template = createTemplateRepo(defaultTemplateFiles());
		writeFile(template.dir, 'v2.txt', 'v2\n');
		template.commit('v2');
		git(['tag', 'v2'], template.dir);
		writeFile(template.dir, 'v3.txt', 'v3\n');
		template.commit('v3');

		const project = await scaffoldFrom(template.dir);
		expect(exists(project.dir, 'v3.txt')).toBe(true);

		const result = await update({cwd: project.dir, ref: 'v2', log: quietLog});
		expect(result.updated).toBe(true);
		expect(exists(project.dir, 'v3.txt')).toBe(false);
		expect(exists(project.dir, 'v2.txt')).toBe(true);
	});
});
