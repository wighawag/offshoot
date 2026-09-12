/**
 * The PARENT REPO of a repo, as a portable identity that survives the machine.
 *
 * Until this existed, a tree's shape lived only in local `stem` remotes: wipe
 * the laptop and the topology was gone, because a git host cannot be asked
 * "what descends from this repo". Commit search answers MEMBERSHIP (every
 * descendant carries the family's root commit), but never DIRECTION: measured
 * on a real 10-repo tree, inferring edges from shared history got 3 of 10
 * wrong, including a chain inverted end to end because a descendant happened to
 * have fewer commits than its ancestor. So the edge has to be STATED, and the
 * only place that travels with the repo is its config branch.
 *
 * The identity is `provider:owner/name`, not a URL: the same tree is cloned
 * over ssh on one machine and https on another, and a URL would make those two
 * clones disagree about a relationship that is actually identical. That is also
 * the spelling `.offshoot.json` already uses for the non-fork flow
 * (`template: "github:wighawag/jolly-roger"`), so the two halves of the tool
 * name a parent the same way.
 */

import {spawnSync} from 'node:child_process';
import {getRemoteUrl, isGitRepo} from './git.js';
import {normalizeUrl} from './repo.js';

/** Hosts with a short `provider:owner/name` spelling. */
const HOSTED: Record<string, {host: string; ssh: string; https: string}> = {
	github: {
		host: 'github.com',
		ssh: 'git@github.com:',
		https: 'https://github.com/',
	},
	gitlab: {
		host: 'gitlab.com',
		ssh: 'git@gitlab.com:',
		https: 'https://gitlab.com/',
	},
	bitbucket: {
		host: 'bitbucket.org',
		ssh: 'git@bitbucket.org:',
		https: 'https://bitbucket.org/',
	},
};

const BY_HOST = new Map(
	Object.entries(HOSTED).map(([provider, h]) => [h.host, provider]),
);

export type StemProtocol = 'ssh' | 'https';

export interface StemId {
	/** Canonical `provider:owner/name`, or a normalized URL for an unknown host. */
	id: string;
	/** `github` | `gitlab` | `bitbucket` | `other`. */
	provider: string;
	host: string;
	/** `owner/name` on a hosted provider. */
	path: string;
	/** Last path segment: the repo name, which is also its default folder. */
	name: string;
	/** Owner segment, when the path has one. */
	owner: string | null;
}

/**
 * Parse a written stem into a canonical identity.
 *
 * Accepts `owner/name` (github assumed), `provider:owner/name`, and a full
 * clone URL (ssh or https), because a self-hosted tree has no short spelling.
 * REJECTS a local path: this field is the PUBLISHED identity of the parent, and
 * `/home/someone/dev/template` means nothing on anyone else's machine. Local
 * wiring is what the `stem` REMOTE is for, and it keeps overriding this.
 */
export function parseStem(input: string): StemId {
	const text = input.trim();
	if (text === '') throw new Error('stem is empty');

	if (
		text.startsWith('.') ||
		text.startsWith('/') ||
		text.startsWith('~') ||
		text.startsWith('file:')
	) {
		throw new Error(
			`stem must identify the parent repository on a git host, not a local path (got \`${text}\`). ` +
				'A path is only meaningful on one machine; use the `stem` remote for local wiring.',
		);
	}

	const looksLikeUrl =
		text.includes('://') ||
		/^[^\s:]+@[^\s:]+:/.test(text) ||
		text.startsWith('git@');

	if (looksLikeUrl) {
		const normalized = normalizeUrl(text); // https://host/owner/name, lowercased
		const match = /^https:\/\/([^/]+)\/(.+)$/.exec(normalized);
		if (!match)
			throw new Error(`stem is not a usable repository URL: \`${text}\``);
		const [, host, rawPath] = match;
		return build(host!, rawPath!, text);
	}

	const colon = text.indexOf(':');
	if (colon > 0) {
		const provider = text.slice(0, colon).toLowerCase();
		const rest = text.slice(colon + 1);
		const hosted = HOSTED[provider];
		if (!hosted) {
			throw new Error(
				`stem names unknown provider \`${provider}\`. Use ${Object.keys(HOSTED).join(', ')}, or a full URL.`,
			);
		}
		if (!/^[^/\s]+\/[^/\s]+$/.test(rest)) {
			throw new Error(`stem \`${text}\` must be \`${provider}:owner/name\`.`);
		}
		return build(hosted.host, rest, text);
	}

	if (!/^[^/\s]+\/[^/\s]+$/.test(text)) {
		throw new Error(
			`stem \`${text}\` must be \`owner/name\`, \`provider:owner/name\`, or a repository URL.`,
		);
	}
	return build(HOSTED.github!.host, text, text);
}

function build(host: string, rawPath: string, original: string): StemId {
	const cleanPath = rawPath
		.replace(/^\/+/, '')
		.replace(/\/+$/, '')
		.replace(/\.git$/, '');
	if (cleanPath === '')
		throw new Error(`stem has no repository path: \`${original}\``);
	const segments = cleanPath.split('/');
	const provider = BY_HOST.get(host) ?? 'other';
	// Preserve the case the user wrote for hosted paths (`wighawag/Jolly-Roger`
	// displays as written); comparison always goes through `normalizeUrl`.
	const display = preserveCase(original, cleanPath);
	return {
		id:
			provider === 'other'
				? `https://${host}/${display}`
				: `${provider}:${display}`,
		provider,
		host,
		path: display,
		name: segments[segments.length - 1]!,
		owner: segments.length >= 2 ? segments[segments.length - 2]! : null,
	};
}

/** Recover the as-written casing of the path, which `normalizeUrl` lowercased. */
function preserveCase(original: string, lowered: string): string {
	const stripped = original
		.trim()
		.replace(/\.git$/, '')
		.replace(/\/+$/, '');
	const idx = stripped.toLowerCase().indexOf(lowered);
	return idx >= 0 ? stripped.slice(idx, idx + lowered.length) : lowered;
}

/** A clone URL for this parent, in the protocol the caller is already using. */
export function stemUrl(
	stem: StemId,
	protocol: StemProtocol = 'https',
): string {
	const hosted = HOSTED[stem.provider];
	if (!hosted) return stem.id; // unknown host: the id already IS the URL
	return protocol === 'ssh'
		? `${hosted.ssh}${stem.path}.git`
		: `${hosted.https}${stem.path}.git`;
}

/** Which protocol a URL is written in, so a clone stays consistent with its tree. */
export function protocolOf(url: string | null): StemProtocol {
	if (!url) return 'https';
	return url.startsWith('git@') || url.startsWith('ssh://') ? 'ssh' : 'https';
}

/**
 * The protocol to clone with when nothing else has decided: ask `gh` what the
 * user already uses for git operations, and default to ssh otherwise.
 *
 * Defaulting to https is the trap this avoids. Discovery is authenticated (it
 * reads a token, often from `gh`), so it happily FINDS private members, and an
 * https clone of a private repo then fails asking for a username that no
 * non-interactive run can supply. Observed exactly that: a private member was
 * discovered, listed in the tree, and failed to clone while its ten public
 * siblings succeeded. ssh uses the key the maintainer already pushes with, so
 * the thing that can see the tree can also fetch it.
 */
export function preferredProtocol(host = 'github.com'): StemProtocol {
	const r = spawnSync('gh', ['config', 'get', 'git_protocol', '--host', host], {
		encoding: 'utf8',
	});
	const configured = r.status === 0 ? r.stdout.trim() : '';
	if (configured === 'https') return 'https';
	return 'ssh';
}

/** Same repository, comparing across ssh/https/case/`.git`. */
export function sameRepo(a: string, b: string): boolean {
	return normalizeUrl(a) === normalizeUrl(b);
}

export type ParentSource =
	/** Only the config branch names a parent. */
	| 'config'
	/** Only the `stem` remote names one (a tree not yet annotated). */
	| 'remote'
	/** Both, and they agree. */
	| 'both'
	/** Both, and they DISAGREE: real drift, never silently resolved. */
	| 'mismatch'
	/** The config explicitly declares this repo a root (`"stem": null`). */
	| 'declared-root'
	/** Nothing says who the parent is. */
	| 'none';

export interface ResolvedParent {
	/** The parent used for merging: the remote when present, else the config. */
	url: string | null;
	/** The published identity, when the config states one. */
	id: string | null;
	source: ParentSource;
	/** Set only for `mismatch`: what each side said. */
	conflict: {config: string; remote: string} | null;
	/** Human-readable problem with the config's value, if it does not parse. */
	error: string | null;
}

export interface ResolveParentOptions {
	/** The repo's `stem` remote URL, or null when unwired. */
	remoteUrl: string | null;
	/** The config's `stem`: a string, `null` for a declared root, undefined when absent. */
	configStem?: string | null;
	/** Remote name, for messages. Default: `stem`. */
	remoteName?: string;
}

/**
 * Resolve who the parent is, and say WHERE that came from.
 *
 * PRECEDENCE: the remote wins when it is present. It is what git actually
 * fetches, and pointing `stem` at a sibling clone on disk is the normal way to
 * work on a tree locally; a published identity must never silently retarget a
 * merge away from the checkout the maintainer wired on purpose. The config is
 * the portable truth and the fallback, which is what makes a fresh clone
 * reconstructible. Absence of the field stays valid forever: every tree that
 * exists today has none.
 *
 * A local-path remote is resolved through that clone's own `origin` before
 * being compared, because otherwise the ordinary local setup (`stem` ->
 * `/home/me/dev/template-svelte`) would report a mismatch against
 * `github:me/template-svelte` on every single run, and a warning that fires
 * constantly on a correct setup is a warning everybody turns off.
 */
export function resolveParent(opts: ResolveParentOptions): ResolvedParent {
	const {remoteUrl, configStem} = opts;

	let configId: StemId | null = null;
	let error: string | null = null;
	if (typeof configStem === 'string') {
		try {
			configId = parseStem(configStem);
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		}
	}

	if (!remoteUrl) {
		if (configId) {
			return {
				url: stemUrl(configId, 'https'),
				id: configId.id,
				source: 'config',
				conflict: null,
				error,
			};
		}
		return {
			url: null,
			id: null,
			source: configStem === null ? 'declared-root' : 'none',
			conflict: null,
			error,
		};
	}

	if (!configId) {
		return {
			url: remoteUrl,
			id: null,
			// A remote plus an explicit `"stem": null` is a contradiction, but the
			// remote is still what merges, so report it as a mismatch rather than
			// pretending the declared root has no parent.
			source: configStem === null ? 'mismatch' : 'remote',
			conflict:
				configStem === null
					? {config: '(declared root)', remote: remoteUrl}
					: null,
			error,
		};
	}

	const comparable = comparableRemote(remoteUrl);
	const agrees = sameRepo(comparable, stemUrl(configId, 'https'));
	return {
		url: remoteUrl,
		id: configId.id,
		source: agrees ? 'both' : 'mismatch',
		conflict: agrees ? null : {config: configId.id, remote: remoteUrl},
		error,
	};
}

/**
 * What a `stem` remote really points AT: a local clone is compared through its
 * own `origin`, so a local checkout of the right parent is not drift.
 */
export function comparableRemote(remoteUrl: string): string {
	const looksLocal =
		!remoteUrl.includes('://') &&
		!remoteUrl.startsWith('git@') &&
		(remoteUrl.startsWith('.') ||
			remoteUrl.startsWith('/') ||
			remoteUrl.startsWith('~'));
	if (!looksLocal) return remoteUrl;
	if (!isGitRepo(remoteUrl)) return remoteUrl;
	return getRemoteUrl(remoteUrl, 'origin') ?? remoteUrl;
}
