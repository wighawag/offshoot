/**
 * Unit-level behaviour of the transform layer: the ported change-name logic,
 * the change-case v4 -> v5 mapping, binary safety, and the uniqueness gate.
 */

import {describe, expect, it} from "vitest";
import * as changeCase4 from "change-case-4";
import {applyRename, assertRoundTrip, RoundTripError} from "../src/transforms/rename.js";
import {createPatternsTransform} from "../src/transforms/patterns.js";
import {createTemplateTransform} from "../src/transforms/template.js";
import {interpolatePath} from "../src/transforms/path-interpolation.js";
import {CASE_FUNCTIONS, DEFAULT_VARIANTS, variantPairs} from "../src/case-variants.js";
import {isBinary, isText, looksBinary} from "../src/text-binary/index.js";
import type {CaseVariant, TransformContext, VirtualFile} from "../src/types.js";
import {silentLogger} from "../src/logger.js";
import {binaryWithToken} from "./helpers.js";

function file(path: string, content: string | Buffer, overrides: Partial<VirtualFile> = {}): VirtualFile {
	const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
	return {
		path,
		content: buffer,
		executable: false,
		binary: Buffer.isBuffer(content) ? looksBinary(path, buffer) : false,
		skip: false,
		...overrides,
	};
}

const ctx: TransformContext = {
	sourceName: "demo-template",
	template: "file:/tmp/demo",
	ref: "0".repeat(40),
	config: {
		sourceName: "demo-template",
		branch: "template",
		transforms: [],
		prompts: [],
		contentTags: ["{{", "}}"],
		skipDirs: [],
		skipFiles: [],
		skipIfExists: [],
		exclude: [],
		pathInterpolationExclude: [],
		eject: {exclude: [], packageJson: {dependencies: [], devDependencies: [], scripts: []}},
	},
	contentTags: ["{{", "}}"],
	operation: "scaffold",
	force: false,
	eject: false,
	log: silentLogger,
};

describe("change-case v4 -> v5 mapping", () => {
	// The brief: change-name pins change-case@4; using v5 requires mapping the
	// renamed exports (paramCase -> kebabCase, headerCase -> trainCase) so
	// behaviour is identical. This proves it against a real v4.
	const names = ["jolly-roger", "my-app", "demo-template", "foo", "a-b-c", "some_thing", "Cool Project"];

	for (const variant of DEFAULT_VARIANTS) {
		it(`${variant} matches change-case@4`, () => {
			for (const name of names) {
				const v4 = (changeCase4 as unknown as Record<string, (s: string) => string>)[variant];
				expect(typeof v4).toBe("function");
				expect(`${variant}(${name}) = ${CASE_FUNCTIONS[variant](name)}`).toBe(
					`${variant}(${name}) = ${v4(name)}`,
				);
			}
		});
	}

	it("produces the expected variants for the jolly-roger token", () => {
		const pairs = variantPairs("jolly-roger", "my-app");
		const map = Object.fromEntries(pairs.map((p) => [p.variant, [p.from, p.to]]));
		expect(map.paramCase).toEqual(["jolly-roger", "my-app"]);
		expect(map.capitalCase).toEqual(["Jolly Roger", "My App"]);
		expect(map.noCase).toEqual(["jolly roger", "my app"]);
		expect(map.pascalCase).toEqual(["JollyRoger", "MyApp"]);
		expect(map.constantCase).toEqual(["JOLLY_ROGER", "MY_APP"]);
		expect(map.headerCase).toEqual(["Jolly-Roger", "My-App"]);
	});

	it("de-duplicates collapsing variants so a single-word token cannot cascade", () => {
		// change-name applies all 11 variants unconditionally. For a one-word
		// token most variants collapse to the same string, and replacing twice
		// would rewrite the text the first pass just produced.
		const pairs = variantPairs("foo", "foobar");
		const froms = pairs.map((p) => p.from);
		expect(new Set(froms).size).toBe(froms.length);

		const result = applyRename([file("a.txt", "foo\n")], "foo", "foobar");
		expect(result.files[0]?.content.toString()).toBe("foobar\n");
	});
});

describe("rename transform", () => {
	it("replaces every case variant in file contents", () => {
		const input = [
			file(
				"a.ts",
				[
					'name: "demo-template"',
					"const demoTemplate = 1;",
					"DEMO_TEMPLATE",
					"Demo Template",
					"demo template",
					"demo_template",
					"demo/template",
					"demo.template",
					"Demo-Template",
				].join("\n"),
			),
		];
		const out = applyRename(input, "demo-template", "my-app").files[0];
		const text = out?.content.toString() ?? "";
		expect(text).toContain('name: "my-app"');
		expect(text).toContain("const myApp = 1;");
		expect(text).toContain("MY_APP");
		expect(text).toContain("My App");
		expect(text).toContain("my app");
		expect(text).toContain("my_app");
		expect(text).toContain("my/app");
		expect(text).toContain("my.app");
		expect(text).toContain("My-App");
		expect(text).not.toContain("demo");
	});

	it("renames files and nested directories", () => {
		const input = [
			file("src/demo-template/demo-template.ts", "x"),
			file("src/demo-template/nested/DemoTemplate.spec.ts", "x"),
		];
		const out = applyRename(input, "demo-template", "my-app").files.map((f) => f.path);
		expect(out).toEqual(["src/my-app/my-app.ts", "src/my-app/nested/MyApp.spec.ts"]);
	});

	it("passes binary content through byte-identical while still renaming the path", () => {
		const bytes = binaryWithToken("demo-template");
		const input = [file("assets/demo-template.png", bytes)];
		expect(input[0]?.binary).toBe(true);

		const out = applyRename(input, "demo-template", "my-app").files[0];
		expect(out?.path).toBe("assets/my-app.png");
		expect(out?.content.equals(bytes)).toBe(true);
	});

	it("regression: the utf-8 round-trip that corrupted binaries in create-jolly-roger", () => {
		// readFileSync(path, 'utf-8') does not throw on binary input, it
		// substitutes U+FFFD; writing it back changes the byte length.
		const bytes = binaryWithToken("demo-template");
		const naive = Buffer.from(bytes.toString("utf-8").split("demo-template").join("my-app"), "utf-8");
		expect(naive.length).not.toBe(bytes.length);

		const safe = applyRename([file("x.png", bytes)], "demo-template", "my-app").files[0];
		expect(safe?.content.length).toBe(bytes.length);
	});

	it("leaves skip-listed files completely alone", () => {
		const input = [file("pnpm-lock.yaml", "demo-template: 1\n", {skip: true})];
		const out = applyRename(input, "demo-template", "my-app").files[0];
		expect(out?.content.toString()).toBe("demo-template: 1\n");
		expect(out?.path).toBe("pnpm-lock.yaml");
	});

	it("preserves the executable bit", () => {
		const input = [file("scripts/demo-template.sh", "#!/bin/sh\necho demo-template\n", {executable: true})];
		const out = applyRename(input, "demo-template", "my-app").files[0];
		expect(out?.executable).toBe(true);
		expect(out?.path).toBe("scripts/my-app.sh");
	});
});

describe("the uniqueness gate", () => {
	it("passes when the transform is round-trippable", () => {
		const input = [file("a.ts", 'const x = "demo-template";\n')];
		expect(() => assertRoundTrip(input, "demo-template", "my-app")).not.toThrow();
	});

	it("fails when the target name already occurs in the template", () => {
		const input = [file("a.ts", 'const x = "demo-template";\n// unrelated mention of widget\n')];
		let error: RoundTripError | undefined;
		try {
			assertRoundTrip(input, "demo-template", "widget");
		} catch (err) {
			error = err as RoundTripError;
		}
		expect(error).toBeInstanceOf(RoundTripError);
		expect(error?.forward).not.toBe(error?.reverse);
		expect(error?.files).toContain("a.ts");
		expect(error?.report).toContain("Uniqueness check failed");
		expect(error?.report).toContain("--force");
	});

	it("reports the offending occurrences with file and line", () => {
		const input = [file("docs/readme.md", "line one\ndemo-template here\nwidget lives here\n")];
		try {
			assertRoundTrip(input, "demo-template", "widget");
			expect.unreachable("should have thrown");
		} catch (err) {
			const error = err as RoundTripError;
			expect(error.occurrences.some((o) => o.path === "docs/readme.md" && o.line === 3)).toBe(true);
		}
	});
});

describe("patterns transform", () => {
	it("applies context-anchored pairs in order", () => {
		const transform = createPatternsTransform({
			type: "patterns",
			patterns: [
				{from: '"jolly-roger"', to: '"my-app"'},
				{from: "Jolly Roger", to: (answers) => String(answers.title)},
			],
		});
		const out = transform.apply(
			[file("package.json", '{"name": "jolly-roger", "description": "Jolly Roger rules"}')],
			{name: "my-app", title: "My App"},
			ctx,
		);
		expect(out[0]?.content.toString()).toBe('{"name": "my-app", "description": "My App rules"}');
	});

	it("does not touch unanchored occurrences", () => {
		const transform = createPatternsTransform({
			type: "patterns",
			patterns: [{from: '"jolly-roger"', to: '"my-app"'}],
		});
		const out = transform.apply([file("a.md", "the jolly-roger flag")], {}, ctx);
		expect(out[0]?.content.toString()).toBe("the jolly-roger flag");
	});
});

describe("template transform", () => {
	it("expands placeholders only in the included files", () => {
		const transform = createTemplateTransform({type: "template", include: ["src/**/*.ts"]});
		const out = transform.apply(
			[file("src/a.ts", "const n = '{{ it.name }}';\n"), file("other.ts", "const n = '{{ it.name }}';\n")],
			{name: "my-app"},
			ctx,
		);
		expect(out[0]?.content.toString()).toBe("const n = 'my-app';\n");
		expect(out[1]?.content.toString()).toBe("const n = '{{ it.name }}';\n");
	});

	it("supports conditionals with the {{ }} tags", () => {
		const transform = createTemplateTransform({type: "template", include: ["*.md"]});
		const source = "{{ if (it.docs) { }}yes{{ } else { }}no{{ } }}\n";
		expect(transform.apply([file("a.md", source)], {docs: true}, ctx)[0]?.content.toString()).toBe("yes\n");
		expect(transform.apply([file("a.md", source)], {docs: false}, ctx)[0]?.content.toString()).toBe("no\n");
	});

	it("honours custom contentTags", () => {
		const transform = createTemplateTransform({type: "template", include: ["*.vue"]});
		const vueCtx: TransformContext = {...ctx, contentTags: ["<%", "%>"]};
		const out = transform.apply(
			[file("a.vue", "<template>{{ msg }}</template><!-- <%= it.name %> -->")],
			{name: "my-app"},
			vueCtx,
		);
		// Vue's own {{ msg }} survives untouched; only <% %> is expanded.
		expect(out[0]?.content.toString()).toBe("<template>{{ msg }}</template><!-- my-app -->");
	});

	it("treats a bare {{ name }} as output, not as a discarded statement", () => {
		// Eta outputs with `<%= %>`; a bare `{{ name }}` would otherwise
		// evaluate and emit nothing at all, silently.
		const transform = createTemplateTransform({type: "template", include: ["*.txt"]});
		const out = transform.apply(
			[file("a.txt", "name={{ name }} explicit={{= name }} dotted={{ it.name }}\n")],
			{name: "my-app"},
			ctx,
		);
		expect(out[0]?.content.toString()).toBe("name=my-app explicit=my-app dotted=my-app\n");
	});

	it("preserves surrounding whitespace exactly", () => {
		const transform = createTemplateTransform({type: "template", include: ["*.txt"]});
		const out = transform.apply([file("a.txt", "a\n\n{{ name }}\n\nb\n")], {name: "x"}, ctx);
		expect(out[0]?.content.toString()).toBe("a\n\nx\n\nb\n");
	});

	it("refuses to run without an include list", () => {
		expect(() => createTemplateTransform({type: "template", include: []})).toThrow(/opt-in/);
	});
});

describe("path interpolation", () => {
	it("substitutes simple variables", () => {
		expect(interpolatePath("src/{{name}}.ts", {name: "my-app"})).toBe("src/my-app.ts");
		expect(interpolatePath("src/{{ name }}/index.ts", {name: "my-app"})).toBe("src/my-app/index.ts");
	});

	it("refuses an expansion that would create directories", () => {
		expect(() => interpolatePath("src/{{name}}.ts", {name: "a/b"})).toThrow(/path separator/);
	});

	it("refuses an unknown variable", () => {
		expect(() => interpolatePath("src/{{nope}}.ts", {name: "x"})).toThrow(/not an answer/);
	});
});

describe("binary detection", () => {
	it("uses the extension lists", () => {
		expect(isText("a.ts")).toBe(true);
		expect(isBinary("a.png")).toBe(true);
		expect(isText("Makefile")).toBe(true);
	});

	it("sniffs content when the extension is unknown", () => {
		expect(looksBinary("LICENSE", Buffer.from("MIT License\n"))).toBe(false);
		expect(looksBinary("blob", Buffer.from([0x00, 0x01, 0x02, 0xff]))).toBe(true);
	});

	it("treats a token-bearing binary as binary", () => {
		expect(looksBinary("data.bin", binaryWithToken("demo-template"))).toBe(true);
	});
});

describe("variant coverage", () => {
	it("exposes exactly the change-name variant list", () => {
		const expected: CaseVariant[] = [
			"camelCase",
			"constantCase",
			"headerCase",
			"noCase",
			"paramCase",
			"pascalCase",
			"pathCase",
			"sentenceCase",
			"snakeCase",
			"capitalCase",
			"dotCase",
		];
		expect(DEFAULT_VARIANTS).toEqual(expected);
	});
});
