/**
 * Template sources and ref resolution.
 *
 * Every operation pins a concrete commit SHA before fetching anything.
 * Today's create-jolly-roger pins `#main` and records nothing, which is
 * exactly why updates are impossible with it.
 *
 * Fetching is giget (tarball based, ref aware) for hosted providers, and
 * `git archive` for a local repository path (used heavily by the test suite,
 * and handy for developing a template offline).
 */

import {mkdtempSync, existsSync, mkdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join, resolve, basename} from 'node:path';
import {gitTry, lsRemote, defaultBranchOf} from './git.js';

export type Provider =
	'github' | 'gitlab' | 'bitbucket' | 'sourcehut' | 'local';

export interface ParsedSource {
	/** Canonical form stored in `.offshoot.json`, without the ref. */
	id: string;
	provider: Provider;
	/** "owner/repo" for hosted providers, absolute path for local. */
	repo: string;
	/** The ref as written by the user, if any. */
	ref?: string;
	/** Token inferred from the repo name when no config sets `sourceName`. */
	inferredName: string;
	/** What `git ls-remote` is pointed at. */
	remote: string;
	/** What giget is handed (minus the ref). */
	gigetSource: string;
}

const HOSTED: Record<string, {prefix: string; url: (repo: string) => string}> =
	{
		github: {prefix: 'github', url: (r) => `https://github.com/${r}.git`},
		gitlab: {prefix: 'gitlab', url: (r) => `https://gitlab.com/${r}.git`},
		bitbucket: {
			prefix: 'bitbucket',
			url: (r) => `https://bitbucket.org/${r}.git`,
		},
		sourcehut: {prefix: 'sourcehut', url: (r) => `https://git.sr.ht/~${r}`},
	};

/**
 * Accepts `user/repo`, `github:user/repo`, `user/repo#ref`, `gitlab:...`,
 * a local path, or `file:./path`.
 */
export function parseSource(input: string): ParsedSource {
	let text = input.trim();
	if (text === '') throw new Error('Template source is empty.');

	let ref: string | undefined;
	const hash = text.lastIndexOf('#');
	if (hash > 0) {
		ref = text.slice(hash + 1) || undefined;
		text = text.slice(0, hash);
	}

	let provider: Provider = 'github';
	const colon = text.indexOf(':');
	if (text.startsWith('file:')) {
		provider = 'local';
		text = text.slice('file:'.length);
	} else if (colon > 0 && !text.startsWith('http') && !text.includes('://')) {
		const prefix = text.slice(0, colon);
		if (prefix in HOSTED) {
			provider = prefix as Provider;
			text = text.slice(colon + 1);
		}
	}

	const looksLocal =
		provider === 'local' ||
		text.startsWith('.') ||
		text.startsWith('/') ||
		text.startsWith('~');

	if (looksLocal) {
		const path = resolve(
			text.startsWith('~') ? text.replace('~', process.env.HOME ?? '~') : text,
		);
		return {
			id: `file:${path}`,
			provider: 'local',
			repo: path,
			ref,
			inferredName: basename(path).replace(/\.git$/, ''),
			remote: path,
			gigetSource: path,
		};
	}

	const repo = text.replace(/^\/+|\/+$/g, '');
	if (!/^[^/]+\/[^/]+$/.test(repo)) {
		throw new Error(
			`Cannot parse template "${input}". Expected user/repo, github:user/repo, user/repo#ref, or a local path.`,
		);
	}
	const hosted = HOSTED[provider];
	if (!hosted) throw new Error(`Unsupported provider "${provider}".`);

	return {
		id: `${provider}:${repo}`,
		provider,
		repo,
		ref,
		inferredName: repo.split('/')[1] ?? repo,
		remote: hosted.url(repo),
		gigetSource: `${provider}:${repo}`,
	};
}

export interface ResolvedRef {
	sha: string;
	/** The floating ref this SHA came from, when there is one ("main", "v2"). */
	track?: string;
}

const FULL_SHA = /^[0-9a-f]{40}$/i;
const PARTIAL_SHA = /^[0-9a-f]{7,40}$/i;

/** Resolve a ref (or the default branch) to a concrete commit SHA. */
export async function resolveRef(
	source: ParsedSource,
	ref?: string,
): Promise<ResolvedRef> {
	const wanted = ref ?? source.ref;

	if (wanted && FULL_SHA.test(wanted)) return {sha: wanted.toLowerCase()};

	if (source.provider === 'local') {
		const rev = gitTry(
			['rev-parse', `${wanted ?? 'HEAD'}^{commit}`],
			source.repo,
		);
		if (rev.status !== 0) {
			throw new Error(
				`Cannot resolve "${wanted ?? 'HEAD'}" in local template ${source.repo}.`,
			);
		}
		return {sha: rev.stdout.trim(), track: wanted};
	}

	const found = lsRemote(source.remote, wanted);
	if (found) {
		const track = wanted ?? found.ref.replace('refs/heads/', '');
		return {sha: found.sha, track};
	}

	if (wanted && PARTIAL_SHA.test(wanted)) {
		const viaApi = await resolveViaGithubApi(source, wanted);
		if (viaApi) return {sha: viaApi};
		// A short SHA is still immutable, so recording it is safe.
		return {sha: wanted.toLowerCase()};
	}

	throw new Error(
		`Cannot resolve ref "${wanted ?? '(default branch)'}" in ${source.id}. ` +
			`Check the template exists and the ref is a branch, tag or commit.`,
	);
}

async function resolveViaGithubApi(
	source: ParsedSource,
	ref: string,
): Promise<string | undefined> {
	if (source.provider !== 'github') return undefined;
	try {
		const headers: Record<string, string> = {
			Accept: 'application/vnd.github+json',
		};
		const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
		if (token) headers.Authorization = `Bearer ${token}`;
		const res = await fetch(
			`https://api.github.com/repos/${source.repo}/commits/${ref}`,
			{headers},
		);
		if (!res.ok) return undefined;
		const body = (await res.json()) as {sha?: string};
		return typeof body.sha === 'string' ? body.sha : undefined;
	} catch {
		return undefined;
	}
}

/** The floating ref a bare `user/repo` follows. */
export async function defaultTrack(
	source: ParsedSource,
): Promise<string | undefined> {
	if (source.provider === 'local') {
		const r = gitTry(['symbolic-ref', '--short', 'HEAD'], source.repo);
		return r.status === 0 ? r.stdout.trim() : undefined;
	}
	return defaultBranchOf(source.remote);
}

/** Download the template at an exact SHA into a fresh temp directory. */
export async function downloadTemplate(
	source: ParsedSource,
	sha: string,
): Promise<string> {
	const dir = mkdtempSync(join(tmpdir(), 'offshoot-fetch-'));

	if (source.provider === 'local') {
		if (
			!existsSync(join(source.repo, '.git')) &&
			!existsSync(join(source.repo, 'HEAD'))
		) {
			throw new Error(`Local template ${source.repo} is not a git repository.`);
		}
		mkdirSync(dir, {recursive: true});
		// `git archive | tar -x` keeps the executable bit, like the tarball path.
		const archive = execFileSync('git', ['archive', '--format=tar', sha], {
			cwd: source.repo,
			maxBuffer: 512 * 1024 * 1024,
		});
		execFileSync('tar', ['-x', '-C', dir], {
			input: archive,
			maxBuffer: 512 * 1024 * 1024,
		});
		return dir;
	}

	const {downloadTemplate: giget} = await import('giget');
	// The ref is always an exact SHA here, so giget's cache is safe: the same
	// key can never mean two different trees.
	await giget(`${source.gigetSource}#${sha}`, {
		dir,
		force: true,
		forceClean: true,
		silent: true,
	});
	return dir;
}
