/**
 * Asking a git HOST about a tree, so reconstruction needs no local state.
 *
 * The trick that makes this work without a registry: every member of a family
 * contains the family's ROOT COMMIT, and GitHub's commit search can find every
 * repo containing a given hash. On a real 10-repo tree that one unauthenticated
 * call returned 12 repos, including two under owners nobody remembered and one
 * the maintainer had forgotten entirely.
 *
 * Search only indexes DEFAULT branches, which is exactly why the root commit is
 * the right probe: it reaches `main` in every descendant, whereas the branch a
 * given edge was cut from may not.
 *
 * Membership is all the host can answer. Which repo is whose PARENT is not
 * derivable from shared history (measured: 3 of 10 edges wrong, one chain fully
 * inverted), so that comes from each repo's `stem` field, read here straight off
 * the config branch without cloning anything.
 */

export interface HostOptions {
	/** API token. Optional for public repos; raises rate limits, required for private. */
	token?: string | undefined;
	/** API base, for GitHub Enterprise. Default: https://api.github.com */
	api?: string | undefined;
}

/** Where a credential came from, so a partial tree can be explained. */
export type TokenSource =
	'option' | 'env:GITHUB_TOKEN' | 'env:GH_TOKEN' | 'gh' | 'none';

export interface ResolvedToken {
	token: string | null;
	source: TokenSource;
}

/**
 * Find a credential, preferring an explicit one, then the environment, then the
 * `gh` CLI the user is probably already logged into.
 *
 * Asking `gh` matters more than convenience here. An unauthenticated commit
 * search cannot see private repos AT ALL, and it does not say so: it returns a
 * smaller answer that looks complete. On a real tree that was 12 repos instead
 * of 17, silently dropping five, one of which was a genuine member. Anyone with
 * `gh` logged in gets the whole tree without configuring a thing.
 */
export function resolveToken(explicit?: string | undefined): ResolvedToken {
	if (explicit) return {token: explicit, source: 'option'};
	if (process.env.GITHUB_TOKEN)
		return {token: process.env.GITHUB_TOKEN, source: 'env:GITHUB_TOKEN'};
	if (process.env.GH_TOKEN)
		return {token: process.env.GH_TOKEN, source: 'env:GH_TOKEN'};

	const r = spawnSync('gh', ['auth', 'token'], {encoding: 'utf8'});
	const token = r.status === 0 ? r.stdout.trim() : '';
	if (token) return {token, source: 'gh'};
	return {token: null, source: 'none'};
}

export interface HostSearchResult {
	repos: string[];
	/** True when the host says its own result set was cut short. */
	incomplete: boolean;
}

import {spawnSync} from 'node:child_process';

const DEFAULT_API = 'https://api.github.com';

function headers(opts: HostOptions): Record<string, string> {
	const h: Record<string, string> = {
		Accept: 'application/vnd.github+json',
		'User-Agent': 'offshoot-fanout',
		'X-GitHub-Api-Version': '2022-11-28',
	};
	const token = opts.token ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
	if (token) h.Authorization = `Bearer ${token}`;
	return h;
}

/** Turn a rate-limited or failed response into a message that says what to do. */
async function explain(res: Response, what: string): Promise<string> {
	const remaining = res.headers.get('x-ratelimit-remaining');
	if (res.status === 403 && remaining === '0') {
		const reset = res.headers.get('x-ratelimit-reset');
		const when = reset
			? new Date(Number(reset) * 1000).toISOString().slice(11, 19)
			: 'shortly';
		return (
			`${what}: rate limited (search allows ~10 requests/minute unauthenticated, ~30 authenticated). ` +
			`Resets at ${when} UTC. Set GITHUB_TOKEN to raise it.`
		);
	}
	if (res.status === 401) {
		return `${what}: unauthorized. The token in GITHUB_TOKEN is not valid for this host.`;
	}
	let body = '';
	try {
		body = ((await res.json()) as {message?: string}).message ?? '';
	} catch {
		/* no body */
	}
	return `${what}: HTTP ${res.status}${body ? ` (${body})` : ''}`;
}

/**
 * Every repo whose default branch contains `sha`, as `owner/name`.
 * Paginates, and reports rather than hides a truncated result set.
 */
export async function searchReposByCommit(
	sha: string,
	opts: HostOptions = {},
): Promise<HostSearchResult> {
	const api = opts.api ?? DEFAULT_API;
	const repos = new Set<string>();
	let incomplete = false;

	for (let page = 1; page <= 10; page++) {
		const url = `${api}/search/commits?q=hash:${encodeURIComponent(sha)}&per_page=100&page=${page}`;
		const res = await fetch(url, {headers: headers(opts)});
		if (!res.ok)
			throw new Error(
				await explain(res, `commit search for ${sha.slice(0, 10)}`),
			);
		const body = (await res.json()) as {
			total_count?: number;
			incomplete_results?: boolean;
			items?: {repository?: {full_name?: string}}[];
		};
		if (body.incomplete_results) incomplete = true;
		const items = body.items ?? [];
		for (const item of items) {
			const name = item.repository?.full_name;
			if (name) repos.add(name);
		}
		if (items.length < 100) break;
	}

	return {repos: [...repos].sort(), incomplete};
}

/**
 * Read one file off a branch WITHOUT cloning: this is what lets discovery skip
 * repos that turn out not to belong, instead of cloning them to find out.
 * Returns null when the branch or the file is absent (a repo that never opted
 * in), which the caller treats as "not a member".
 */
export async function fetchFileFromBranch(
	fullName: string,
	branch: string,
	file: string,
	opts: HostOptions = {},
): Promise<string | null> {
	const api = opts.api ?? DEFAULT_API;
	const url = `${api}/repos/${fullName}/contents/${encodeURIComponent(file)}?ref=${encodeURIComponent(branch)}`;
	const res = await fetch(url, {
		headers: {...headers(opts), Accept: 'application/vnd.github.raw+json'},
	});
	if (res.status === 404) return null;
	if (!res.ok)
		throw new Error(
			await explain(res, `reading ${fullName}:${branch}/${file}`),
		);
	return await res.text();
}

/** The repo's own clone URL and default branch, for wiring and reporting. */
export async function fetchRepoInfo(
	fullName: string,
	opts: HostOptions = {},
): Promise<{cloneUrl: string; sshUrl: string; defaultBranch: string} | null> {
	const api = opts.api ?? DEFAULT_API;
	const res = await fetch(`${api}/repos/${fullName}`, {headers: headers(opts)});
	if (res.status === 404) return null;
	if (!res.ok) throw new Error(await explain(res, `reading ${fullName}`));
	const body = (await res.json()) as {
		clone_url?: string;
		ssh_url?: string;
		default_branch?: string;
	};
	return {
		cloneUrl: body.clone_url ?? `https://github.com/${fullName}.git`,
		sshUrl: body.ssh_url ?? `git@github.com:${fullName}.git`,
		defaultBranch: body.default_branch ?? 'main',
	};
}
