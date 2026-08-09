/**
 * Tracking a branch other than the default one.
 *
 * A template can ship variants (`jolly-roger` has `variant/full`,
 * `variant/offline`, `v1`, ...). A project scaffolded from a variant must keep
 * following THAT branch on every later update, and must be able to switch to
 * another one deliberately.
 *
 * `.offshoot.json` separates the two ideas: `ref` is the immutable commit the
 * project was last transformed from, `track` is the floating ref it follows to
 * find the next one.
 */

import {afterAll, describe, expect, it} from "vitest";
import {readFileSync} from "node:fs";
import {join} from "node:path";
import {scaffold} from "../src/commands/scaffold.js";
import {update} from "../src/commands/update.js";
import {check} from "../src/commands/check.js";
import type {OffshootState} from "../src/types.js";
import {
	cleanupTempDirs,
	createTemplateRepo,
	exists,
	git,
	quietLog,
	readFile,
	tempDir,
	writeFile,
} from "./helpers.js";

afterAll(cleanupTempDirs);

function stateOf(root: string): OffshootState {
	return JSON.parse(readFileSync(join(root, ".offshoot.json"), "utf8")) as OffshootState;
}

/**
 * A template with a default branch and a variant branch, like jolly-roger's
 * `main` and `variant/full`.
 */
function templateWithVariant() {
	const template = createTemplateRepo({
		"package.json": '{"name": "demo-template"}\n',
		"src/index.ts": 'export const NAME = "demo-template";\n',
	});

	git(["checkout", "-q", "-b", "variant/full"], template.dir);
	writeFile(template.dir, "src/full-only.ts", 'export const full = "demo-template";\n');
	template.commit("variant: the full variant");
	git(["checkout", "-q", "main"], template.dir);

	return template;
}

async function scaffoldFrom(spec: string, name = "my-app") {
	const cwd = tempDir("offshoot-work-");
	const result = await scaffold({template: spec, argv: [name], cwd, nonInteractive: true, log: quietLog});
	git(["config", "user.name", "Test User"], result.dir);
	git(["config", "user.email", "user@example.com"], result.dir);
	return result;
}

describe("tracking a non-default branch", () => {
	it("scaffolds from `<template>#variant/full` and records it as the tracked ref", async () => {
		const template = templateWithVariant();
		const project = await scaffoldFrom(`${template.dir}#variant/full`);

		const state = stateOf(project.dir);
		expect(state.track).toBe("variant/full");
		// The ref is the commit, never the branch name.
		expect(state.ref).toMatch(/^[0-9a-f]{40}$/);
		expect(state.ref).toBe(git(["rev-parse", "variant/full"], template.dir).trim());
		// The state records the template without the ref, so `template` stays stable.
		expect(state.template).toBe(`file:${template.dir}`);

		expect(exists(project.dir, "src/full-only.ts")).toBe(true);
		expect(readFile(project.dir, "src/full-only.ts")).toBe('export const full = "my-app";\n');
	});

	it("keeps following that branch on update, and ignores the default branch", async () => {
		const template = templateWithVariant();
		const project = await scaffoldFrom(`${template.dir}#variant/full`);

		// The author moves BOTH branches on.
		writeFile(template.dir, "src/index.ts", 'export const NAME = "demo-template";\nexport const onMain = true;\n');
		template.commit("main moves on");

		git(["checkout", "-q", "variant/full"], template.dir);
		writeFile(template.dir, "src/full-only.ts", 'export const full = "demo-template";\nexport const v = 2;\n');
		const variantSha = template.commit("variant moves on");
		git(["checkout", "-q", "main"], template.dir);

		const result = await update({cwd: project.dir, log: quietLog});

		expect(result.updated).toBe(true);
		expect(result.conflicted).toEqual([]);
		expect(readFile(project.dir, "src/full-only.ts")).toBe('export const full = "my-app";\nexport const v = 2;\n');
		// The main-branch change did NOT leak in.
		expect(readFile(project.dir, "src/index.ts")).toBe('export const NAME = "my-app";\n');

		const state = stateOf(project.dir);
		expect(state.ref).toBe(variantSha);
		expect(state.track).toBe("variant/full");
	});

	it("`check` looks at the tracked branch, not the default one", async () => {
		const template = templateWithVariant();
		const project = await scaffoldFrom(`${template.dir}#variant/full`);

		// Only the default branch moves: the project is NOT behind.
		writeFile(template.dir, "unrelated.txt", "on main\n");
		template.commit("main only");
		expect((await check({cwd: project.dir, log: quietLog})).behind).toBe(false);

		// Now the tracked branch moves.
		git(["checkout", "-q", "variant/full"], template.dir);
		writeFile(template.dir, "src/full-only.ts", 'export const full = "demo-template";\nexport const v = 3;\n');
		const variantSha = template.commit("variant only");
		git(["checkout", "-q", "main"], template.dir);

		const result = await check({cwd: project.dir, log: quietLog});
		expect(result.behind).toBe(true);
		expect(result.latest).toBe(variantSha);
		expect(result.track).toBe("variant/full");
	});

	it("switches variants with `update --ref`, and keeps tracking the new one", async () => {
		const template = templateWithVariant();
		const project = await scaffoldFrom(template.dir); // starts on main

		expect(stateOf(project.dir).track).toBe("main");
		expect(exists(project.dir, "src/full-only.ts")).toBe(false);

		// The user's own work must survive the variant switch.
		writeFile(project.dir, "src/mine.ts", "export const mine = 1;\n");
		git(["add", "-A"], project.dir);
		git(["commit", "--no-verify", "-m", "my work"], project.dir);

		const switched = await update({cwd: project.dir, ref: "variant/full", log: quietLog});
		expect(switched.updated).toBe(true);
		expect(switched.conflicted).toEqual([]);
		expect(exists(project.dir, "src/full-only.ts")).toBe(true);
		expect(readFile(project.dir, "src/mine.ts")).toBe("export const mine = 1;\n");

		// Tracking moved with it: the next plain update follows variant/full.
		expect(stateOf(project.dir).track).toBe("variant/full");

		git(["checkout", "-q", "variant/full"], template.dir);
		writeFile(template.dir, "src/full-only.ts", 'export const full = "demo-template";\nexport const v = 9;\n');
		template.commit("variant moves on again");
		git(["checkout", "-q", "main"], template.dir);

		const next = await update({cwd: project.dir, log: quietLog});
		expect(next.updated).toBe(true);
		expect(readFile(project.dir, "src/full-only.ts")).toContain("export const v = 9;");
	});

	it("pinning to an exact commit does not change which branch is tracked", async () => {
		const template = templateWithVariant();
		const project = await scaffoldFrom(`${template.dir}#variant/full`);

		git(["checkout", "-q", "variant/full"], template.dir);
		writeFile(template.dir, "step.txt", "one\n");
		const one = template.commit("step one");
		writeFile(template.dir, "step.txt", "two\n");
		template.commit("step two");
		git(["checkout", "-q", "main"], template.dir);

		// Deliberately update to an intermediate commit rather than the tip.
		const result = await update({cwd: project.dir, ref: one, log: quietLog});
		expect(result.updated).toBe(true);
		expect(readFile(project.dir, "step.txt")).toBe("one\n");

		const state = stateOf(project.dir);
		expect(state.ref).toBe(one);
		// A SHA is not a thing to follow, so the tracked branch is unchanged.
		expect(state.track).toBe("variant/full");
	});
});
