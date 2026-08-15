/**
 * Shared plumbing: locating a project, fetching + configuring a ref, and
 * writing a transformed snapshot onto the template branch.
 */

import {readFileSync, rmSync, statSync} from 'node:fs';
import {basename, join, resolve} from 'node:path';
import type {
	Logger,
	Operation,
	OffshootState,
	ResolvedConfig,
	VirtualFile,
} from '../types.js';
import {loadTemplateConfig, resolveConfig} from '../config.js';
import {
	parseSource,
	resolveRef,
	downloadTemplate,
	type ParsedSource,
} from '../source.js';
import {buildTree} from '../pipeline.js';
import {readState, stateFile, STATE_FILE} from '../state.js';
import {writeTree, removePaths} from '../vfs.js';
import * as g from '../git.js';
import {matchesAny} from '../glob.js';

export interface PreparedTemplate {
	source: ParsedSource;
	sha: string;
	track?: string;
	dir: string;
	config: ResolvedConfig;
	configFile?: string;
	cleanup(): void;
}

export async function prepareTemplate(
	templateInput: string,
	ref: string | undefined,
): Promise<PreparedTemplate> {
	const source = parseSource(templateInput);
	const resolved = await resolveRef(source, ref);
	const dir = await downloadTemplate(source, resolved.sha);
	const {config: raw, file} = await loadTemplateConfig(dir);
	const config = resolveConfig(raw, {inferredSourceName: source.inferredName});
	return {
		source,
		sha: resolved.sha,
		track: resolved.track,
		dir,
		config,
		configFile: file ? basename(file) : undefined,
		cleanup: () => {
			try {
				rmSync(dir, {recursive: true, force: true});
			} catch {
				/* temp dir, best effort */
			}
		},
	};
}

export interface ProjectHandle {
	root: string;
	state: OffshootState;
	branch: string;
	mainBranch: string;
}

export function openProject(cwd: string): ProjectHandle {
	const start = resolve(cwd);
	g.assertGitAvailable();
	if (!g.isRepo(start)) {
		throw new Error(
			`${start} is not a git repository. offshoot needs the repository it created.`,
		);
	}
	const root = g.repoRoot(start);
	const state = readState(root);
	const branch = state.branch ?? 'template';
	if (!g.branchExists(root, branch)) {
		throw new Error(
			`Branch "${branch}" not found. It is the template branch offshoot merges from; ` +
				`if it was deleted, the link to the template is gone (see \`offshoot eject\`).`,
		);
	}
	return {root, state, branch, mainBranch: g.currentBranch(root)};
}

export interface SnapshotOptions {
	root: string;
	branch: string;
	files: VirtualFile[];
	message: string;
	skipIfExists: string[];
	log: Logger;
}

/**
 * Replace the whole content of the template branch with a fresh transformed
 * snapshot, and commit it. This is the entire "merge algorithm": git computes
 * the diff between two snapshots of the same lineage, and `git merge` applies
 * it to the user's work.
 */
export function commitSnapshot(options: SnapshotOptions): {
	sha: string;
	changed: boolean;
} {
	const {root, branch, files} = options;

	g.git(['checkout', branch], root);

	const previous = g.trackedFiles(root);
	const preserved = new Map<string, {content: Buffer; executable: boolean}>();

	// `skipIfExists`: seeded once at scaffold, never updated. Keeping the
	// previous bytes means the branch shows no diff for them, so the merge
	// cannot touch (or conflict with) the user's version.
	if (options.skipIfExists.length > 0) {
		for (const path of previous) {
			if (!matchesAny(path, options.skipIfExists)) continue;
			try {
				const absolute = join(root, ...path.split('/'));
				preserved.set(path, {
					content: readFileSync(absolute),
					executable: (statSync(absolute).mode & 0o111) !== 0,
				});
			} catch {
				/* vanished; treat as absent */
			}
		}
	}

	removePaths(root, previous);

	const toWrite = files.filter((f) => !preserved.has(f.path));
	writeTree(root, toWrite);
	for (const [path, entry] of preserved) {
		writeTree(root, [
			{
				path,
				content: entry.content,
				executable: entry.executable,
				binary: true,
				skip: true,
			},
		]);
	}

	g.git(['add', '-A'], root);
	if (g.hasCommits(root) && g.stagedIsEmpty(root)) {
		options.log.debug('template branch unchanged; nothing to commit');
		return {sha: g.headSha(root), changed: false};
	}
	g.commit(root, options.message);
	return {sha: g.headSha(root), changed: true};
}

export interface TransformForStateOptions {
	prepared: PreparedTemplate;
	state: OffshootState;
	operation: Operation;
	force?: boolean;
	log: Logger;
}

/** Build the tree for a known state (used by update and rename). */
export function transformForState(
	options: TransformForStateOptions,
): VirtualFile[] {
	const {prepared, state} = options;
	const files = buildTree({
		dir: prepared.dir,
		config: prepared.config,
		answers: state.answers,
		template: state.template,
		ref: state.ref,
		operation: options.operation,
		force: options.force,
		log: options.log,
	});
	return [...files.filter((f) => f.path !== STATE_FILE), stateFile(state)];
}

export function commitMessageFor(
	template: string,
	sha: string,
	note?: string,
): string {
	const short = sha.slice(0, 7);
	return note
		? `template: ${template}@${short} (${note})`
		: `template: ${template}@${short}`;
}

export {STATE_FILE};
