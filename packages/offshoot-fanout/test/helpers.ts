/**
 * Integration harness: real git repositories in real temp directories, mirroring
 * how the sibling `offshoot` package validates its design.
 */

import {execFileSync} from 'node:child_process';
import {
	mkdtempSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';

// CI runners have no git identity. GIT_AUTHOR_*/GIT_COMMITTER_* are honored above
// config, so this gives every git op (including commits/merges/cherry-picks the
// tool makes in freshly *cloned* temp repos, which don't inherit local config) an
// identity — without depending on `git config --global` being set.
process.env.GIT_AUTHOR_NAME ||= 'offshoot-fanout tests';
process.env.GIT_AUTHOR_EMAIL ||= 'tests@offshoot-fanout.invalid';
process.env.GIT_COMMITTER_NAME ||= 'offshoot-fanout tests';
process.env.GIT_COMMITTER_EMAIL ||= 'tests@offshoot-fanout.invalid';

const created: string[] = [];

export function tempDir(prefix = 'offshoot-fanout-test-'): string {
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
	return execFileSync('git', args, {
		cwd,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
	});
}

export function writeFile(root: string, rel: string, content: string): void {
	const target = join(root, ...rel.split('/'));
	mkdirSync(dirname(target), {recursive: true});
	writeFileSync(target, content);
}

export function readFile(root: string, rel: string): string {
	return readFileSync(join(root, ...rel.split('/')), 'utf8');
}

export interface Repo {
	name: string;
	dir: string;
}

export function initRepo(
	parent: string,
	name: string,
	files: Record<string, string> = {},
): Repo {
	const dir = join(parent, name);
	mkdirSync(dir, {recursive: true});
	git(['init', '-b', 'main'], dir);
	git(['config', 'user.name', 'Test'], dir);
	git(['config', 'user.email', 'test@example.com'], dir);
	git(['config', 'commit.gpgsign', 'false'], dir);
	for (const [p, c] of Object.entries(files)) writeFile(dir, p, c);
	if (Object.keys(files).length > 0) {
		git(['add', '-A'], dir);
		git(['commit', '--no-verify', '-m', `init ${name}`], dir);
	}
	return {name, dir};
}

export function commit(root: string, message: string): void {
	git(['add', '-A'], root);
	git(['commit', '--no-verify', '-m', message], root);
}

/** Set a remote url, replacing it if it already exists. */
export function setRemote(root: string, name: string, url: string): void {
	try {
		git(['remote', 'remove', name], root);
	} catch {
		/* didn't exist */
	}
	git(['remote', 'add', name, url], root);
}

export function headOf(root: string): string {
	return git(['rev-parse', 'HEAD'], root).trim();
}

/** Contents of `rel` on `branch`, without checking it out. */
export function fileOnBranch(
	root: string,
	branch: string,
	rel: string,
): string {
	return git(['show', `${branch}:${rel}`], root);
}

export function branchSha(root: string, branch: string): string {
	return git(['rev-parse', branch], root).trim();
}

export function currentBranchOf(root: string): string {
	return git(['rev-parse', '--abbrev-ref', 'HEAD'], root).trim();
}

export function worktreeCount(root: string): number {
	return git(['worktree', 'list', '--porcelain'], root)
		.split('\n')
		.filter((l) => l.startsWith('worktree ')).length;
}

/**
 * Put raw text at `fanout.config.json` on an orphan config branch, using the
 * same plumbing a user would — deliberately NOT the package's `writeConfig`, so
 * reading is tested against an independently produced branch (and so malformed
 * JSON can be written, which `writeConfig` refuses).
 */
export function writeConfigBranch(
	root: string,
	content: string,
	branch = 'offshoot',
): void {
	const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], {
		cwd: root,
		input: content,
		encoding: 'utf8',
	}).trim();
	const tree = execFileSync('git', ['mktree'], {
		cwd: root,
		input: `100644 blob ${blob}\tfanout.config.json\n`,
		encoding: 'utf8',
	}).trim();
	let parent: string | null = null;
	try {
		parent = git(
			['rev-parse', '--verify', `refs/heads/${branch}`],
			root,
		).trim();
	} catch {
		/* branch does not exist yet */
	}
	const args = ['commit-tree', tree];
	if (parent) args.push('-p', parent);
	args.push('-m', 'config');
	const commit = git(args, root).trim();
	git(['update-ref', `refs/heads/${branch}`, commit], root);
}
