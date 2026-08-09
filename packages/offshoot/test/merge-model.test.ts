/**
 * The validated architecture, asserted end to end.
 *
 * Requirements 1-6 from the brief: template-only changes auto-merge, user-only
 * files are untouched, conflicts appear only where both sides edited the same
 * lines, new template files land, the user's history contains zero commits
 * from the template repo, and `git merge --abort` restores the pre-update
 * state.
 */

import {afterAll, describe, expect, it} from "vitest";

import {scaffold} from "../src/commands/scaffold.js";
import {update} from "../src/commands/update.js";
import {
	branchOf,
	cleanupTempDirs,
	createTemplateRepo,
	defaultTemplateFiles,
	exists,
	git,
	isClean,
	logOf,
	quietLog,
	readFile,
	tempDir,
	writeFile,
} from "./helpers.js";

afterAll(cleanupTempDirs);

async function scaffoldFrom(repoDir: string, name = "my-app") {
	const cwd = tempDir("offshoot-work-");
	const result = await scaffold({
		template: repoDir,
		argv: [name],
		cwd,
		nonInteractive: true,
		log: quietLog,
	});
	git(["config", "user.name", "Test User"], result.dir);
	git(["config", "user.email", "user@example.com"], result.dir);
	return result;
}

describe("the template-branch merge model", () => {
	it("1. auto-merges template-only changes with no conflict", async () => {
		const template = createTemplateRepo(defaultTemplateFiles());
		const project = await scaffoldFrom(template.dir);

		// The author improves the template.
		writeFile(template.dir, "src/index.ts", 'export const NAME = "demo-template";\nexport const V = 2;\n');
		template.commit("add V");

		const result = await update({cwd: project.dir, log: quietLog});

		expect(result.updated).toBe(true);
		expect(result.conflicted).toEqual([]);
		expect(readFile(project.dir, "src/index.ts")).toContain("export const V = 2;");
		expect(readFile(project.dir, "src/index.ts")).toContain('NAME = "my-app"');
		expect(isClean(project.dir)).toBe(true);
	});

	it("2. never touches user-only files", async () => {
		const template = createTemplateRepo(defaultTemplateFiles());
		const project = await scaffoldFrom(template.dir);

		writeFile(project.dir, "src/mine.ts", "export const mine = true;\n");
		writeFile(project.dir, "notes/todo.md", "- my own note\n");
		git(["add", "-A"], project.dir);
		git(["commit", "--no-verify", "-m", "my work"], project.dir);

		writeFile(template.dir, "src/added.ts", 'export const added = "demo-template";\n');
		template.commit("add a file");

		const result = await update({cwd: project.dir, log: quietLog});

		expect(result.updated).toBe(true);
		expect(readFile(project.dir, "src/mine.ts")).toBe("export const mine = true;\n");
		expect(readFile(project.dir, "notes/todo.md")).toBe("- my own note\n");
	});

	it("3. conflicts only where both sides edited the same lines", async () => {
		const template = createTemplateRepo({
			...defaultTemplateFiles(),
			"shared.ts": "const a = 1;\nconst b = 2;\nconst c = 3;\n",
		});
		const project = await scaffoldFrom(template.dir);

		// User edits the FIRST line; template edits the LAST line.
		writeFile(project.dir, "shared.ts", "const a = 100;\nconst b = 2;\nconst c = 3;\n");
		git(["add", "-A"], project.dir);
		git(["commit", "--no-verify", "-m", "user edits line 1"], project.dir);

		writeFile(template.dir, "shared.ts", "const a = 1;\nconst b = 2;\nconst c = 300;\n");
		template.commit("template edits line 3");

		const disjoint = await update({cwd: project.dir, log: quietLog});
		expect(disjoint.conflicted).toEqual([]);
		expect(readFile(project.dir, "shared.ts")).toBe("const a = 100;\nconst b = 2;\nconst c = 300;\n");

		// Now both sides edit the SAME line.
		writeFile(project.dir, "shared.ts", "const a = 100;\nconst b = 222;\nconst c = 300;\n");
		git(["add", "-A"], project.dir);
		git(["commit", "--no-verify", "-m", "user edits line 2"], project.dir);

		writeFile(template.dir, "shared.ts", "const a = 1;\nconst b = 999;\nconst c = 300;\n");
		template.commit("template edits line 2");

		const collision = await update({cwd: project.dir, log: quietLog});
		expect(collision.conflicted).toEqual(["shared.ts"]);
		expect(readFile(project.dir, "shared.ts")).toContain("<<<<<<<");

		git(["merge", "--abort"], project.dir);
	});

	it("4. lands new template files in the project", async () => {
		const template = createTemplateRepo(defaultTemplateFiles());
		const project = await scaffoldFrom(template.dir);

		writeFile(template.dir, "docs/guide.md", "# Guide for demo-template\n");
		writeFile(template.dir, "src/nested/deep/thing.ts", "export const deep = true;\n");
		template.commit("add docs and a nested file");

		await update({cwd: project.dir, log: quietLog});

		expect(exists(project.dir, "docs/guide.md")).toBe(true);
		expect(readFile(project.dir, "docs/guide.md")).toBe("# Guide for my-app\n");
		expect(exists(project.dir, "src/nested/deep/thing.ts")).toBe(true);
	});

	it("5. keeps zero commits from the template repository in the project history", async () => {
		const template = createTemplateRepo(defaultTemplateFiles());
		writeFile(template.dir, "second.txt", "second\n");
		template.commit("template: second commit");
		writeFile(template.dir, "extra.txt", "extra\n");
		const templateSha = template.commit("template: third commit");

		const project = await scaffoldFrom(template.dir);
		writeFile(template.dir, "extra.txt", "extra changed\n");
		template.commit("template: fourth commit");
		await update({cwd: project.dir, log: quietLog});

		// No SHA from the template repo appears anywhere in the project history.
		const templateShas = new Set(
			git(["log", "--format=%H"], template.dir).trim().split("\n").filter(Boolean),
		);
		const projectShas = git(["log", "--format=%H", "--all"], project.dir).trim().split("\n").filter(Boolean);
		for (const sha of projectShas) expect(templateShas.has(sha)).toBe(false);
		expect(templateShas.has(templateSha)).toBe(true);

		// And no template commit SUBJECT was replayed into the project either.
		const subjects = logOf(project.dir, "--all");
		expect(subjects.some((s) => s === "template: second commit")).toBe(false);
		expect(subjects.some((s) => s === "template: fourth commit")).toBe(false);
	});

	it("6. restores the pre-update state with `git merge --abort`", async () => {
		const template = createTemplateRepo({
			...defaultTemplateFiles(),
			"shared.ts": "const value = 1;\n",
		});
		const project = await scaffoldFrom(template.dir);

		writeFile(project.dir, "shared.ts", "const value = 42;\n");
		git(["add", "-A"], project.dir);
		git(["commit", "--no-verify", "-m", "user value"], project.dir);

		const before = git(["rev-parse", "HEAD"], project.dir).trim();
		const beforeTree = git(["rev-parse", "HEAD^{tree}"], project.dir).trim();

		writeFile(template.dir, "shared.ts", "const value = 99;\n");
		template.commit("template value");

		const result = await update({cwd: project.dir, log: quietLog});
		expect(result.conflicted).toEqual(["shared.ts"]);

		git(["merge", "--abort"], project.dir);

		expect(git(["rev-parse", "HEAD"], project.dir).trim()).toBe(before);
		expect(git(["rev-parse", "HEAD^{tree}"], project.dir).trim()).toBe(beforeTree);
		expect(readFile(project.dir, "shared.ts")).toBe("const value = 42;\n");
		expect(isClean(project.dir)).toBe(true);
		expect(branchOf(project.dir)).toBe("main");
	});

	it("leaves the user on their own branch, with the template branch intact", async () => {
		const template = createTemplateRepo(defaultTemplateFiles());
		const project = await scaffoldFrom(template.dir);

		expect(branchOf(project.dir)).toBe("main");
		expect(git(["branch", "--list", "template"], project.dir).trim()).toContain("template");
		expect(exists(project.dir, ".offshoot.json")).toBe(true);

		writeFile(template.dir, "src/index.ts", 'export const NAME = "demo-template";\nexport const extra = 1;\n');
		template.commit("change");
		await update({cwd: project.dir, log: quietLog});

		expect(branchOf(project.dir)).toBe("main");
	});
});
