/**
 * `--eject`: scaffold a project with NO link to the template.
 *
 * Some people just want the code. They are not going to update, they do not
 * want a second branch in their fresh repository, and they certainly do not
 * want a dependency on the tool that generated it. `offshoot new ... --eject`
 * gives them a plain `git init` + one commit, and this transform removes the
 * integration itself.
 *
 * Two levels, with a deliberate boundary:
 *
 *  - AUTOMATIC, for offshoot's own traces. A dependency literally named
 *    `offshoot` and any script that invokes the `offshoot` binary ARE the
 *    integration by definition, so they go without the author declaring
 *    anything. That keeps `--eject` meaningful for zero-config templates.
 *  - DECLARED, for everything else, via `eject` in offshoot.config. Files
 *    cannot be guessed at (an `UPDATING.md` is not detectable), so removing
 *    them stays explicit.
 *
 * package.json is edited structurally, preserving the file's own indentation
 * and trailing newline, and files that end up unchanged are left byte-identical.
 */

import type {Answers, EjectConfig, Transform, TransformContext, VirtualFile} from "../types.js";

/** The dependency name that IS the integration. */
const SELF = "offshoot";

/**
 * Matches a script that INVOKES the offshoot binary: "offshoot update",
 * "npx offshoot check", "pnpm build && offshoot check".
 *
 * Deliberately anchored to command position (start of the script, or after a
 * shell operator, optionally behind a runner). A script that merely mentions
 * the word, like `echo see offshoot docs`, is not an invocation and is left
 * alone - and `offshoot-deploy` is a different binary entirely.
 */
const INVOKES_SELF =
	/(?:^|&&|\|\||;|\||\()\s*(?:npx\s+|pnpm\s+(?:exec\s+|dlx\s+)?|yarn\s+(?:dlx\s+)?|bunx\s+)?offshoot(?:@[^\s]+)?(?:\s|$)/;

type Json = Record<string, unknown>;

export function isPackageJson(path: string): boolean {
	return path === "package.json" || path.endsWith("/package.json");
}

/** Indentation the file already uses, so an edit does not reformat it. */
export function detectIndent(source: string): string | number {
	const match = /\n([ \t]+)"/.exec(source);
	const indent = match?.[1];
	if (indent === undefined) return 2;
	return indent.includes("\t") ? "\t" : indent.length;
}

export interface StripResult {
	json: Json;
	removed: string[];
}

function stripPackageJson(json: Json, declared: Required<EjectConfig>["packageJson"]): StripResult {
	const removed: string[] = [];

	for (const field of ["dependencies", "devDependencies"] as const) {
		const section = json[field];
		if (!section || typeof section !== "object") continue;
		const deps = section as Json;

		const names = new Set<string>([SELF, ...(declared[field] ?? [])]);
		for (const name of names) {
			if (name in deps) {
				delete deps[name];
				removed.push(`${field}.${name}`);
			}
		}
		// An empty section is noise; drop the key entirely.
		if (Object.keys(deps).length === 0) delete json[field];
	}

	const scripts = json.scripts;
	if (scripts && typeof scripts === "object") {
		const entries = scripts as Json;
		const declaredNames = new Set(declared.scripts ?? []);
		for (const name of Object.keys(entries)) {
			const command = entries[name];
			const invokesSelf = typeof command === "string" && INVOKES_SELF.test(command);
			if (declaredNames.has(name) || invokesSelf) {
				delete entries[name];
				removed.push(`scripts.${name}`);
			}
		}
		if (Object.keys(entries).length === 0) delete json.scripts;
	}

	return {json, removed};
}

/**
 * Strip a package.json given as text, preserving its own indentation and
 * trailing newline. Returns undefined when there was nothing to remove, so
 * callers can leave the file byte-identical.
 *
 * Shared by the scaffold-time transform and the `offshoot eject` command, so
 * "eject" means exactly the same thing whether it happens at generation time
 * or years later.
 */
export function stripPackageJsonSource(
	source: string,
	declared: Required<EjectConfig>["packageJson"],
): {content: string; removed: string[]} | undefined {
	let parsed: Json;
	try {
		parsed = JSON.parse(source) as Json;
	} catch {
		return undefined;
	}

	const {json, removed} = stripPackageJson(parsed, declared);
	if (removed.length === 0) return undefined;

	const trailingNewline = source.endsWith("\n") ? "\n" : "";
	return {content: JSON.stringify(json, null, detectIndent(source)) + trailingNewline, removed};
}

/** Accumulates what a run removed, so the caller knows the lockfile is stale. */
export interface EjectReport {
	/** e.g. "devDependencies.offshoot", "scripts.update" */
	removed: string[];
	/** Dependency names removed, which are what a lockfile cares about. */
	dependencies: string[];
	files: string[];
}

export function emptyEjectReport(): EjectReport {
	return {removed: [], dependencies: [], files: []};
}

export function recordRemoval(report: EjectReport, file: string, removed: string[]): void {
	report.files.push(file);
	for (const entry of removed) {
		report.removed.push(`${file}: ${entry}`);
		const [section, ...rest] = entry.split(".");
		const name = rest.join(".");
		if ((section === "dependencies" || section === "devDependencies") && !report.dependencies.includes(name)) {
			report.dependencies.push(name);
		}
	}
}

export function createEjectTransform(config: Required<EjectConfig>, report?: EjectReport): Transform {
	return {
		name: "eject-integration",
		apply(files: VirtualFile[], _answers: Answers, ctx: TransformContext): VirtualFile[] {
			return files.map((file) => {
				if (file.skip || file.binary || !isPackageJson(file.path)) return file;

				const source = file.content.toString("utf8");
				const stripped = stripPackageJsonSource(source, config.packageJson);
				if (!stripped) {
					// Either nothing to remove, or malformed JSON in the template.
					// Neither is a reason to fail a scaffold.
					return file;
				}

				if (report) recordRemoval(report, file.path, stripped.removed);
				ctx.log.debug(`eject: ${file.path} - removed ${stripped.removed.join(", ")}`);
				return {...file, content: Buffer.from(stripped.content, "utf8")};
			});
		},
	};
}
