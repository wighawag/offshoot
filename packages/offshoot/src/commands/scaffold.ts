/**
 * `offshoot new <template> [dir]`
 *
 * Puts the transformed template on an orphan branch, then branches the working
 * branch off it:
 *
 *   git init -b template
 *   (transform template@R with the answers into the directory)
 *   git add -A && git commit -m "template: <template>@<ref>"
 *   git checkout -b main
 *
 * That single extra branch is what makes `offshoot update` a plain `git merge`
 * for the rest of the project's life.
 */

import {existsSync, mkdirSync, readdirSync} from "node:fs";
import {basename, resolve} from "node:path";
import type {Answers, Logger, OffshootState} from "../types.js";
import {askAnswers, parseAnswerAssignment} from "../prompt.js";
import {buildTree} from "../pipeline.js";
import {stateFile, STATE_FILE} from "../state.js";
import {writeTree} from "../vfs.js";
import {createLogger} from "../logger.js";
import {emptyEjectReport} from "../transforms/eject-integration.js";
import {refreshLockfile, staleLockfileWarning} from "../package-manager.js";
import * as g from "../git.js";
import {commitMessageFor, prepareTemplate} from "./common.js";
import {defaultTrack} from "../source.js";

export interface ScaffoldOptions {
	/** `user/repo`, `github:user/repo`, `user/repo#ref`, or a local path. */
	template: string;
	/** Raw args, as a per-template wrapper would forward them. */
	argv?: string[];
	/** Target directory. Defaults to the project name. */
	dir?: string;
	/** Pre-supplied answers; anything missing is prompted for. */
	answers?: Answers;
	ref?: string;
	cwd?: string;
	/** Proceed despite a failed uniqueness check. */
	force?: boolean;
	/**
	 * Scaffold with NO link to the template: no template branch, no
	 * `.offshoot.json`, and the integration stripped. `offshoot update` will
	 * never work in this project, which is the point.
	 */
	eject?: boolean;
	nonInteractive?: boolean;
	/** Set false to write files without creating a repository (rarely useful). */
	git?: boolean;
	log?: Logger;
}

export interface ScaffoldResult {
	dir: string;
	template: string;
	ref: string;
	track?: string;
	sourceName: string;
	answers: Answers;
	/** The template branch, or undefined when scaffolded with --eject. */
	branch?: string;
	mainBranch: string;
	files: number;
	/** True when the project has no link to the template. */
	ejected: boolean;
}

export interface ParsedScaffoldArgs {
	positionals: string[];
	answers: Answers;
	ref?: string;
	force: boolean;
	eject: boolean;
	nonInteractive: boolean;
}

export function parseScaffoldArgs(argv: string[]): ParsedScaffoldArgs {
	const positionals: string[] = [];
	const answers: Answers = {};
	let ref: string | undefined;
	let force = false;
	let eject = false;
	let nonInteractive = false;

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] ?? "";
		if (arg === "--ref") {
			ref = argv[++i];
		} else if (arg.startsWith("--ref=")) {
			ref = arg.slice("--ref=".length);
		} else if (arg === "--answer" || arg === "-a") {
			const pair = parseAnswerAssignment(argv[++i] ?? "");
			if (pair) answers[pair[0]] = pair[1];
		} else if (arg.startsWith("--answer=")) {
			const pair = parseAnswerAssignment(arg.slice("--answer=".length));
			if (pair) answers[pair[0]] = pair[1];
		} else if (arg === "--force" || arg === "-f") {
			force = true;
		} else if (arg === "--eject") {
			eject = true;
		} else if (arg === "--yes" || arg === "-y" || arg === "--non-interactive") {
			nonInteractive = true;
		} else if (arg.startsWith("-")) {
			throw new Error(`Unknown option "${arg}".`);
		} else {
			const pair = parseAnswerAssignment(arg);
			// `eject` is reserved. `npm create` forwards positionals directly but
			// needs a `--` separator for flags, so `eject=true` is the spelling
			// that survives `npm create offshoot user/repo my-app eject=true`.
			if (pair && pair[0] === "eject") eject = pair[1] === true;
			else if (pair) answers[pair[0]] = pair[1];
			else positionals.push(arg);
		}
	}

	return {positionals, answers, ref, force, eject, nonInteractive};
}

export async function scaffold(options: ScaffoldOptions): Promise<ScaffoldResult> {
	const log = options.log ?? createLogger();
	const cwd = resolve(options.cwd ?? process.cwd());
	const parsed = parseScaffoldArgs(options.argv ?? []);

	g.assertGitAvailable();

	// A wrapper passes `<name> [dir]`; `offshoot new <template> [dir]` passes
	// just `[dir]`. Treating the first positional as both name and directory
	// makes the two spellings agree.
	const [first, second] = parsed.positionals;
	let dirArg = options.dir ?? second ?? first;
	const nameFromArgs = first ? basename(resolve(cwd, first)) : undefined;

	const provided: Answers = {
		...(nameFromArgs ? {name: nameFromArgs} : {}),
		...parsed.answers,
		...(options.answers ?? {}),
	};

	const ref = options.ref ?? parsed.ref;
	log.info(`Fetching ${options.template}${ref ? `#${ref}` : ""} ...`);
	const prepared = await prepareTemplate(options.template, ref);

	try {
		const track = prepared.track ?? (await defaultTrack(prepared.source));
		log.debug(`resolved ${prepared.source.id} to ${prepared.sha}`);
		if (prepared.configFile) log.debug(`using ${prepared.configFile} from the template`);

		const answers = await askAnswers({
			prompts: prepared.config.prompts,
			provided,
			nonInteractive: options.nonInteractive ?? parsed.nonInteractive,
		});

		if (!dirArg) {
			const name = answers.name;
			if (typeof name !== "string" || name === "") {
				throw new Error("No target directory given and no `name` answer to derive one from.");
			}
			dirArg = name;
		}
		const target = resolve(cwd, dirArg);

		if (existsSync(target) && readdirSync(target).length > 0) {
			throw new Error(`Directory "${target}" already exists and is not empty.`);
		}

		const state: OffshootState = {
			template: prepared.source.id,
			ref: prepared.sha,
			track,
			sourceName: prepared.config.sourceName,
			answers,
			...(prepared.config.branch !== "template" ? {branch: prepared.config.branch} : {}),
		};

		const eject = options.eject ?? parsed.eject;
		const ejectReport = emptyEjectReport();

		log.info(`Transforming template (${prepared.config.sourceName} -> ${answers.name ?? "?"}) ...`);
		const transformed = buildTree({
			dir: prepared.dir,
			config: prepared.config,
			answers,
			template: state.template,
			ref: state.ref,
			operation: "scaffold",
			force: options.force ?? parsed.force,
			eject,
			ejectReport,
			log,
		});

		// The state file is what makes a project updatable, so an ejected
		// project simply never gets one.
		const withoutState = transformed.filter((f) => f.path !== STATE_FILE);
		const files = eject ? withoutState : [...withoutState, stateFile(state)];

		mkdirSync(target, {recursive: true});

		const branch = prepared.config.branch;
		const useGit = options.git !== false;
		let mainBranch = "main";

		if (useGit && eject) {
			// A plain repository: one branch, one commit, no template branch.
			// Provenance stays in the commit message for humans; nothing links
			// the project to the template mechanically.
			mainBranch = defaultBranchName(target);
			g.git(["init", "-b", mainBranch], target);
			writeTree(target, files);
			// Before the commit, so the very first commit is self-consistent.
			settleLockfile(target, ejectReport.dependencies, log);
			g.git(["add", "-A"], target);
			g.commit(target, `Initial commit from ${state.template}@${state.ref.slice(0, 7)}`);
		} else if (useGit) {
			g.git(["init", "-b", branch], target);
			writeTree(target, files);
			g.git(["add", "-A"], target);
			g.commit(target, commitMessageFor(state.template, state.ref));

			mainBranch = preferredMainBranch(target, branch);
			g.git(["checkout", "-b", mainBranch], target);
		} else {
			writeTree(target, files);
			if (eject) settleLockfile(target, ejectReport.dependencies, log);
		}

		log.info("");
		log.info(`Created ${dirArg} from ${prepared.source.id}@${prepared.sha.slice(0, 7)}`);
		if (useGit && eject) {
			log.info(`  no template link: this is a plain repository on "${mainBranch}".`);
			log.info(`  \`offshoot update\` will not work here, by design.`);
		} else if (useGit) {
			log.info(`  branch "${mainBranch}" is yours; branch "${branch}" tracks the template.`);
			log.info(`  run \`offshoot update\` later to merge template improvements.`);
		}

		return {
			ejected: eject,
			dir: target,
			template: state.template,
			ref: state.ref,
			track,
			sourceName: state.sourceName,
			answers,
			branch: eject ? undefined : branch,
			mainBranch,
			files: files.length,
		};
	} finally {
		prepared.cleanup();
	}
}

/**
 * Respect `init.defaultBranch`, unless it collides with the template branch
 * (a repo whose default branch is literally "template" would otherwise have
 * nowhere to put the user's work).
 */
/**
 * Removing a dependency from package.json leaves the lockfile listing it.
 * A plain `install` self-heals, but `--frozen-lockfile` / `npm ci` do not, so
 * fix it before the state is committed. Best effort by design: a warning is a
 * fine outcome, a failed scaffold is not.
 */
export function settleLockfile(root: string, removedDependencies: string[], log: Logger): void {
	if (removedDependencies.length === 0) return;

	const result = refreshLockfile(root, log);
	if (result.refreshed) {
		log.info(`  updated ${result.packageManager?.lockfile} (removed ${removedDependencies.join(", ")})`);
		return;
	}
	for (const line of staleLockfileWarning(result, removedDependencies)) log.warn(`  ${line}`);
}

function defaultBranchName(cwd: string): string {
	const configured = g.gitTry(["config", "init.defaultBranch"], cwd).stdout.trim();
	return configured !== "" ? configured : "main";
}

function preferredMainBranch(cwd: string, templateBranch: string): string {
	const candidate = defaultBranchName(cwd);
	if (candidate === templateBranch) return templateBranch === "main" ? "trunk" : "main";
	return candidate;
}
