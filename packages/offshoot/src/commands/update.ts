/**
 * `offshoot update [--ref <ref>]`
 *
 *   git checkout template
 *   (delete all tracked files, transform template@newref with the saved answers)
 *   git add -A && git commit -m "template: <template>@<newref>"
 *   git checkout main
 *   git merge template
 *
 * Note what is NOT here: copier has to regenerate the project from the OLD
 * template version to compute a diff, which is why it needs a "recover from a
 * broken update" escape hatch. offshoot never re-transforms an old ref - the
 * previous transformed snapshot is simply the previous commit on the template
 * branch.
 */

import {resolve} from "node:path";
import type {Answers, Logger, OffshootState} from "../types.js";
import {createLogger} from "../logger.js";
import {variantsOf} from "../case-variants.js";
import * as g from "../git.js";
import {commitMessageFor, commitSnapshot, openProject, prepareTemplate, transformForState} from "./common.js";
import {STATE_FILE} from "../state.js";

export interface UpdateOptions {
	cwd: string;
	ref?: string;
	force?: boolean;
	log?: Logger;
}

export interface UpdateResult {
	updated: boolean;
	upToDate: boolean;
	from: string;
	to: string;
	branch: string;
	mainBranch: string;
	conflicted: string[];
	message: string;
}

export async function update(options: UpdateOptions): Promise<UpdateResult> {
	const log = options.log ?? createLogger();
	const project = openProject(resolve(options.cwd));
	const {root, state, branch} = project;
	const mainBranch = project.mainBranch;

	if (mainBranch === branch) {
		throw new Error(
			`You are on the template branch ("${branch}"). Check out your own branch before updating.`,
		);
	}
	if (!g.isClean(root)) {
		throw new Error(
			`Working tree is not clean. Commit or stash first - the update ends in a merge.\n\n${g.statusShort(root)}`,
		);
	}

	assertNoNameDrift(root, state, branch, mainBranch);

	const track = options.ref ?? state.track;
	log.info(`Checking ${state.template}${track ? `#${track}` : ""} ...`);
	const prepared = await prepareTemplate(state.template, track);

	try {
		if (prepared.sha === state.ref && !options.force) {
			log.info(`Already up to date (${state.ref.slice(0, 7)}).`);
			return {
				updated: false,
				upToDate: true,
				from: state.ref,
				to: state.ref,
				branch,
				mainBranch,
				conflicted: [],
				message: "already up to date",
			};
		}

		const nextState: OffshootState = {
			...state,
			ref: prepared.sha,
			track: options.ref && !isFloating(options.ref) ? state.track : (prepared.track ?? state.track),
			sourceName: prepared.config.sourceName,
			// The branch name is fixed at scaffold time: it names a real git
			// branch in this repository, so a later template config cannot move it.
			branch: state.branch,
		};

		log.info(`Updating ${state.ref.slice(0, 7)} -> ${prepared.sha.slice(0, 7)} ...`);
		const files = transformForState({
			prepared,
			state: nextState,
			operation: "update",
			force: options.force,
			log,
		});

		let snapshot: {sha: string; changed: boolean};
		try {
			snapshot = commitSnapshot({
				root,
				branch,
				files,
				message: commitMessageFor(state.template, prepared.sha),
				skipIfExists: prepared.config.skipIfExists,
				log,
			});
		} catch (err) {
			// Never strand the user on the template branch.
			g.gitTry(["checkout", "--force", mainBranch], root);
			throw err;
		}

		g.git(["checkout", mainBranch], root);

		if (!snapshot.changed) {
			log.info("Template produced an identical snapshot; nothing to merge.");
			return {
				updated: false,
				upToDate: true,
				from: state.ref,
				to: prepared.sha,
				branch,
				mainBranch,
				conflicted: [],
				message: "no changes",
			};
		}

		const outcome = g.merge(root, branch, `offshoot: update to ${state.template}@${prepared.sha.slice(0, 7)}`);

		if (!outcome.ok) {
			log.warn("");
			log.warn(`Merge conflicts in ${outcome.conflicted.length} file(s):`);
			for (const f of outcome.conflicted) log.warn(`  ${f}`);
			log.warn("");
			log.warn("Resolve them, then:  git add -A && git commit");
			log.warn("Or back out entirely with:  git merge --abort");
			return {
				updated: false,
				upToDate: false,
				from: state.ref,
				to: prepared.sha,
				branch,
				mainBranch,
				conflicted: outcome.conflicted,
				message: "merge conflicts",
			};
		}

		log.info("");
		log.info(`Updated to ${state.template}@${prepared.sha.slice(0, 7)}.`);
		return {
			updated: true,
			upToDate: false,
			from: state.ref,
			to: prepared.sha,
			branch,
			mainBranch,
			conflicted: [],
			message: "updated",
		};
	} finally {
		prepared.cleanup();
	}
}

function isFloating(ref: string): boolean {
	return !/^[0-9a-f]{7,40}$/i.test(ref);
}

/**
 * The rename hazard. If the user renamed the project on their branch, the
 * template branch still holds the old name and the next update would try to
 * merge the old name back in, conflicting in every file. Refuse, and point at
 * the command that fixes it properly.
 */
export function assertNoNameDrift(
	root: string,
	state: OffshootState,
	branch: string,
	mainBranch: string,
): void {
	const templateState = readStateAt(root, branch);
	if (templateState) {
		const drifted = driftedAnswers(state.answers, templateState.answers);
		if (drifted.length > 0) {
			throw new Error(
				`${STATE_FILE} on "${mainBranch}" disagrees with branch "${branch}" for: ${drifted.join(", ")}.\n` +
					`The template branch has not been re-transformed with the current answers.\n` +
					`Run \`offshoot rename <newName>\` (for a name change) instead of editing ${STATE_FILE} by hand.`,
			);
		}
	}

	const name = state.answers.name;
	if (typeof name !== "string" || name === "") return;

	const terms = variantsOf(name);
	const onTemplate = filesContaining(root, branch, terms);
	if (onTemplate === 0) return;
	const onMain = filesContaining(root, mainBranch, terms);
	if (onMain > 0) return;

	throw new Error(
		`The name "${name}" recorded in ${STATE_FILE} no longer appears anywhere on "${mainBranch}", ` +
			`but still appears on the template branch "${branch}".\n` +
			`It looks like the project was renamed by hand. Updating now would merge the old name back in, ` +
			`conflicting in every file.\n` +
			`Run \`offshoot rename <newName>\` first, so the template branch is re-transformed with the new name.`,
	);
}

function driftedAnswers(mine: Answers, theirs: Answers): string[] {
	const keys = new Set([...Object.keys(mine), ...Object.keys(theirs)]);
	const out: string[] = [];
	for (const key of keys) {
		if (mine[key] !== theirs[key]) out.push(key);
	}
	return out;
}

function readStateAt(root: string, rev: string): OffshootState | undefined {
	const result = g.gitTry(["show", `${rev}:${STATE_FILE}`], root);
	if (result.status !== 0) return undefined;
	try {
		return JSON.parse(result.stdout) as OffshootState;
	} catch {
		return undefined;
	}
}

/**
 * Number of files at `rev` containing any of the terms. `.offshoot.json`
 * itself is excluded: it always records the name, so counting it would make
 * the drift check unable to ever fire.
 */
function filesContaining(root: string, rev: string, terms: string[]): number {
	const args = ["grep", "-I", "-F", "-l"];
	for (const term of terms) {
		if (term !== "") args.push("-e", term);
	}
	args.push(rev, "--", ".", `:(exclude)${STATE_FILE}`);
	const result = g.gitTry(args, root);
	if (result.status !== 0) return 0;
	return result.stdout.split("\n").filter((l) => l.trim() !== "").length;
}
