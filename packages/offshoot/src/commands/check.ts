/**
 * `offshoot check`: is a newer template ref available?
 * Exits non-zero when there is one, so CI can watch for template drift.
 */

import {resolve} from "node:path";
import type {Logger} from "../types.js";
import {createLogger} from "../logger.js";
import {readState} from "../state.js";
import {parseSource, resolveRef, defaultTrack} from "../source.js";
import * as g from "../git.js";

export interface CheckOptions {
	cwd: string;
	ref?: string;
	log?: Logger;
}

export interface CheckResult {
	current: string;
	latest: string;
	track?: string;
	behind: boolean;
}

export async function check(options: CheckOptions): Promise<CheckResult> {
	const log = options.log ?? createLogger();
	const cwd = resolve(options.cwd);
	g.assertGitAvailable();
	const root = g.isRepo(cwd) ? g.repoRoot(cwd) : cwd;
	const state = readState(root);

	const source = parseSource(state.template);
	const track = options.ref ?? state.track ?? (await defaultTrack(source));
	const resolved = await resolveRef(source, track);

	const behind = resolved.sha !== state.ref;
	if (behind) {
		log.info(`Update available: ${state.ref.slice(0, 7)} -> ${resolved.sha.slice(0, 7)}`);
		log.info(`  ${state.template}${track ? `#${track}` : ""}`);
		log.info(`  run \`offshoot update\``);
	} else {
		log.info(`Up to date (${state.ref.slice(0, 7)}).`);
	}

	return {current: state.ref, latest: resolved.sha, track, behind};
}
