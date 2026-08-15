/**
 * Repo primitives: what a repo is, how repos are found on disk, and how a
 * child's parent remote is matched to a parent's `origin`.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
	getRemoteUrl,
	isGitRepo,
	isLinkedWorktree,
	mainWorktreePath,
} from './git.js';

/** Default name of the parent-template remote. */
export const DEFAULT_REMOTE = 'stem';

export interface Repo {
	name: string;
	path: string;
	/** `origin` remote URL: the repo's own identity. */
	originUrl: string | null;
	/** Parent-template remote URL (named `remoteName`, default `stem`), or null. */
	originalUrl: string | null;
}

export interface Tree {
	repos: Repo[];
	/** normalized originUrl -> repo, for resolving a child's parent remote to a local clone. */
	byOrigin: Map<string, Repo>;
}

/** A linked worktree found while scanning: never a repo, only ever a mention. */
export interface LinkedWorktree {
	/** Absolute path of the linked worktree. */
	path: string;
	name: string;
	/** Path of the repository it belongs to. */
	mainPath: string;
	mainName: string;
}

/**
 * Normalize a git remote URL to a canonical, comparable form:
 *   git@github.com:wighawag/x.git   ->  https://github.com/wighawag/x
 *   https://github.com/Wighawag/X   ->  https://github.com/wighawag/x
 *   /abs/local/path                 ->  /abs/local/path (lowercased)
 */
export function normalizeUrl(url: string): string {
	let s = url.trim();
	s = s.replace(/\.git$/, '');
	s = s.replace(/^git@([^:]+):/, 'https://$1/');
	s = s.replace(/^ssh:\/\/git@([^:/]+)\/?/, 'https://$1/');
	s = s.replace(/^ssh:\/\//, 'https://');
	s = s.replace(/^git:\/\//, 'https://');
	s = s.replace(/^https:\/\/git@/, 'https://');
	s = s.toLowerCase();
	return s;
}

export function samePath(a: string, b: string): boolean {
	return path.resolve(a) === path.resolve(b);
}

export function repoFromPath(p: string, remoteName: string): Repo {
	return {
		name: path.basename(p),
		path: p,
		originUrl: isGitRepo(p) ? getRemoteUrl(p, 'origin') : null,
		originalUrl: isGitRepo(p) ? getRemoteUrl(p, remoteName) : null,
	};
}

/**
 * Describe `p` as a linked worktree, or null when it is a real repository.
 * A linked worktree inherits every remote of its repo (including `stem`), so
 * remotes alone can never tell the two apart, so the git dir has to.
 */
export function asLinkedWorktree(p: string): LinkedWorktree | null {
	if (!isGitRepo(p) || !isLinkedWorktree(p)) return null;
	const mainPath = mainWorktreePath(p) ?? '';
	return {
		path: p,
		name: path.basename(p),
		mainPath,
		mainName: mainPath ? path.basename(mainPath) : '(unknown)',
	};
}

/**
 * Scan `baseDir`'s immediate subdirectories for git repos and read their remotes.
 * Linked worktrees are never repos: they are the same repository as their parent
 * and merging into one is a phantom operation (see `discoverLinkedWorktrees`).
 */
export function discoverRepos(
	baseDir: string,
	remoteName = DEFAULT_REMOTE,
): Repo[] {
	if (!fs.existsSync(baseDir)) return [];
	const repos: Repo[] = [];
	for (const entry of fs.readdirSync(baseDir, {withFileTypes: true})) {
		if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
		const p = path.join(baseDir, entry.name);
		if (!isGitRepo(p)) continue;
		if (isLinkedWorktree(p)) continue;
		repos.push(repoFromPath(p, remoteName));
	}
	return repos;
}

/** The linked worktrees under `baseDir`, so a report can mention them once. */
export function discoverLinkedWorktrees(baseDir: string): LinkedWorktree[] {
	if (!fs.existsSync(baseDir)) return [];
	const found: LinkedWorktree[] = [];
	for (const entry of fs.readdirSync(baseDir, {withFileTypes: true})) {
		if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
		const wt = asLinkedWorktree(path.join(baseDir, entry.name));
		if (wt) found.push(wt);
	}
	return found;
}

export function buildTree(repos: Repo[]): Tree {
	const byOrigin = new Map<string, Repo>();
	for (const r of repos) {
		if (r.originUrl) byOrigin.set(normalizeUrl(r.originUrl), r);
	}
	return {repos, byOrigin};
}

/** Direct children of `parent` = repos whose parent remote matches `parent`'s `origin`. */
export function childrenOf(parent: Repo, tree: Tree): Repo[] {
	const key = parent.originUrl ? normalizeUrl(parent.originUrl) : null;
	return tree.repos.filter(
		(r) =>
			r.originalUrl !== null &&
			key !== null &&
			normalizeUrl(r.originalUrl) === key &&
			!samePath(r.path, parent.path),
	);
}

/**
 * Match a repo against the maintainer-local ignore list, returning the pattern
 * that matched (or null). A pattern is either a repo name or a path.
 */
export function matchIgnore(
	repo: {name: string; path: string},
	patterns: string[] | undefined,
): string | null {
	if (!patterns || patterns.length === 0) return null;
	const repoPath = path.resolve(repo.path);
	for (const raw of patterns) {
		const pattern = raw.trim().replace(/\/+$/, '');
		if (pattern === '') continue;
		if (pattern === repo.name) return raw;
		if (path.resolve(pattern) === repoPath) return raw;
	}
	return null;
}
