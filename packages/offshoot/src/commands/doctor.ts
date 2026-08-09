/**
 * `offshoot doctor`: the lint for TEMPLATE AUTHORS, run inside the template
 * repository.
 *
 * "Authors must pick a token unique enough to replace safely" is folklore
 * until there is a check for it. This is that check: it inventories every
 * occurrence of the source token, flags the ones that look like ordinary words
 * rather than project references, warns when the token is too short or too
 * generic, and runs the same round-trip gate a scaffold would.
 */

import {basename, resolve} from "node:path";
import type {CaseVariant, Logger} from "../types.js";
import {createLogger} from "../logger.js";
import {loadTemplateConfig, resolveConfig} from "../config.js";
import {readTree} from "../vfs.js";
import {DEFAULT_VARIANTS, variantPairs} from "../case-variants.js";
import {assertRoundTrip, RoundTripError} from "../transforms/rename.js";
import * as g from "../git.js";

export interface DoctorOptions {
	cwd: string;
	/** Override the token under test. */
	sourceName?: string;
	/** A realistic target name to probe with, e.g. what a user would type. */
	name?: string;
	/** Treat warnings as failures. */
	strict?: boolean;
	log?: Logger;
}

export interface DoctorOccurrence {
	path: string;
	line: number;
	variant: CaseVariant;
	text: string;
	/** Surrounded by prose rather than by code punctuation. */
	bare: boolean;
}

export interface DoctorResult {
	sourceName: string;
	files: number;
	occurrences: DoctorOccurrence[];
	filesWithToken: string[];
	errors: string[];
	warnings: string[];
	ok: boolean;
}

/** Tokens too generic to replace safely, whatever the repo. */
const GENERIC_TOKENS = new Set([
	"app",
	"api",
	"web",
	"lib",
	"core",
	"src",
	"test",
	"tests",
	"demo",
	"site",
	"main",
	"name",
	"node",
	"project",
	"template",
	"starter",
	"example",
	"boilerplate",
	"server",
	"client",
	"common",
	"utils",
	"tools",
	"config",
]);

/**
 * A character that anchors an occurrence to code rather than prose:
 * quotes, path and scope separators, identifier characters.
 */
const ANCHORS = new Set(['"', "'", "`", "/", "\\", "@", ":", ".", "-", "_", "=", "(", ")", "[", "]", "{", "}", ",", ";", "<", ">", "#", "$", "*", "+", "|", "&", "?", "!", "~", "%"]);

function isWordChar(ch: string | undefined): boolean {
	return ch !== undefined && /[A-Za-z0-9]/.test(ch);
}

function isAnchored(line: string, index: number, length: number): boolean {
	const before = index > 0 ? line[index - 1] : undefined;
	const after = index + length < line.length ? line[index + length] : undefined;
	if (isWordChar(before) || isWordChar(after)) return true;
	if (before !== undefined && ANCHORS.has(before)) return true;
	if (after !== undefined && ANCHORS.has(after)) return true;
	return false;
}

export async function doctor(options: DoctorOptions): Promise<DoctorResult> {
	const log = options.log ?? createLogger();
	const root = resolve(options.cwd);

	const {config: raw, file} = await loadTemplateConfig(root);
	const inferred =
		options.sourceName ??
		raw.sourceName ??
		(g.isRepo(root) ? basename(g.repoRoot(root)) : basename(root));
	const config = resolveConfig({...raw, sourceName: options.sourceName ?? raw.sourceName}, {
		inferredSourceName: inferred,
	});
	const sourceName = config.sourceName;

	const errors: string[] = [];
	const warnings: string[] = [];

	log.info(`Template: ${root}`);
	log.info(`Config:   ${file ? basename(file) : "(none - zero-config defaults)"}`);
	log.info(`Token:    "${sourceName}"`);
	log.info("");

	// --- token quality -----------------------------------------------------
	if (sourceName.length < 5) {
		warnings.push(
			`Token "${sourceName}" is only ${sourceName.length} characters. Short tokens collide with ordinary words and identifiers.`,
		);
	}
	if (!/[-_. ]/.test(sourceName)) {
		warnings.push(
			`Token "${sourceName}" is a single word. Two-word tokens (like "jolly-roger") are far less likely to appear by accident.`,
		);
	}
	if (GENERIC_TOKENS.has(sourceName.toLowerCase())) {
		errors.push(`Token "${sourceName}" is a generic word and will match text that has nothing to do with the project.`);
	}

	// --- occurrence inventory ---------------------------------------------
	const files = readTree(root, {
		skipDirs: config.skipDirs,
		skipFiles: config.skipFiles,
		exclude: config.exclude,
	});

	const variants = variantPairs(sourceName, sourceName, DEFAULT_VARIANTS);
	const occurrences: DoctorOccurrence[] = [];
	const filesWithToken = new Set<string>();

	for (const vf of files) {
		if (vf.skip) continue;

		// Paths count too: a file or directory named after the token is renamed
		// by the same transform.
		for (const {from} of variants) {
			if (from !== "" && vf.path.includes(from)) filesWithToken.add(vf.path);
		}
		if (vf.binary) continue;

		const lines = vf.content.toString("utf8").split("\n");
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i] ?? "";
			for (const {variant, from} of variants) {
				if (from === "") continue;
				let index = line.indexOf(from);
				while (index !== -1) {
					filesWithToken.add(vf.path);
					occurrences.push({
						path: vf.path,
						line: i + 1,
						variant,
						text: line.trim().slice(0, 160),
						bare: !isAnchored(line, index, from.length),
					});
					index = line.indexOf(from, index + from.length);
				}
			}
		}
	}

	const bare = occurrences.filter((o) => o.bare);

	log.info(`Scanned ${files.length} file(s).`);
	log.info(`Found ${occurrences.length} occurrence(s) in ${filesWithToken.size} file(s).`);
	log.info("");

	if (occurrences.length === 0) {
		errors.push(
			`No occurrence of "${sourceName}" found. Scaffolding would produce a project with the template's name unchanged.`,
		);
	}

	const byFile = new Map<string, DoctorOccurrence[]>();
	for (const o of occurrences) {
		const list = byFile.get(o.path) ?? [];
		list.push(o);
		byFile.set(o.path, list);
	}
	for (const [path, list] of [...byFile.entries()].sort()) {
		const kinds = new Set(list.map((o) => o.variant));
		log.info(`  ${path}  (${list.length}x: ${[...kinds].join(", ")})`);
	}
	log.info("");

	if (bare.length > 0) {
		warnings.push(
			`${bare.length} occurrence(s) look like ordinary words rather than project references (no quote, path separator or identifier character next to them):`,
		);
		for (const o of bare.slice(0, 20)) {
			warnings.push(`    ${o.path}:${o.line}  [${o.variant}]  ${o.text}`);
		}
		if (bare.length > 20) warnings.push(`    ... and ${bare.length - 20} more`);
	}

	// --- round-trip probe --------------------------------------------------
	const probe = options.name ?? "offshoot-probe-name";
	try {
		assertRoundTrip(files, sourceName, probe);
		log.info(`Round-trip check passed for "${sourceName}" -> "${probe}".`);
	} catch (err) {
		if (err instanceof RoundTripError) {
			errors.push(`Round-trip check FAILED for "${sourceName}" -> "${probe}".`);
			errors.push(...err.report.split("\n").map((l) => `  ${l}`));
		} else {
			throw err;
		}
	}
	if (!options.name) {
		log.info(`  (probe name; re-run with --name <realistic-name> to test a name your users would pick)`);
	}
	log.info("");

	for (const w of warnings) log.warn(`warning: ${w}`);
	for (const e of errors) log.warn(`error:   ${e}`);

	const ok = errors.length === 0 && (!options.strict || warnings.length === 0);
	log.info("");
	log.info(ok ? "doctor: ok" : "doctor: problems found");

	return {
		sourceName,
		files: files.length,
		occurrences,
		filesWithToken: [...filesWithToken].sort(),
		errors,
		warnings,
		ok,
	};
}
