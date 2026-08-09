/**
 * Thin wrapper over the `git` binary. Requiring git is a deliberate choice:
 * git IS the merge engine, so there is no merge algorithm here to get wrong.
 */

import {execFileSync} from "node:child_process";

export class GitError extends Error {
	readonly stdout: string;
	readonly stderr: string;
	readonly status: number;

	constructor(args: string[], status: number, stdout: string, stderr: string) {
		super(`git ${args.join(" ")} failed (exit ${status})\n${stderr || stdout}`);
		this.name = "GitError";
		this.status = status;
		this.stdout = stdout;
		this.stderr = stderr;
	}
}

export interface GitResult {
	stdout: string;
	stderr: string;
	status: number;
}

export function git(args: string[], cwd: string): string {
	const result = gitTry(args, cwd);
	if (result.status !== 0) throw new GitError(args, result.status, result.stdout, result.stderr);
	return result.stdout;
}

export function gitTry(args: string[], cwd: string): GitResult {
	try {
		const stdout = execFileSync("git", args, {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			maxBuffer: 64 * 1024 * 1024,
		});
		return {stdout: stdout ?? "", stderr: "", status: 0};
	} catch (err) {
		const e = err as {status?: number; stdout?: string | Buffer; stderr?: string | Buffer; message?: string};
		return {
			stdout: e.stdout ? e.stdout.toString() : "",
			stderr: e.stderr ? e.stderr.toString() : (e.message ?? ""),
			status: typeof e.status === "number" ? e.status : 1,
		};
	}
}

export function assertGitAvailable(): void {
	try {
		execFileSync("git", ["--version"], {stdio: "ignore"});
	} catch {
		throw new Error("offshoot requires the `git` binary on PATH.");
	}
}

export function isRepo(cwd: string): boolean {
	return gitTry(["rev-parse", "--git-dir"], cwd).status === 0;
}

export function repoRoot(cwd: string): string {
	return git(["rev-parse", "--show-toplevel"], cwd).trim();
}

export function currentBranch(cwd: string): string {
	return git(["rev-parse", "--abbrev-ref", "HEAD"], cwd).trim();
}

export function branchExists(cwd: string, branch: string): boolean {
	return gitTry(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], cwd).status === 0;
}

export function isClean(cwd: string): boolean {
	return git(["status", "--porcelain"], cwd).trim() === "";
}

export function statusShort(cwd: string): string {
	return git(["status", "--short"], cwd).trim();
}

export function trackedFiles(cwd: string): string[] {
	const out = git(["ls-files", "-z"], cwd);
	return out.split("\0").filter((p) => p !== "");
}

export function headSha(cwd: string, rev = "HEAD"): string {
	return git(["rev-parse", rev], cwd).trim();
}

/** Commit whatever is staged. Identity is supplied only if the repo/user has none. */
export function commit(cwd: string, message: string): void {
	const args = ["-c", "core.hooksPath=/dev/null"];
	if (!hasIdentity(cwd)) {
		args.push("-c", "user.name=offshoot", "-c", "user.email=offshoot@localhost");
	}
	git([...args, "commit", "--no-verify", "-m", message], cwd);
}

export function hasIdentity(cwd: string): boolean {
	return (
		gitTry(["config", "user.name"], cwd).status === 0 && gitTry(["config", "user.email"], cwd).status === 0
	);
}

export function hasCommits(cwd: string): boolean {
	return gitTry(["rev-parse", "--verify", "HEAD"], cwd).status === 0;
}

export function stagedIsEmpty(cwd: string): boolean {
	return gitTry(["diff", "--cached", "--quiet"], cwd).status === 0;
}

export interface MergeOutcome {
	ok: boolean;
	conflicted: string[];
	output: string;
}

export function merge(cwd: string, branch: string, message: string): MergeOutcome {
	const args = ["-c", "core.hooksPath=/dev/null"];
	if (!hasIdentity(cwd)) {
		args.push("-c", "user.name=offshoot", "-c", "user.email=offshoot@localhost");
	}
	const result = gitTry([...args, "merge", "--no-edit", "-m", message, branch], cwd);
	if (result.status === 0) return {ok: true, conflicted: [], output: result.stdout};
	const conflicted = gitTry(["diff", "--name-only", "--diff-filter=U"], cwd)
		.stdout.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);
	return {ok: false, conflicted, output: `${result.stdout}\n${result.stderr}`.trim()};
}

/** `user/repo` or a URL or a local path -> the SHA a ref points at. */
export function lsRemote(remote: string, ref?: string): {sha: string; ref: string} | undefined {
	const args = ["ls-remote", remote];
	if (ref) args.push(ref, `refs/tags/${ref}`, `refs/heads/${ref}`);
	const result = gitTry(args, process.cwd());
	if (result.status !== 0) return undefined;

	const lines = result.stdout
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean)
		.map((l) => {
			const [sha, name] = l.split("\t");
			return {sha: (sha ?? "").trim(), ref: (name ?? "").trim()};
		})
		.filter((e) => e.sha !== "");

	if (lines.length === 0) return undefined;

	// Prefer an annotated tag's commit, then a branch, then anything.
	const peeled = lines.find((l) => l.ref.endsWith("^{}"));
	if (peeled) return {sha: peeled.sha, ref: peeled.ref.replace(/\^\{\}$/, "")};
	const head = lines.find((l) => l.ref.startsWith("refs/heads/"));
	if (head) return head;
	const tag = lines.find((l) => l.ref.startsWith("refs/tags/"));
	if (tag) return tag;
	return lines[0];
}

/** The remote's default branch name (what a bare `user/repo` tracks). */
export function defaultBranchOf(remote: string): string | undefined {
	const result = gitTry(["ls-remote", "--symref", remote, "HEAD"], process.cwd());
	if (result.status !== 0) return undefined;
	const match = /^ref:\s+refs\/heads\/(\S+)\s+HEAD$/m.exec(result.stdout);
	return match?.[1];
}
