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
