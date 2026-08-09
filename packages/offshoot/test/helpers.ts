/**
 * Integration harness: real git repositories in real temp directories.
 * That is how this design was validated, so that is how it is tested.
 */

import {execFileSync} from "node:child_process";
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import {silentLogger} from "../src/logger.js";

export const quietLog = silentLogger;

const created: string[] = [];

export function tempDir(prefix = "offshoot-test-"): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	created.push(dir);
	return dir;
}

export function cleanupTempDirs(): void {
	while (created.length > 0) {
		const dir = created.pop();
		if (!dir) continue;
		try {
			rmSync(dir, {recursive: true, force: true});
		} catch {
			/* best effort */
		}
	}
}

export function git(args: string[], cwd: string): string {
	return execFileSync("git", args, {cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"]});
}

export function writeFile(root: string, path: string, content: string | Buffer, executable = false): void {
	const target = join(root, ...path.split("/"));
	mkdirSync(dirname(target), {recursive: true});
	writeFileSync(target, content);
	if (executable) chmodSync(target, 0o755);
}

export function readFile(root: string, path: string): string {
	return readFileSync(join(root, ...path.split("/")), "utf8");
}

export function readBytes(root: string, path: string): Buffer {
	return readFileSync(join(root, ...path.split("/")));
}

export function exists(root: string, path: string): boolean {
	return existsSync(join(root, ...path.split("/")));
}

export interface TemplateRepo {
	dir: string;
	/** Commit the current working tree and return the new SHA. */
	commit(message: string): string;
	head(): string;
}

/**
 * A template repository the tests can evolve commit by commit, exactly like a
 * real template author would.
 */
export function createTemplateRepo(
	files: Record<string, string | Buffer> = {},
	/**
	 * The repository DIRECTORY name. With zero config, offshoot infers the
	 * source token from it, exactly as `wighawag/jolly-roger` gives
	 * `jolly-roger`, so the fixture has to be named like a real template repo.
	 */
	repoName = "demo-template",
): TemplateRepo {
	const parent = tempDir("offshoot-template-");
	const dir = join(parent, repoName);
	mkdirSync(dir, {recursive: true});
	git(["init", "-b", "main"], dir);
	git(["config", "user.name", "Template Author"], dir);
	git(["config", "user.email", "author@example.com"], dir);
	git(["config", "commit.gpgsign", "false"], dir);

	for (const [path, content] of Object.entries(files)) writeFile(dir, path, content);

	const repo: TemplateRepo = {
		dir,
		commit(message: string) {
			git(["add", "-A"], dir);
			git(["commit", "--no-verify", "-m", message], dir);
			return repo.head();
		},
		head() {
			return git(["rev-parse", "HEAD"], dir).trim();
		},
	};

	if (Object.keys(files).length > 0) repo.commit("initial template");
	return repo;
}

/** The default fixture: a small but realistic "working project" template. */
export function defaultTemplateFiles(): Record<string, string | Buffer> {
	return {
		"package.json": JSON.stringify({name: "demo-template", version: "0.0.0"}, null, 2) + "\n",
		"README.md": "# Demo Template\n\nThe demo-template project.\n",
		"src/index.ts": 'export const NAME = "demo-template";\n',
		"src/demo-template/config.ts": 'export const id = "demo-template";\n',
	};
}

export function logOf(root: string, rev = "HEAD"): string[] {
	return git(["log", "--format=%s", rev], root).trim().split("\n").filter(Boolean);
}

export function branchOf(root: string): string {
	return git(["rev-parse", "--abbrev-ref", "HEAD"], root).trim();
}

export function isClean(root: string): boolean {
	return git(["status", "--porcelain"], root).trim() === "";
}

export function trackedFiles(root: string): string[] {
	return git(["ls-files"], root).trim().split("\n").filter(Boolean);
}

/** A tiny binary blob that deliberately contains the source token. */
export function binaryWithToken(token: string): Buffer {
	return Buffer.concat([
		Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x00]),
		Buffer.from(token, "utf8"),
		Buffer.from([0x00, 0x80, 0x81, 0x00, 0xff]),
	]);
}
