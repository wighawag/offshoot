/**
 * `defaults`: a caller-supplied suggestion for a prompt the user is still
 * asked. The opinion belongs to the per-template wrapper, so the template
 * itself needs no offshoot config to get a good default.
 */

import {afterAll, describe, expect, it} from "vitest";
import {scaffold} from "../src/commands/scaffold.js";
import {initialFor} from "../src/prompt.js";
import {defaultPrompts} from "../src/config.js";
import type {OffshootState} from "../src/types.js";
import {cleanupTempDirs, createTemplateRepo, exists, quietLog, readFile, tempDir} from "./helpers.js";

afterAll(cleanupTempDirs);

describe("prompt defaults", () => {
	it("overrides the template's initial without answering the prompt", () => {
		const [spec] = defaultPrompts("jolly-roger");
		expect(spec).toBeDefined();
		expect(initialFor(spec!)).toBe("jolly-roger");
		expect(initialFor(spec!, {name: "my-onchain-app"})).toBe("my-onchain-app");
		// An unrelated default does not leak in.
		expect(initialFor(spec!, {other: "x"})).toBe("jolly-roger");
	});

	it("is used when there is nothing to prompt with (non-interactive)", async () => {
		const template = createTemplateRepo({
			"package.json": '{"name": "demo-template"}\n',
			"src/index.ts": 'export const NAME = "demo-template";\n',
		});
		const cwd = tempDir("offshoot-work-");

		const result = await scaffold({
			template: template.dir,
			argv: [],
			cwd,
			defaults: {name: "my-onchain-app"},
			nonInteractive: true,
			log: quietLog,
		});

		expect(result.answers.name).toBe("my-onchain-app");
		expect(exists(result.dir, "package.json")).toBe(true);
		expect(readFile(result.dir, "package.json")).toBe('{"name": "my-onchain-app"}\n');
		expect((JSON.parse(readFile(result.dir, ".offshoot.json")) as OffshootState).answers.name).toBe(
			"my-onchain-app",
		);
	});

	it("never overrides a real answer", async () => {
		const template = createTemplateRepo({"package.json": '{"name": "demo-template"}\n'});
		const cwd = tempDir("offshoot-work-");

		// A positional argument is an answer, not a suggestion.
		const result = await scaffold({
			template: template.dir,
			argv: ["chosen-name"],
			cwd,
			defaults: {name: "my-onchain-app"},
			nonInteractive: true,
			log: quietLog,
		});

		expect(result.answers.name).toBe("chosen-name");
		expect(readFile(result.dir, "package.json")).toBe('{"name": "chosen-name"}\n');
	});

	it("leaves behaviour unchanged when no defaults are given", async () => {
		const template = createTemplateRepo({"package.json": '{"name": "demo-template"}\n'});
		const cwd = tempDir("offshoot-work-");
		const result = await scaffold({
			template: template.dir,
			argv: [],
			cwd,
			nonInteractive: true,
			log: quietLog,
		});
		// Falls back to the template's own initial, which is the source token.
		expect(result.answers.name).toBe("demo-template");
	});
});
