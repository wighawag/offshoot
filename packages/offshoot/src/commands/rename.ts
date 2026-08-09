/**
 * `offshoot rename <newName>`
 *
 * Owns the rename hazard instead of leaving it to bite on the next update:
 * re-transform the template branch at the CURRENT ref with the new name,
 * commit, and merge into the working branch. Afterwards both sides agree on
 * the name, so the next `offshoot update` is a normal template-only merge.
 */

import {resolve} from 'node:path';
import type {Logger, OffshootState} from '../types.js';
import {createLogger} from '../logger.js';
import * as g from '../git.js';
import {
	commitMessageFor,
	commitSnapshot,
	openProject,
	prepareTemplate,
	transformForState,
} from './common.js';

export interface RenameOptions {
	cwd: string;
	newName: string;
	/** Answer key holding the project name. Default "name". */
	answer?: string;
	force?: boolean;
	log?: Logger;
}

export interface RenameResult {
	from: string;
	to: string;
	conflicted: string[];
	renamed: boolean;
}

export async function rename(options: RenameOptions): Promise<RenameResult> {
	const log = options.log ?? createLogger();
	const project = openProject(resolve(options.cwd));
	const {root, state, branch, mainBranch} = project;
	const key = options.answer ?? 'name';

	if (mainBranch === branch) {
		throw new Error(
			`You are on the template branch ("${branch}"). Check out your own branch first.`,
		);
	}
	if (!g.isClean(root)) {
		throw new Error(
			`Working tree is not clean. Commit or stash first - the rename ends in a merge.\n\n${g.statusShort(root)}`,
		);
	}

	const current = state.answers[key];
	if (typeof current !== 'string') {
		throw new Error(
			`No "${key}" answer recorded, so there is nothing to rename.`,
		);
	}
	if (current === options.newName) {
		log.info(`Already named "${current}".`);
		return {from: current, to: options.newName, conflicted: [], renamed: false};
	}

	// The CURRENT ref, deliberately: a rename must change exactly one thing.
	log.info(
		`Renaming "${current}" -> "${options.newName}" at ${state.ref.slice(0, 7)} ...`,
	);
	const prepared = await prepareTemplate(state.template, state.ref);

	try {
		const nextState: OffshootState = {
			...state,
			answers: {...state.answers, [key]: options.newName},
		};

		const files = transformForState({
			prepared,
			state: nextState,
			operation: 'rename',
			force: options.force,
			log,
		});

		try {
			commitSnapshot({
				root,
				branch,
				files,
				message: commitMessageFor(
					state.template,
					state.ref,
					`rename ${current} -> ${options.newName}`,
				),
				// A rename must reach every file, including once-seeded ones.
				skipIfExists: [],
				log,
			});
		} catch (err) {
			g.gitTry(['checkout', '--force', mainBranch], root);
			throw err;
		}

		g.git(['checkout', mainBranch], root);
		const outcome = g.merge(
			root,
			branch,
			`offshoot: rename ${current} -> ${options.newName}`,
		);

		if (!outcome.ok) {
			log.warn('');
			log.warn(`Merge conflicts in ${outcome.conflicted.length} file(s):`);
			for (const f of outcome.conflicted) log.warn(`  ${f}`);
			log.warn('');
			log.warn(
				'These are places where you edited a line that also contains the name.',
			);
			log.warn('Resolve them, then:  git add -A && git commit');
			log.warn('Or back out entirely with:  git merge --abort');
			return {
				from: current,
				to: options.newName,
				conflicted: outcome.conflicted,
				renamed: false,
			};
		}

		log.info(`Renamed to "${options.newName}".`);
		return {from: current, to: options.newName, conflicted: [], renamed: true};
	} finally {
		prepared.cleanup();
	}
}
