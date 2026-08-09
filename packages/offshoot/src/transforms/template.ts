/**
 * Strategy 3: `template`. Placeholder expansion with Eta v4.
 *
 * Opt-in only, and restricted to an explicit glob list, so a template can use
 * placeholders in a handful of files while the rest of the project stays a
 * working, unmarked codebase that its own build, type checker and tests still
 * accept.
 *
 * Eta defaults to `<% %>`; offshoot overrides it to `{{ }}`, and lets a
 * template override that again through `contentTags` (a Vue template needs to,
 * since `{{ }}` is Vue's own interpolation syntax).
 */

import {Eta} from "eta";
import type {Answers, TemplateSpec, Transform, TransformContext, VirtualFile} from "../types.js";
import {matchesAny} from "../glob.js";

/** Reserved words that can legitimately open or close an Eta code tag. */
const KEYWORDS = new Set([
	"if",
	"else",
	"for",
	"while",
	"do",
	"switch",
	"case",
	"break",
	"continue",
	"return",
	"function",
	"const",
	"let",
	"var",
	"new",
	"typeof",
	"delete",
	"in",
	"of",
	"try",
	"catch",
	"finally",
	"throw",
]);

const BARE_REFERENCE = /^\s*[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[[^\]]*\])*\s*$/;

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Eta outputs with `<%= %>`, so with `{{ }}` tags a bare `{{ name }}` is an
 * expression STATEMENT: it evaluates and emits nothing, silently. Nobody
 * writing `{{ name }}` in a template means "discard this", and path
 * interpolation already spells it exactly that way, so a tag whose whole body
 * is a plain reference is promoted to an output tag.
 *
 * `{{= x }}`, `{{ if (x) { }}`, `{{ } }}` and friends are left alone.
 */
export function normalizeOutputTags(source: string, tags: [string, string]): string {
	const [open, close] = tags;
	const pattern = new RegExp(`${escapeRegExp(open)}([\\s\\S]*?)${escapeRegExp(close)}`, "g");
	return source.replace(pattern, (whole, body: string) => {
		if (/^[=~_*/#-]/.test(body.trimStart()[0] ?? "")) return whole;
		if (!BARE_REFERENCE.test(body)) return whole;
		const root = body.trim().split(/[.[]/)[0] ?? "";
		if (KEYWORDS.has(root)) return whole;
		return `${open}= ${body.trim()} ${close}`;
	});
}

export function createTemplateTransform(spec: TemplateSpec): Transform {
	if (!spec.include || spec.include.length === 0) {
		throw new Error(
			"template transform: `include` is required. Placeholder expansion is opt-in and must be scoped to specific files.",
		);
	}

	return {
		name: "template",
		apply(files: VirtualFile[], answers: Answers, ctx: TransformContext): VirtualFile[] {
			// autoTrim off: a scaffolder must not silently reformat whitespace.
			// useWith on: answers are available as bare names, and as `it.name`.
			const eta = new Eta({
				tags: ctx.contentTags,
				autoEscape: false,
				autoTrim: false,
				useWith: true,
			});

			return files.map((file) => {
				if (file.skip || file.binary) return file;
				if (!matchesAny(file.path, spec.include)) return file;
				if (matchesAny(file.path, spec.exclude)) return file;

				const source = file.content.toString("utf8");
				let rendered: string;
				try {
					rendered = eta.renderString(normalizeOutputTags(source, ctx.contentTags), {...answers});
				} catch (err) {
					throw new Error(
						`template transform: failed to render ${file.path}: ${err instanceof Error ? err.message : String(err)}`,
					);
				}
				if (rendered === source) return file;
				return {...file, content: Buffer.from(rendered, "utf8")};
			});
		},
	};
}
