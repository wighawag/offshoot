import {spawnSync} from 'node:child_process';

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

/** Commits reachable from HEAD but not from the fetched ref (candidate backports). Fetches objects only. */
export function commitsAhead(
	cwd: string,
	fetchUrl: string,
	branch: string,
): {
	ok: boolean;
	commits: CommitLog[];
	error?: string;
} {
	const f = git(['fetch', fetchUrl, branch], cwd);
	if (!f.ok)
		return {
			ok: false,
			commits: [],
			error: `fetch failed: ${(f.stderr || f.stdout).trim()}`,
		};
	const r = git(['log', '--format=%H%x09%s', 'FETCH_HEAD..HEAD'], cwd);
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
