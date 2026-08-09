/**
 * Reading a directory into the in-memory tree, and writing it back out.
 * Nothing between those two points touches the filesystem.
 */

import {readdirSync, readFileSync, statSync, mkdirSync, writeFileSync, chmodSync, rmSync} from "node:fs";
import {join, dirname, posix} from "node:path";
import {looksBinary} from "./text-binary/index.js";
import type {VirtualFile} from "./types.js";
import {matchesAny} from "./glob.js";

export interface ReadTreeOptions {
	skipDirs: string[];
	skipFiles: string[];
	/** Globs dropped entirely; they never reach the generated project. */
	exclude: string[];
}

/** Always dropped: git metadata and offshoot's own template-side config. */
const ALWAYS_EXCLUDED_DIRS = new Set([".git"]);
const ALWAYS_EXCLUDED_FILES = new Set([
	"offshoot.config.json",
	"offshoot.config.js",
	"offshoot.config.mjs",
	"offshoot.config.cjs",
	"offshoot.config.ts",
	"offshoot.config.mts",
]);

export function readTree(root: string, options: ReadTreeOptions): VirtualFile[] {
	const skipDirs = new Set(options.skipDirs);
	const skipFiles = new Set(options.skipFiles);
	const files: VirtualFile[] = [];

	const walk = (dir: string, rel: string, inSkippedTree: boolean): void => {
		for (const entry of readdirSync(dir, {withFileTypes: true})) {
			const name = entry.name;
			const childRel = rel ? posix.join(rel, name) : name;
			const childAbs = join(dir, name);

			if (entry.isDirectory()) {
				if (ALWAYS_EXCLUDED_DIRS.has(name)) continue;
				if (matchesAny(childRel, options.exclude)) continue;
				walk(childAbs, childRel, inSkippedTree || skipDirs.has(name));
				continue;
			}

			// Symlinks are materialised as their target's bytes by the tarball
			// fetch; anything still a link here is not a regular file.
			if (!entry.isFile()) continue;
			if (rel === "" && ALWAYS_EXCLUDED_FILES.has(name)) continue;
			if (matchesAny(childRel, options.exclude)) continue;

			const st = statSync(childAbs);
			const content = readFileSync(childAbs);
			files.push({
				path: childRel,
				content,
				executable: (st.mode & 0o111) !== 0,
				binary: looksBinary(childRel, content),
				skip: inSkippedTree || skipFiles.has(name),
			});
		}
	};

	walk(root, "", false);
	files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	return files;
}

export function writeTree(root: string, files: VirtualFile[]): void {
	for (const file of files) {
		const target = join(root, ...file.path.split("/"));
		mkdirSync(dirname(target), {recursive: true});
		writeFileSync(target, file.content);
		chmodSync(target, file.executable ? 0o755 : 0o644);
	}
}

/** Remove every file listed, plus any directory left empty behind them. */
export function removePaths(root: string, paths: string[]): void {
	for (const p of paths) {
		const target = join(root, ...p.split("/"));
		rmSync(target, {force: true, recursive: true});
	}
	for (const p of paths) {
		let dir = dirname(join(root, ...p.split("/")));
		while (dir.startsWith(root) && dir !== root) {
			try {
				if (readdirSync(dir).length > 0) break;
				rmSync(dir, {recursive: true});
			} catch {
				break;
			}
			dir = dirname(dir);
		}
	}
}

