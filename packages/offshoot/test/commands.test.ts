/**
 * Requirements 7-13 from the brief.
 */

import {afterAll, describe, expect, it} from "vitest";
import {execFileSync} from "node:child_process";
import {existsSync, readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {dirname, join, resolve} from "node:path";
import {scaffold} from "../src/commands/scaffold.js";
import {update} from "../src/commands/update.js";
import {rename} from "../src/commands/rename.js";
import {RoundTripError} from "../src/transforms/rename.js";
import type {OffshootState} from "../src/types.js";
import {
	binaryWithToken,
	cleanupTempDirs,
	createTemplateRepo,
	defaultTemplateFiles,
	exists,
	git,
	isClean,
	quietLog,
	readBytes,
	readFile,
	tempDir,
	trackedFiles,
	writeFile,
} from "./helpers.js";

afterAll(cleanupTempDirs);

const here = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(here, "..", "dist", "cli.js");

async function scaffoldFrom(repoDir: string, name = "my-app") {
	const cwd = tempDir("offshoot-work-");
	const result = await scaffold({template: repoDir, argv: [name], cwd, nonInteractive: true, log: quietLog});
	git(["config", "user.name", "Test User"], result.dir);
	git(["config", "user.email", "user@example.com"], result.dir);
	return result;
}

function stateOf(root: string): OffshootState {
	return JSON.parse(readFileSync(join(root, ".offshoot.json"), "utf8")) as OffshootState;
}

describe("7. a project updates using only offshoot", () => {
	it("runs the offshoot CLI directly, with no create-* package present", async () => {
		expect(existsSync(CLI), "run `pnpm build` first").toBe(true);

		const template = createTemplateRepo(defaultTemplateFiles());

		// Scaffold exactly as a thin per-template wrapper would:
		//   scaffold({template: "wighawag/jolly-roger", argv: process.argv.slice(2)})
		const project = await scaffoldFrom(template.dir);

		// Nothing installed in the project: no node_modules, no create-* package.
		expect(exists(project.dir, "node_modules")).toBe(false);
		expect(trackedFiles(project.dir).some((f) => f.startsWith("create-"))).toBe(false);

		writeFile(template.dir, "src/index.ts", 'export const NAME = "demo-template";\nexport const added = 1;\n');
		template.commit("improve the template");

		const out = execFileSync(process.execPath, [CLI, "update"], {
			cwd: project.dir,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});

		expect(out).toContain("Updated to");
		expect(readFile(project.dir, "src/index.ts")).toContain("export const added = 1;");
		expect(readFile(project.dir, "src/index.ts")).toContain('NAME = "my-app"');
	});

	it("exposes `check` with a non-zero exit when behind", async () => {
		const template = createTemplateRepo(defaultTemplateFiles());
		const project = await scaffoldFrom(template.dir);

		const upToDate = execFileSync(process.execPath, [CLI, "check"], {cwd: project.dir, encoding: "utf8"});
		expect(upToDate).toContain("Up to date");

		writeFile(template.dir, "new.txt", "new\n");
		template.commit("newer");

		let status = 0;
		let stdout = "";
		try {
			stdout = execFileSync(process.execPath, [CLI, "check"], {cwd: project.dir, encoding: "utf8"});
		} catch (err) {
			const e = err as {status: number; stdout: string};
			status = e.status;
			stdout = e.stdout;
		}
		expect(status).toBe(1);
		expect(stdout).toContain("Update available");
	});
});

describe("8. binary files survive scaffold and update", () => {
	it("keeps them byte-identical, including one containing the source token", async () => {
		const tokenBinary = binaryWithToken("demo-template");
		const plainBinary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0xff, 0xfe]);

		const template = createTemplateRepo({
			...defaultTemplateFiles(),
			"assets/demo-template.png": tokenBinary,
			"assets/logo.png": plainBinary,
		});
		const project = await scaffoldFrom(template.dir);

		// The path is renamed; the bytes are not.
		expect(exists(project.dir, "assets/my-app.png")).toBe(true);
		expect(readBytes(project.dir, "assets/my-app.png").equals(tokenBinary)).toBe(true);
		expect(readBytes(project.dir, "assets/logo.png").equals(plainBinary)).toBe(true);

		writeFile(template.dir, "README.md", "# Demo Template\n\nupdated\n");
		template.commit("touch a text file");
		await update({cwd: project.dir, log: quietLog});

		expect(readBytes(project.dir, "assets/my-app.png").equals(tokenBinary)).toBe(true);
		expect(readBytes(project.dir, "assets/logo.png").equals(plainBinary)).toBe(true);
	});

	it("preserves the executable bit through scaffold and update", async () => {
		const template = createTemplateRepo(defaultTemplateFiles());
		writeFile(template.dir, "scripts/run-demo-template.sh", "#!/bin/sh\necho demo-template\n", true);
		template.commit("add an executable script");

		const project = await scaffoldFrom(template.dir);
		const mode = git(["ls-files", "-s", "scripts/run-my-app.sh"], project.dir);
		expect(mode).toContain("100755");

		writeFile(template.dir, "scripts/run-demo-template.sh", "#!/bin/sh\necho demo-template v2\n", true);
		template.commit("update the script");
		await update({cwd: project.dir, log: quietLog});

		expect(git(["ls-files", "-s", "scripts/run-my-app.sh"], project.dir)).toContain("100755");
		expect(readFile(project.dir, "scripts/run-my-app.sh")).toContain("echo my-app v2");
	});
});

describe("9. file and directory renaming", () => {
	it("renames nested directories and the files inside them", async () => {
		const template = createTemplateRepo({
			"package.json": '{"name": "demo-template"}\n',
			"src/demo-template/index.ts": 'export const id = "demo-template";\n',
			"src/demo-template/deep/demo-template.config.ts": "export default {};\n",
			"src/demo-template/deep/nested/DemoTemplate.ts": "export class DemoTemplate {}\n",
			"packages/demo-template-core/package.json": '{"name": "demo-template-core"}\n',
		});
		const project = await scaffoldFrom(template.dir);

		const files = trackedFiles(project.dir).sort();
		expect(files).toContain("src/my-app/index.ts");
		expect(files).toContain("src/my-app/deep/my-app.config.ts");
		expect(files).toContain("src/my-app/deep/nested/MyApp.ts");
		expect(files).toContain("packages/my-app-core/package.json");
		expect(files.some((f) => f.includes("demo-template"))).toBe(false);

		expect(readFile(project.dir, "src/my-app/deep/nested/MyApp.ts")).toBe("export class MyApp {}\n");
	});
});

describe("10. the round-trip count check", () => {
	it("fails a deliberately colliding target name", async () => {
		const template = createTemplateRepo({
			...defaultTemplateFiles(),
			// "widget" already means something else in this template.
			"src/widget.ts": "export const widget = 1; // an unrelated widget\n",
		});
		const cwd = tempDir("offshoot-work-");

		await expect(
			scaffold({template: template.dir, argv: ["widget"], cwd, nonInteractive: true, log: quietLog}),
		).rejects.toBeInstanceOf(RoundTripError);
	});

	it("names the offending files and offers --force", async () => {
		const template = createTemplateRepo({
			...defaultTemplateFiles(),
			"src/widget.ts": "export const widget = 1;\n",
		});
		const cwd = tempDir("offshoot-work-");
		try {
			await scaffold({template: template.dir, argv: ["widget"], cwd, nonInteractive: true, log: quietLog});
			expect.unreachable("should have thrown");
		} catch (err) {
			const error = err as RoundTripError;
			expect(error.report).toContain("src/widget.ts");
			expect(error.report).toContain("--force");
		}
	});

	it("proceeds with --force", async () => {
		const template = createTemplateRepo({
			...defaultTemplateFiles(),
			"src/widget.ts": "export const widget = 1;\n",
		});
		const cwd = tempDir("offshoot-work-");
		const result = await scaffold({
			template: template.dir,
			argv: ["widget"],
			cwd,
			nonInteractive: true,
			force: true,
			log: quietLog,
		});
		expect(exists(result.dir, "package.json")).toBe(true);
	});

	it("runs again on update, catching a collision introduced by a NEW template ref", async () => {
		const template = createTemplateRepo(defaultTemplateFiles());
		const project = await scaffoldFrom(template.dir, "widget");

		// Months later the author adds a file that collides with the name the
		// user picked long ago.
		writeFile(template.dir, "src/widget.ts", "export const widget = 1;\n");
		template.commit("add an unrelated widget");

		await expect(update({cwd: project.dir, log: quietLog})).rejects.toBeInstanceOf(RoundTripError);

		// The project is left exactly as it was, on its own branch.
		expect(isClean(project.dir)).toBe(true);
		expect(git(["rev-parse", "--abbrev-ref", "HEAD"], project.dir).trim()).toBe("main");
	});
});

describe("11. zero-config scaffolding", () => {
	it("works on a template that has never heard of offshoot", async () => {
		const template = createTemplateRepo(defaultTemplateFiles());
		expect(exists(template.dir, "offshoot.config.json")).toBe(false);

		const project = await scaffoldFrom(template.dir);

		// Token inferred from the repo name, rename strategy, default skip lists.
		const state = stateOf(project.dir);
		expect(state.sourceName).toBe("demo-template");
		expect(state.answers.name).toBe("my-app");
		expect(state.ref).toMatch(/^[0-9a-f]{40}$/);
		expect(readFile(project.dir, "package.json")).toContain('"name": "my-app"');
		expect(readFile(project.dir, "src/index.ts")).toBe('export const NAME = "my-app";\n');
	});

	it("records a concrete SHA, never a floating branch name", async () => {
		const template = createTemplateRepo(defaultTemplateFiles());
		const project = await scaffoldFrom(template.dir);
		const state = stateOf(project.dir);
		expect(state.ref).toBe(template.head());
		expect(state.track).toBe("main");
	});

	it("carries the new ref into the project through the merge", async () => {
		const template = createTemplateRepo(defaultTemplateFiles());
		const project = await scaffoldFrom(template.dir);
		const first = stateOf(project.dir).ref;

		writeFile(template.dir, "another.txt", "another\n");
		const second = template.commit("second");
		await update({cwd: project.dir, log: quietLog});

		expect(stateOf(project.dir).ref).toBe(second);
		expect(stateOf(project.dir).ref).not.toBe(first);
	});
});

describe("12. offshoot rename", () => {
	it("leaves the next update conflict-free", async () => {
		const template = createTemplateRepo(defaultTemplateFiles());
		const project = await scaffoldFrom(template.dir);

		const renamed = await rename({cwd: project.dir, newName: "better-name", log: quietLog});
		expect(renamed.renamed).toBe(true);
		expect(renamed.conflicted).toEqual([]);
		expect(readFile(project.dir, "package.json")).toContain('"name": "better-name"');
		expect(stateOf(project.dir).answers.name).toBe("better-name");

		writeFile(template.dir, "src/index.ts", 'export const NAME = "demo-template";\nexport const v = 2;\n');
		template.commit("template moves on");

		const result = await update({cwd: project.dir, log: quietLog});
		expect(result.conflicted).toEqual([]);
		expect(result.updated).toBe(true);
		expect(readFile(project.dir, "src/index.ts")).toBe('export const NAME = "better-name";\nexport const v = 2;\n');
	});

	it("refuses an update after a by-hand rename, pointing at `offshoot rename`", async () => {
		const template = createTemplateRepo(defaultTemplateFiles());
		const project = await scaffoldFrom(template.dir);

		// The user renames the project by hand, everywhere but .offshoot.json.
		for (const path of ["package.json", "README.md", "src/index.ts", "src/my-app/config.ts"]) {
			const text = readFile(project.dir, path);
			writeFile(project.dir, path, text.split("my-app").join("hand-renamed").split("My App").join("Hand Renamed"));
		}
		git(["add", "-A"], project.dir);
		git(["commit", "--no-verify", "-m", "rename by hand"], project.dir);

		writeFile(template.dir, "src/index.ts", 'export const NAME = "demo-template";\nexport const v = 2;\n');
		template.commit("template moves on");

		await expect(update({cwd: project.dir, log: quietLog})).rejects.toThrow(/offshoot rename/);
	});
});

describe("13. the delimiter asymmetry", () => {
	it("interpolates {{name}} in paths while contentTags is <% %>", async () => {
		const template = createTemplateRepo({
			"offshoot.config.json": JSON.stringify(
				{
					sourceName: "demo-template",
					contentTags: ["<%", "%>"],
					transforms: [{type: "rename"}, {type: "template", include: ["src/**/*.ts", "*.vue"]}],
				},
				null,
				2,
			),
			"package.json": '{"name": "demo-template"}\n',
			// Path uses {{ }}; content in the same file uses <% %>.
			"src/{{name}}.ts": 'export const n = "<%= name %>";\nexport const raw = "{{ not interpolated }}";\n',
			"src/plain/{{name}}/index.ts": "export const nested = true;\n",
			"App.vue": "<template>{{ msg }}</template>\n<!-- <%= name %> -->\n",
		});
		const project = await scaffoldFrom(template.dir);

		// Names interpolated with the fixed {{ }} delimiters...
		expect(exists(project.dir, "src/my-app.ts")).toBe(true);
		expect(exists(project.dir, "src/plain/my-app/index.ts")).toBe(true);

		// ...while file CONTENT used the configured <% %> delimiters, leaving
		// Vue's own {{ }} interpolation untouched.
		expect(readFile(project.dir, "src/my-app.ts")).toBe(
			'export const n = "my-app";\nexport const raw = "{{ not interpolated }}";\n',
		);
		expect(readFile(project.dir, "App.vue")).toBe("<template>{{ msg }}</template>\n<!-- my-app -->\n");
	});

	it("interpolates paths even when the template strategy is not enabled at all", async () => {
		const template = createTemplateRepo({
			"package.json": '{"name": "demo-template"}\n',
			"src/{{name}}.ts": "export const x = 1;\n",
		});
		const project = await scaffoldFrom(template.dir);
		expect(exists(project.dir, "src/my-app.ts")).toBe(true);
	});

	it("respects pathInterpolationExclude for a file that legitimately contains {{", async () => {
		const template = createTemplateRepo({
			"offshoot.config.json": JSON.stringify({
				sourceName: "demo-template",
				pathInterpolationExclude: ["docs/**"],
			}),
			"package.json": '{"name": "demo-template"}\n',
			"docs/{{literal}}.md": "kept as is\n",
		});
		const project = await scaffoldFrom(template.dir);
		expect(exists(project.dir, "docs/{{literal}}.md")).toBe(true);
	});
});
