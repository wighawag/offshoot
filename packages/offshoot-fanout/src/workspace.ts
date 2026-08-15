/**
 * Where a merge actually happens.
 *
 * The node being merged is a `(repo, branch)` pair, and that branch is usually
 * NOT the one the user has checked out. `git checkout` is not an option: it
 * mutates the user's working state and dies on a dirty tree. So:
 *
 *   - branch checked out somewhere already -> merge in place, in that worktree
 *     (the user finds the conflict where they expect it, `--leave-conflicts`
 *     behaves as documented, and a dirty tree only blocks that one branch);
 *   - otherwise -> a temporary linked worktree, removed afterwards, KEPT when a
 *     conflict is left in place (otherwise its path is the only way back to it).
 */

import {randomUUID} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
	addWorktree,
	branchExists,
	listWorktrees,
	removeWorktree,
} from './git.js';

export interface Workspace {
	/** Directory to run the merge in. */
	dir: string;
	branch: string;
	/** True when this is a throwaway worktree created by us. */
	temporary: boolean;
	/** True when `dir` is the repository's main worktree. */
	main: boolean;
}

export type OpenWorkspace =
	{ok: true; workspace: Workspace} | {ok: false; error: string};

/**
 * Name (do not create) a temporary worktree directory. `git worktree add` must
 * be the one that creates it — it refuses an existing path, which is the safe
 * direction — so nothing here races with anything on a shared /tmp.
 */
function tempWorktreeDir(repoPath: string, branch: string): string {
	const slug = `${path.basename(repoPath)}-${branch}`.replace(
		/[^A-Za-z0-9._-]+/g,
		'-',
	);
	const root = path.join(os.tmpdir(), 'offshoot-fanout-worktrees');
	fs.mkdirSync(root, {recursive: true, mode: 0o700});
	return path.join(root, `${slug}-${randomUUID().slice(0, 8)}`);
}

/**
 * Resolve (creating one if needed) the worktree in which `branch` of `repoPath`
 * can be merged.
 */
export function openWorkspace(repoPath: string, branch: string): OpenWorkspace {
	const worktrees = listWorktrees(repoPath);
	const existing = worktrees.find((w) => w.branch === branch);
	if (existing) {
		return {
			ok: true,
			workspace: {
				dir: existing.path,
				branch,
				temporary: false,
				main: existing.main,
			},
		};
	}
	if (!branchExists(repoPath, branch)) {
		return {ok: false, error: `branch \`${branch}\` does not exist`};
	}
	const dir = tempWorktreeDir(repoPath, branch);
	const added = addWorktree(repoPath, dir, branch);
	if (!added.ok) {
		return {
			ok: false,
			error: `could not create a worktree for \`${branch}\`: ${(
				added.stderr || added.stdout
			).trim()}`,
		};
	}
	return {ok: true, workspace: {dir, branch, temporary: true, main: false}};
}

/** Remove a temporary workspace. Never touches a pre-existing worktree. */
export function closeWorkspace(repoPath: string, workspace: Workspace): void {
	if (!workspace.temporary) return;
	removeWorktree(repoPath, workspace.dir);
	fs.rmSync(workspace.dir, {recursive: true, force: true});
}
