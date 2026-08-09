/**
 * Package-manager detection, used for exactly one thing: refreshing a lockfile
 * after `--eject` removed a dependency from package.json.
 *
 * Without this, an ejected project ships a package.json with no `offshoot` in
 * it and a lockfile that still lists it. A plain `install` self-heals, but
 * `pnpm install --frozen-lockfile` and `npm ci` - the CI defaults - fail
 * outright. Committing that state would hand every ejected project a broken
 * first CI run.
 *
 * Strictly best effort: offshoot is a file-and-git tool, so a missing package
 * manager, no network, or any other failure downgrades to a clear warning and
 * never fails the scaffold.
 */

import {execFileSync} from "node:child_process";
import {existsSync, readFileSync} from "node:fs";
import {join} from "node:path";
import type {Logger} from "./types.js";

export type PackageManagerName = "pnpm" | "npm" | "yarn" | "bun";

export interface PackageManager {
	name: PackageManagerName;
	/** The lockfile that was found, relative to the project root. */
	lockfile?: string;
	/** How it was identified, for the log. */
	via: "packageManager field" | "lockfile" | "default";
}

const LOCKFILES: {file: string; name: PackageManagerName}[] = [
	{file: "pnpm-lock.yaml", name: "pnpm"},
	{file: "package-lock.json", name: "npm"},
	{file: "npm-shrinkwrap.json", name: "npm"},
	{file: "yarn.lock", name: "yarn"},
	{file: "bun.lock", name: "bun"},
	{file: "bun.lockb", name: "bun"},
];

/** `packageManager: "pnpm@10.28.1"` first, then whichever lockfile is present. */
export function detectPackageManager(root: string): PackageManager | undefined {
	const lock = LOCKFILES.find((entry) => existsSync(join(root, entry.file)));

	const declared = readPackageManagerField(root);
	if (declared) return {name: declared, lockfile: lock?.file, via: "packageManager field"};
	if (lock) return {name: lock.name, lockfile: lock.file, via: "lockfile"};
	return undefined;
}

function readPackageManagerField(root: string): PackageManagerName | undefined {
	const file = join(root, "package.json");
	if (!existsSync(file)) return undefined;
	try {
		const pkg = JSON.parse(readFileSync(file, "utf8")) as {packageManager?: unknown};
		if (typeof pkg.packageManager !== "string") return undefined;
		const name = pkg.packageManager.split("@")[0];
		if (name === "pnpm" || name === "npm" || name === "yarn" || name === "bun") return name;
		return undefined;
	} catch {
		return undefined;
	}
}

/**
 * The command that rewrites the lockfile WITHOUT installing anything.
 * `undefined` where no such command reliably exists, rather than guessing at
 * a flag and producing a confusing error.
 */
export function lockfileOnlyCommand(pm: PackageManagerName): string[] | undefined {
	switch (pm) {
		case "pnpm":
			return ["install", "--lockfile-only", "--ignore-scripts"];
		case "npm":
			return ["install", "--package-lock-only", "--ignore-scripts"];
		case "yarn":
			// Berry only; yarn 1 has no equivalent and fails, which we treat
			// like any other failure: a warning.
			return ["install", "--mode", "update-lockfile"];
		case "bun":
			return undefined;
	}
}

export interface RefreshResult {
	refreshed: boolean;
	packageManager?: PackageManager;
	reason?: string;
}

/**
 * Bring the lockfile back in line with a package.json we just edited.
 * Returns what happened; the caller decides what to say about it.
 */
export function refreshLockfile(root: string, log: Logger): RefreshResult {
	const pm = detectPackageManager(root);
	if (!pm) return {refreshed: false, reason: "no package manager detected"};
	if (!pm.lockfile) return {refreshed: false, packageManager: pm, reason: "no lockfile in the template"};

	const command = lockfileOnlyCommand(pm.name);
	if (!command) {
		return {refreshed: false, packageManager: pm, reason: `${pm.name} has no lockfile-only install`};
	}

	try {
		execFileSync(pm.name, command, {
			cwd: root,
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 180_000,
			env: {...process.env, ADBLOCK: "1", DISABLE_OPENCOLLECTIVE: "1", CI: "1"},
		});
	} catch (err) {
		const message = err instanceof Error ? err.message.split("\n")[0] : String(err);
		return {refreshed: false, packageManager: pm, reason: message ?? "install failed"};
	}

	log.debug(`refreshed ${pm.lockfile} with ${pm.name}`);
	return {refreshed: true, packageManager: pm};
}

/** The message shown when the lockfile could not be refreshed. */
export function staleLockfileWarning(result: RefreshResult, removed: string[]): string[] {
	const lockfile = result.packageManager?.lockfile;
	const pm = result.packageManager?.name ?? "your package manager";
	if (!lockfile) return [];
	return [
		`${lockfile} still references ${removed.join(", ")} (${result.reason}).`,
		`  Run \`${pm} install\` to bring it back in line; \`${pm === "npm" ? "npm ci" : `${pm} install --frozen-lockfile`}\` will fail until you do.`,
	];
}
