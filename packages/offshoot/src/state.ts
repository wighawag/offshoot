/**
 * `.offshoot.json`: one file, at the project root, that the user never edits.
 *
 * It lives inside the transformed output, so it sits on the template branch
 * and its `ref` reaches `main` through the merge like any other template
 * change. It is deliberately not a key in package.json (the ref changes on
 * every update, and package managers rewrite package.json formatting on
 * install).
 */

import {existsSync, readFileSync} from "node:fs";
import {basename, join} from "node:path";
import {findConfigFile} from "./config.js";
import type {Answers, OffshootState, VirtualFile} from "./types.js";

export const STATE_FILE = ".offshoot.json";

/** Bumped only if the shape changes; `adopt` will need to read old shapes. */
export const STATE_VERSION = 1;

export function stateFilePath(root: string): string {
	return join(root, STATE_FILE);
}

export function readState(root: string): OffshootState {
	const file = stateFilePath(root);
	if (!existsSync(file)) {
		// A generated project never contains offshoot.config: it is excluded
		// from the output on every operation. So config-but-no-state means we
		// are standing in the TEMPLATE itself, where the project commands are
		// simply the wrong tool.
		const configFile = findConfigFile(root);
		if (configFile) {
			throw new Error(
				`${root} looks like a TEMPLATE repository (it has ${basename(configFile)}), not a project generated from one.\n` +
					`There is no ${STATE_FILE} here, and there should not be: it is created in the projects people scaffold FROM this template.\n` +
					`Template authors want \`offshoot doctor\`, which lints this repository.`,
			);
		}
		throw new Error(
			`No ${STATE_FILE} found in ${root}.\n` +
				`Either this is not the root of the project, or it has no link to a template - ` +
				`which is the case for a project scaffolded with \`--eject\`, or one that ran \`offshoot eject\`.`,
		);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(file, "utf8"));
	} catch (err) {
		throw new Error(`${file} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
	}
	const state = parsed as Partial<OffshootState>;
	if (!state || typeof state !== "object" || !state.template || !state.ref || !state.sourceName) {
		throw new Error(`${file} is missing required fields (template, ref, sourceName).`);
	}
	return {
		template: state.template,
		ref: state.ref,
		track: state.track,
		sourceName: state.sourceName,
		answers: state.answers ?? {},
		branch: state.branch,
		version: state.version,
	};
}

export function serializeState(state: OffshootState): string {
	// Stable key order and a trailing newline: this file is merged, so its
	// formatting must be boringly deterministic.
	const ordered: OffshootState = {
		template: state.template,
		ref: state.ref,
		...(state.track ? {track: state.track} : {}),
		sourceName: state.sourceName,
		answers: sortAnswers(state.answers),
		...(state.branch ? {branch: state.branch} : {}),
		version: state.version ?? STATE_VERSION,
	};
	return `${JSON.stringify(ordered, null, 2)}\n`;
}

function sortAnswers(answers: Answers): Answers {
	const out: Answers = {};
	for (const key of Object.keys(answers).sort()) {
		const value = answers[key];
		if (value !== undefined) out[key] = value;
	}
	return out;
}

/**
 * Added to the tree AFTER the transforms, so the recorded answers stay literal
 * (a transform must never rewrite the record of what it was given).
 */
export function stateFile(state: OffshootState): VirtualFile {
	return {
		path: STATE_FILE,
		content: Buffer.from(serializeState(state), "utf8"),
		executable: false,
		binary: false,
		skip: true,
	};
}
