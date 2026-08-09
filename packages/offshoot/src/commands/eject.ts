/**
 * `offshoot eject`: cut the link permanently.
 *
 * The same thing `offshoot new --eject` does, only years later: delete the
 * template branch and `.offshoot.json`, remove the integration from every
 * package.json, drop the files the template declares as update-only, and
 * settle the lockfile. "Eject" must mean the same thing whether it happens at
 * generation time or long after, or the flag and the command are a trap.
 *
 * The declared part needs the template's config, which means fetching the
 * recorded ref. That is best effort: offline, you still get the automatic
 * part, which needs no config at all.
 */

import {existsSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import type {EjectConfig, Logger} from '../types.js';
import {createLogger} from '../logger.js';
import {readState, stateFilePath, STATE_FILE} from '../state.js';
import {
	stripPackageJsonSource,
	isPackageJson,
} from '../transforms/eject-integration.js';
import {refreshLockfile, staleLockfileWarning} from '../package-manager.js';
import {matchesAny} from '../glob.js';
import {prepareTemplate} from './common.js';
import * as g from '../git.js';

export interface EjectOptions {
	cwd: string;
	/** Stage the removal but leave it uncommitted. */
	noCommit?: boolean;
	/** Skip the template fetch; only offshoot's own traces are removed. */
	offline?: boolean;
	log?: Logger;
}

export interface EjectResult {
	branchDeleted: boolean;
	branch: string;
	committed: boolean;
	/** package.json entries removed, as "path: section.name". */
	removed: string[];
	/** Files deleted because the template declared them update-only. */
	filesRemoved: string[];
	lockfileRefreshed: boolean;
}

const NO_DECLARED_EJECT: Required<EjectConfig> = {
	exclude: [],
	packageJson: {dependencies: [], devDependencies: [], scripts: []},
};

export async function eject(options: EjectOptions): Promise<EjectResult> {
	const log = options.log ?? createLogger();
	g.assertGitAvailable();
	const cwd = resolve(options.cwd);
	if (!g.isRepo(cwd)) throw new Error(`${cwd} is not a git repository.`);
	const root = g.repoRoot(cwd);
	const state = readState(root);
	const branch = state.branch ?? 'template';

	if (g.currentBranch(root) === branch) {
		throw new Error(
			`You are on the template branch ("${branch}"). Check out your own branch first.`,
		);
	}
	if (!g.isClean(root)) {
		throw new Error(
			`Working tree is not clean. Commit or stash first.\n\n${g.statusShort(root)}`,
		);
	}

	// What the template declares as update-only. Absent config (or no network)
	// still leaves the automatic rules below.
	let declared = NO_DECLARED_EJECT;
	if (!options.offline) {
		try {
			const prepared = await prepareTemplate(state.template, state.ref);
			declared = prepared.config.eject;
			prepared.cleanup();
		} catch (err) {
			log.warn(
				`  could not read the template config (${err instanceof Error ? err.message : String(err)});` +
					` removing offshoot's own traces only.`,
			);
		}
	}

	const tracked = g.trackedFiles(root);

	// 1. package.json entries, in every package of the tree.
	const removed: string[] = [];
	const removedDependencies: string[] = [];
	for (const path of tracked) {
		if (!isPackageJson(path)) continue;
		const absolute = join(root, ...path.split('/'));
		if (!existsSync(absolute)) continue;

		const source = readFileSync(absolute, 'utf8');
		const stripped = stripPackageJsonSource(source, declared.packageJson);
		if (!stripped) continue;

		writeFileSync(absolute, stripped.content);
		for (const entry of stripped.removed) {
			removed.push(`${path}: ${entry}`);
			const [section, ...rest] = entry.split('.');
			const name = rest.join('.');
			if (
				(section === 'dependencies' || section === 'devDependencies') &&
				!removedDependencies.includes(name)
			) {
				removedDependencies.push(name);
			}
		}
	}

	// 2. Files the template declares as update-only.
	const filesRemoved: string[] = [];
	for (const path of tracked) {
		if (!matchesAny(path, declared.exclude)) continue;
		rmSync(join(root, ...path.split('/')), {force: true});
		filesRemoved.push(path);
	}

	// 3. The state file, which is what makes the project updatable at all.
	const file = stateFilePath(root);
	if (existsSync(file)) rmSync(file);

	// 4. The lockfile, now that package.json changed.
	let lockfileRefreshed = false;
	if (removedDependencies.length > 0) {
		const result = refreshLockfile(root, log);
		lockfileRefreshed = result.refreshed;
		if (!result.refreshed) {
			for (const line of staleLockfileWarning(result, removedDependencies))
				log.warn(`  ${line}`);
		}
	}

	// 5. The branch.
	let branchDeleted = false;
	if (g.branchExists(root, branch)) {
		g.git(['branch', '-D', branch], root);
		branchDeleted = true;
	}

	g.git(['add', '-A'], root);
	let committed = false;
	if (!options.noCommit && !g.stagedIsEmpty(root)) {
		g.commit(root, `offshoot: eject from ${state.template}`);
		committed = true;
	}

	log.info(`Ejected from ${state.template}.`);
	log.info(
		`  removed ${STATE_FILE}${branchDeleted ? ` and branch "${branch}"` : ''}`,
	);
	for (const entry of removed) log.info(`  removed ${entry}`);
	for (const path of filesRemoved) log.info(`  removed ${path}`);
	if (lockfileRefreshed) log.info(`  updated the lockfile`);
	log.info(
		`  this is permanent: \`offshoot update\` can no longer merge template changes.`,
	);

	return {
		branchDeleted,
		branch,
		committed,
		removed,
		filesRemoved,
		lockfileRefreshed,
	};
}
