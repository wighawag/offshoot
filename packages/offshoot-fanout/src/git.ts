import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface GitResult {
	ok: boolean;
	status: number | null;
	stdout: string;
	stderr: string;
}

/** Run a git command in `cwd`, never throwing on non-zero exit. */
export function git(args: string[], cwd: string): GitResult {
	const r = spawnSync('git', args, {cwd, encoding: 'utf8'});
	return {
		ok: r.status === 0,
		status: r.status,
		stdout: r.stdout ?? '',
		stderr: r.stderr ?? '',
	};
}

/** Run a git command in `cwd`, feeding `input` on stdin (for plumbing like `mktree`). */
export function gitWithInput(
	args: string[],
	cwd: string,
	input: string,
): GitResult {
	const r = spawnSync('git', args, {cwd, encoding: 'utf8', input});
	return {
		ok: r.status === 0,
		status: r.status,
		stdout: r.stdout ?? '',
		stderr: r.stderr ?? '',
	};
}

/** Run an arbitrary shell command (the opt-in `verify` hook). */
export function runCommand(
	command: string,
	cwd: string,
): {ok: boolean; status: number | null; output: string} {
	const r = spawnSync(command, {cwd, shell: true, encoding: 'utf8'});
	return {
		ok: r.status === 0,
		status: r.status,
		output: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim(),
	};
}

/** Remote URL for `name` (e.g. "origin" / "stem"), or null if absent. */
export function getRemoteUrl(cwd: string, name: string): string | null {
	const r = git(['remote', 'get-url', name], cwd);
	return r.ok ? r.stdout.trim() : null;
}

/** All remote names configured in `cwd`. */
export function listRemotes(cwd: string): string[] {
	const r = git(['remote'], cwd);
	if (!r.ok) return [];
	return splitLines(r.stdout);
}

/** True if a remote named `name` exists. */
export function hasRemote(cwd: string, name: string): boolean {
	return listRemotes(cwd).includes(name);
}

/** Add a new remote; fails if it already exists. */
export function addRemote(cwd: string, name: string, url: string): GitResult {
	return git(['remote', 'add', name, url], cwd);
}

/** Set the URL of an existing remote (create-or-replace semantics not provided here). */
export function setRemoteUrl(
	cwd: string,
	name: string,
	url: string,
): GitResult {
	return git(['remote', 'set-url', name, url], cwd);
}

/** Rename a remote; fails if `from` is absent or `to` is taken. */
export function renameRemote(cwd: string, from: string, to: string): GitResult {
	return git(['remote', 'rename', from, to], cwd);
}

/** Create the remote if absent, or repoint it if present. */
export function addOrSetRemote(
	cwd: string,
	name: string,
	url: string,
): GitResult {
	if (hasRemote(cwd, name)) return setRemoteUrl(cwd, name, url);
	return addRemote(cwd, name, url);
}

/** True if `cwd` is inside a git work tree. */
export function isGitRepo(cwd: string): boolean {
	return git(['rev-parse', '--is-inside-work-tree'], cwd).ok;
}

/** The branch HEAD points at, or null when detached. */
export function currentBranch(cwd: string): string | null {
	const r = git(['symbolic-ref', '--quiet', '--short', 'HEAD'], cwd);
	if (!r.ok) return null;
	return r.stdout.trim() || null;
}

/** True if a local branch `refs/heads/<branch>` exists. */
export function branchExists(cwd: string, branch: string): boolean {
	return git(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], cwd)
		.ok;
}

/** True if `ref` resolves to a commit (branch, remote-tracking branch, sha…). */
export function refExists(cwd: string, ref: string): boolean {
	return git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], cwd).ok;
}

/** Commit a ref points at, or null. */
export function refSha(cwd: string, ref: string): string | null {
	const r = git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], cwd);
	return r.ok ? r.stdout.trim() || null : null;
}

/**
 * Contents of `file` at `ref` (`git show <ref>:<file>`) without touching the
 * working tree, or null when the ref or the path is absent.
 */
export function showFile(
	cwd: string,
	ref: string,
	file: string,
): string | null {
	const r = git(['show', `${ref}:${file}`], cwd);
	return r.ok ? r.stdout : null;
}

// ── worktrees ────────────────────────────────────────────────────────────────

export interface WorktreeInfo {
	/** Absolute path of the worktree. */
	path: string;
	/** Short branch name checked out there, or null when detached/bare. */
	branch: string | null;
	detached: boolean;
	bare: boolean;
	/** True for the repository's main worktree (always listed first by git). */
	main: boolean;
}

/** Every worktree of the repository containing `cwd`, main worktree first. */
export function listWorktrees(cwd: string): WorktreeInfo[] {
	const r = git(['worktree', 'list', '--porcelain'], cwd);
	if (!r.ok) return [];
	const infos: WorktreeInfo[] = [];
	let cur: WorktreeInfo | null = null;
	for (const raw of r.stdout.split('\n')) {
		const line = raw.trimEnd();
		if (line.startsWith('worktree ')) {
			cur = {
				path: line.slice('worktree '.length).trim(),
				branch: null,
				detached: false,
				bare: false,
				main: infos.length === 0,
			};
			infos.push(cur);
			continue;
		}
		if (!cur) continue;
		if (line.startsWith('branch '))
			cur.branch = line
				.slice('branch '.length)
				.trim()
				.replace(/^refs\/heads\//, '');
		else if (line === 'detached') cur.detached = true;
		else if (line === 'bare') cur.bare = true;
	}
	return infos;
}

function realPath(p: string): string {
	try {
		return fs.realpathSync(p).replace(/\/+$/, '');
	} catch {
		return path.resolve(p).replace(/\/+$/, '');
	}
}

/**
 * True when `cwd` is a **linked** worktree (`git worktree add`) rather than a
 * repository of its own: its `--git-dir` sits inside another repo's
 * `--git-common-dir`. A linked worktree shares every ref and object with its
 * parent, so treating it as a separate repo produces phantom merges.
 */
export function isLinkedWorktree(cwd: string): boolean {
	const gitDir = git(['rev-parse', '--absolute-git-dir'], cwd);
	const commonDir = git(['rev-parse', '--git-common-dir'], cwd);
	if (!gitDir.ok || !commonDir.ok) return false;
	const common = commonDir.stdout.trim();
	return (
		realPath(gitDir.stdout.trim()) !==
		realPath(path.isAbsolute(common) ? common : path.resolve(cwd, common))
	);
}

/** Path of the main worktree of the repository containing `cwd`. */
export function mainWorktreePath(cwd: string): string | null {
	const list = listWorktrees(cwd);
	return list.length > 0 ? list[0]!.path : null;
}

/** Create a linked worktree at `dir` with `branch` checked out. */
export function addWorktree(
	cwd: string,
	dir: string,
	branch: string,
): GitResult {
	return git(['worktree', 'add', '--quiet', dir, branch], cwd);
}

/** Remove a linked worktree (and prune its administrative entry). */
export function removeWorktree(cwd: string, dir: string): GitResult {
	const r = git(['worktree', 'remove', '--force', dir], cwd);
	git(['worktree', 'prune'], cwd);
	return r;
}

/** True if the working tree + index are clean. */
export function isClean(cwd: string): boolean {
	return git(['status', '--porcelain'], cwd).stdout.trim() === '';
}

/** Files with unresolved merge conflicts. */
export function conflictedFiles(cwd: string): string[] {
	const r = git(['diff', '--name-only', '--diff-filter=U'], cwd);
	if (!r.ok) return [];
	return splitLines(r.stdout);
}

/** Files staged in the index vs HEAD (after a `--no-commit` merge). */
export function stagedFiles(cwd: string): string[] {
	const r = git(['diff', '--name-only', '--cached'], cwd);
	if (!r.ok) return [];
	return splitLines(r.stdout);
}

/** Files changed by the most recent commit vs its first parent. */
export function mergeCommitFiles(cwd: string): string[] {
	const r = git(['diff', '--name-only', 'HEAD~1', 'HEAD'], cwd);
	if (!r.ok) return [];
	return splitLines(r.stdout);
}

/** Best-effort abort of an in-progress merge. */
export function mergeAbort(cwd: string): void {
	git(['merge', '--abort'], cwd);
}

/** All commit SHAs reachable from any ref (`git rev-list --all`). */
export function allCommits(cwd: string): string[] {
	const r = git(['rev-list', '--all'], cwd);
	if (!r.ok) return [];
	return splitLines(r.stdout);
}

/** Unix commit timestamp of HEAD, or null. Used only as a tie-break heuristic. */
export function headCommitDate(cwd: string): number | null {
	const r = git(['log', '-1', '--format=%ct', 'HEAD'], cwd);
	if (!r.ok) return null;
	const n = parseInt(r.stdout.trim(), 10);
	return Number.isNaN(n) ? null : n;
}

export interface CommitLog {
	sha: string;
	subject: string;
}

/**
 * Commits reachable from `toRef` but not from `fromRef`. Both are refs, never
 * HEAD: drift is per node, and a node's branch is usually not what is checked out.
 */
export function commitsBetween(
	cwd: string,
	fromRef: string,
	toRef: string,
): {ok: boolean; commits: CommitLog[]; error?: string} {
	const r = git(['log', '--format=%H%x09%s', `${fromRef}..${toRef}`], cwd);
	if (!r.ok)
		return {
			ok: false,
			commits: [],
			error: `log failed: ${(r.stderr || r.stdout).trim()}`,
		};
	const commits: CommitLog[] = [];
	for (const line of splitLines(r.stdout)) {
		const idx = line.indexOf('\t');
		if (idx === -1) continue;
		commits.push({sha: line.slice(0, idx), subject: line.slice(idx + 1)});
	}
	return {ok: true, commits};
}

/** Cherry-pick a commit onto the current branch. */
export function cherryPick(cwd: string, commit: string): GitResult {
	return git(['cherry-pick', commit], cwd);
}

/** Best-effort abort of an in-progress cherry-pick. */
export function cherryPickAbort(cwd: string): void {
	git(['cherry-pick', '--abort'], cwd);
}

/** Subject line of a commit (must already be present in the object db). */
export function commitSubject(cwd: string, commit: string): string | null {
	const r = git(['log', '-1', '--format=%s', commit], cwd);
	return r.ok ? r.stdout.trim() : null;
}

function splitLines(s: string): string[] {
	return s
		.split('\n')
		.map((l) => l.trim())
		.filter(Boolean);
}
