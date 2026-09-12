#!/usr/bin/env node
import path from 'node:path';
import {parseArgs} from 'node:util';
import {
	DEFAULT_CONFIG_BRANCH,
	DEFAULT_REMOTE,
	CONFIG_FILE,
	discoverAncestry,
	discoverRepos,
	formatAncestryReport,
	formatDriftReport,
	formatLinkResults,
	formatRenameResults,
	formatReport,
	linkRemote,
	loadRegistry,
	matchIgnore,
	propagate,
	renameRemotes,
	saveRegistry,
	summarize,
	driftTree,
	backport,
	statusTree,
	formatStatusReport,
	planRepo,
	comparableRemote,
	parseStem,
	repoFromPath,
	resolveConfig,
	resolveParent,
	setStem,
	cloneTree,
	writeConfig,
} from './index.js';
import {
	availableSkills,
	destinationFor,
	installSkills,
	isInstalled,
} from './skills.js';
import type {PropagateResult, Repo} from './index.js';

const SUBCOMMANDS = new Set([
	'fanout',
	'clone',
	'discover',
	'link',
	'rename-remote',
	'drift',
	'backport',
	'status',
	'config',
	'skills',
]);

const FANOUT_USAGE = `offshoot-fanout fanout — propagate a template change down to all descendants

Usage:
  offshoot-fanout [fanout] [options]      (default subcommand)

Options:
  --source <path>        repo whose changes to propagate (default: cwd)
  --base-dir <path>      dir to scan for sibling repos (default: parent of --source)
  --repos <path> ...     explicit repo paths instead of scanning (repeatable)
  --registry <file>      use a saved hierarchy (~/.offshoot-stems/<root>.json) instead of scanning
  --branch <name>        GLOBAL override: make every repo a single node at this branch
  --remote <name>        parent-template remote name (default: stem)
  --config-branch <name> branch holding each repo's ${CONFIG_FILE} (default: ${DEFAULT_CONFIG_BRANCH})
  --no-config            ignore config branches entirely (defaults everywhere)
  --verify               run each repo's configured \`verify\` command in merged nodes
  --ignore <path|name>   exclude a repo from the tree (repeatable; adds to the registry's list)
  --dry-run              report only; no merge commits, no branch changes, no worktrees
  --leave-conflicts      keep a conflicted merge in progress for manual fixing
  --no-color             plain text report (no ANSI escapes)
  -h, --help             show this help

The unit of work is a NODE: a (repo, branch) pair. A repo with no config is one node: \`main\` if it
exists, else the checked-out branch. A repo whose config branch lists \`branches\` contributes one node
per listed branch, and a branch with a \`stem\` merges from that sibling branch in the same repo.

The target branch does NOT have to be checked out: if it is, the merge happens in place; otherwise it
happens in a temporary linked worktree (kept, and its path reported, when \`--leave-conflicts\` leaves a
conflict there). Nothing is ever \`git checkout\`ed. Linked worktrees are never treated as repos.

Changes flow downward only: from --source to its children, then their children, and so on. Each
child merges its parent's current LOCAL ref, so an intermediate merge cascades to the leaves in
one pass — no push required. Exit code is non-zero if any node conflicts/errors/has a dirty tree.
`;

const DISCOVER_USAGE = `offshoot-fanout discover — find repos that share common git ancestry

Usage:
  offshoot-fanout discover [folder] [options]

Scans a folder for git repos, groups them by shared commit history, and proposes a parent->child tree
per family (root = fewest commits, tie-broken by oldest HEAD). Direction can't be proven once both
sides diverged past the fork, so the tree is a PROPOSAL — review before applying.

Options:
  --remote <name>        parent-remote name to inspect/add (default: stem)
  --add-remotes          for unwired repos, add the parent remote pointing at the detected parent's
                         origin URL. Needs --root or --yes to apply.
  --root <path>          explicit root repo; only its descendant subtree is wired
  --yes                  apply --add-remotes, accepting the proposed tree
  --save                 write a registry file per family to ~/.offshoot-stems/<root>.json
  --ignore <path|name>   exclude a repo (repeatable); --save merges these into the registry's
                         \`ignore\` array, which is preserved rather than clobbered
  --dry-run              show what would be added; do not add any remote (still saves a registry)
  --no-color             plain text report (no ANSI escapes)
  -h, --help             show this help

Linked worktrees (\`git worktree add\`) are never listed: they are the same repository as their parent.
`;

const CLONE_USAGE = `offshoot-fanout clone — rebuild a whole tree on a bare machine, from one repo name

Usage:
  offshoot-fanout clone <owner/name> [options]

Given ONLY the root repo, clones every repo of its tree and wires each one's \`stem\` remote. No
registry, no manifest, no local state: the tree comes back on a machine that has never seen it.

How it finds them: every descendant contains the family's ROOT COMMIT, so the host's commit search
lists the whole family from that one hash (it finds repos under other owners too). Then each repo's
own \`stem\` field, read straight off its config branch without cloning, gives the parent/child
edges. Direction is never inferred from history — measured on a real tree, inference got 3 of 10
edges wrong and inverted a whole chain — so an edge that is not stated is reported, not guessed.

A repo that shares the root commit but has NO \`stem\` field is DISCARDED and listed as unannotated.
That is what the field buys beyond reconstruction: it marks which repos are actually maintained as
part of the tree, so old experiments and other people's copies stay out.

Options:
  --dir <path>           where clones land (default: cwd)
  --remote <name>        remote to wire on each clone (default: ${DEFAULT_REMOTE})
  --config-branch <name> branch holding each repo's ${CONFIG_FILE} (default: ${DEFAULT_CONFIG_BRANCH})
  --protocol <ssh|https> clone URL style (default: match the root clone, else \`gh\`'s git_protocol,
                         else ssh)
  --prefer-https         shorthand for --protocol https
  --require-auth         fail unless a credential is found (see AUTH below)
  --dry-run              discover and report; clone nothing, wire nothing
  --no-color             plain text report (no ANSI escapes)
  -h, --help             show this help

Idempotent: an existing clone with the right \`origin\` is kept and only re-wired, so re-running this
brings a machine back in sync. A \`stem\` remote already pointing somewhere else is never clobbered.

PROTOCOL. ssh by default, because discovery is AUTHENTICATED and cloning must be able to reach
everything discovery can see: an https clone of a private member fails asking for a username that a
script cannot answer, so a public-only tree would come back looking like the whole one. \`gh\`'s
configured \`git_protocol\` wins if it says https; \`--prefer-https\` forces it.

AUTH. A credential is taken from GITHUB_TOKEN, then GH_TOKEN, then \`gh auth token\` — so if you are
logged into the \`gh\` CLI, private members are included with no setup. This is not a nicety: an
unauthenticated commit search cannot see private repos AT ALL and does not say so, it just returns
a smaller answer. On a real tree that is 12 repos instead of 17. \`--require-auth\` turns a missing
credential into a hard failure, which is what a tree with private members wants in a provisioning
script. A token also raises the search rate limit (~30 req/min vs ~10).
`;

const LINK_USAGE = `offshoot-fanout link — set/create the parent remote on repo(s)

Usage:
  offshoot-fanout link <parent> [--to <child> ...] [options]

Adds (or repoints) the parent remote on each --to child so it points at the given parent URL (or
local path). If --to is omitted, the current directory is used.

Options:
  --remote <name>        parent-remote name (default: stem)
  --to <path> ...        repo paths to wire (repeatable; default: cwd)
  --no-color             plain text report (no ANSI escapes)
  -h, --help             show this help
`;

const RENAME_USAGE = `offshoot-fanout rename-remote — bulk-rename the parent remote

Usage:
  offshoot-fanout rename-remote <from> <to> [folder] [options]

Renames the parent remote from <from> to <to> in every repo under [folder] that has <from> (e.g.
migrate \`original\` -> \`stem\`). Repos without <from> are skipped; a <to> that already exists with a
different URL is left untouched (not clobbered). --dry-run is read-only.

Options:
  --dry-run              show what would change; rename nothing
  --no-color             plain text report (no ANSI escapes)
  -h, --help             show this help
`;

const DRIFT_USAGE = `offshoot-fanout drift — find descendant commits not yet in their parent (candidate backports)

Usage:
  offshoot-fanout drift [folder] [options]

For each node that has a stem, lists the commits it has that its stem lacks (\`git log <stem>..<branch>\`).
These are changes a descendant made that may belong upstream — review them, then backport the relevant ones.

Options:
  --registry <file>      use a saved hierarchy instead of scanning a folder
  --remote <name>        parent-remote name (default: stem)
  --branch <name>        GLOBAL override: compare this branch everywhere
  --config-branch <name> branch holding each repo's ${CONFIG_FILE} (default: ${DEFAULT_CONFIG_BRANCH})
  --no-config            ignore config branches entirely
  --ignore <path|name>   exclude a repo (repeatable)
  --no-color             plain text report (no ANSI escapes)
  -h, --help             show this help

Drift is reported per NODE (\`repo@branch\`), against that node's stem: the parent repo's primary
branch for a root branch, or the sibling branch named by its \`stem\` for an in-repo branch.
`;

const BACKPORT_USAGE = `offshoot-fanout backport — move a descendant commit up to an ancestor (its "home")

Usage:
  offshoot-fanout backport <commit> --from <repo> [options]

Cherry-picks <commit> (a SHA in the --from repo) onto an ancestor. --to defaults to the from-repo's
immediate \`stem\` parent; give a higher ancestor explicitly when the change's home is further up.
--cascade then runs \`fanout\` from that ancestor to spread the now-upstream change back down to every
descendant.

The commit lands on the ancestor's NODE branch, which does not have to be checked out (same rule as a
merge: never \`git checkout\`, use a temporary worktree instead).

Options:
  --from <path>          repo the commit lives in (required)
  --to <path>            target ancestor (default: the from repo's immediate stem parent)
  --registry <file>      use a saved hierarchy to resolve the default --to and the cascade
  --remote <name>        parent-remote name (default: stem)
  --branch <name>        GLOBAL override: fetch from, and land on, this branch everywhere
                         (default: each repo's own primary branch, usually main)
  --cascade              after a clean cherry-pick, fan out from the ancestor down the tree
  --dry-run              show the commit that would be cherry-picked; do not apply it
  --leave-conflicts      keep a conflicted cherry-pick in progress for manual resolution
  --no-color             plain text report (no ANSI escapes)
  -h, --help             show this help
`;

const STATUS_USAGE = `offshoot-fanout status — one-command triage of a wired hierarchy

Usage:
  offshoot-fanout status [folder] [options]

For each wired root (a repo whose \`stem\` remote has descendants), reports a consolidated triage:
  downstream: a \`fanout --dry-run\` of the root — who merges, who conflicts (with files), who is blocked;
  upstream:   drift — each repo's commits not yet in its \`stem\` parent (candidate backports).

Use this first to see what needs doing. Read-only: it fetches objects and computes merges in memory
(\`git merge-tree\`), so no branch, index or working tree is touched.

Options:
  --registry <file>      use a saved hierarchy instead of scanning a folder
  --remote <name>        parent-remote name (default: stem)
  --branch <name>        GLOBAL override: use this branch everywhere
  --config-branch <name> branch holding each repo's ${CONFIG_FILE} (default: ${DEFAULT_CONFIG_BRANCH})
  --no-config            ignore config branches entirely
  --ignore <path|name>   exclude a repo (repeatable)
  --no-color             plain text report (no ANSI escapes)
  -h, --help             show this help
`;

const CONFIG_USAGE = `offshoot-fanout config — show or write a repo's config, which lives on an ORPHAN BRANCH

Usage:
  offshoot-fanout config show [--repo <path>]
  offshoot-fanout config set --file <path> [--repo <path>]
  offshoot-fanout config stem [--from-remote | --set <owner/name> | --root] [--repo <path>]

Config lives on a branch (default \`${DEFAULT_CONFIG_BRANCH}\`), in \`${CONFIG_FILE}\`, so the template's working
tree carries no offshoot-specific file. It is read with \`git show\` (never checked out) and falls
back to \`origin/${DEFAULT_CONFIG_BRANCH}\` on a fresh clone. Absent config means the defaults, so a repo that matches
the defaults stays completely free of offshoot references.

\`config set\` writes with plumbing (hash-object / mktree / commit-tree / update-ref): your working
tree, index and current branch are never touched, and the orphan branch is created if absent.

    {
      "stem": "github:wighawag/template-svelte-tailwind",
      "branches": {"main": {}, "variant/full": {"stem": "main"}},
      "verify": "pnpm install && pnpm --filter ./web check"
    }

The top-level \`stem\` names the PARENT REPO, as \`provider:owner/name\` (or a URL on a self-hosted
host); \`null\` declares this repo the ROOT. It is the one relationship the tool could not see: the
parent lived only in a local git remote, so a tree's shape died with the machine that held it. With
it, \`offshoot-fanout clone <root>\` rebuilds the whole tree from the host alone. Note the two scopes
of the word: top-level \`stem\` is a REPO, \`branches.<name>.stem\` is a branch in THIS repo.

PRECEDENCE: the \`stem\` REMOTE still wins for merging whenever it exists. It is what git actually
fetches, and pointing it at a sibling checkout on disk is the normal way to work on a tree locally,
so a published id must never silently retarget a merge. The config is the portable truth and the
fallback. Absence stays valid forever: every tree that exists today has no \`stem\` field. When the
two disagree it is reported (\`config show\`, \`clone\`), never silently resolved — a local-path
remote is compared through its own \`origin\` first, so a local checkout of the right parent is not
drift.

\`config stem\` records it, preserving everything else in the file. \`--from-remote\` reads the repo's
existing \`stem\` remote and publishes it, which is the migration for a tree whose edges exist only
on one machine. It writes locally like \`set\`; push the config branch yourself when it looks right
(\`git push origin ${DEFAULT_CONFIG_BRANCH}\`).

\`branches\` is opt-in: when present, ONLY the listed branches participate, which is how scratch and
unrelated branches stay out of the cascade without being named. A branch with no \`stem\` is a root
node, fed by the cross-repo \`stem\` remote. \`verify\` only ever runs under \`fanout --verify\`.

\`stem\` is always a branch in the SAME repo. A root branch fed by a branch of the PARENT repo other
than its primary names it with \`stemBranch\`, which is what a repo built on a variant needs:

    {"branches": {"main": {"stemBranch": "with/local-signer"}}}

A \`stemBranch\` naming a branch the parent does not participate with is reported and the node is
left out, rather than quietly falling back to the primary and cascading from the wrong branch.

Naming: the default branch name is flat (\`${DEFAULT_CONFIG_BRANCH}\`). Git cannot hold both \`${DEFAULT_CONFIG_BRANCH}\` and any
\`${DEFAULT_CONFIG_BRANCH}/*\` branch, so pick one convention: keep the flat name, or use a nested config branch
(\`--config-branch ${DEFAULT_CONFIG_BRANCH}/fanout\`) and never create the flat one.

Options:
  --repo <path>          repo to read/write (default: cwd)
  --file <path>          config JSON to write (\`set\` only)
  --config-branch <name> branch to read/write (default: ${DEFAULT_CONFIG_BRANCH})
  --no-config            (show) report what the defaults would be, ignoring any config branch
  -h, --help             show this help
`;

const SKILLS_USAGE = `offshoot-fanout skills — install the agent skill(s) that ship with this package

Usage:
  offshoot-fanout skills [list]     list the skills and whether they are installed
  offshoot-fanout skills install    copy them into ~/.agents/skills

Options:
  --project            install into ./.agents/skills (beside the code) instead of ~
  -h, --help           show this help

Skills are copied (not symlinked), so they survive node_modules being deleted — but upgrading the
package does not upgrade an installed skill. Re-run \`install\` after upgrading offshoot-fanout.
`;

const TOP_USAGE = `offshoot-fanout — keep a template tree's stems current, from changes anywhere in the hierarchy

Subcommands:
  fanout          propagate a change DOWN the hierarchy (default)
  clone           rebuild a whole tree on a bare machine, from one repo name
  status          one-command triage of a wired hierarchy (read-only)
  drift           list descendant commits not yet in their parent (candidate backports)
  backport        cherry-pick a descendant commit UP onto an ancestor (its home), optionally cascade
  discover        find repos that share ancestry; optionally wire remotes; optionally save a registry
  link            set/create the parent remote on repo(s)
  rename-remote   bulk-rename the parent remote (e.g. original -> stem)
  config          show or write a repo's config (which lives on an orphan branch)

Run \`offshoot-fanout <subcommand> --help\` for details. The parent-template remote is named \`stem\`
by default (\`--remote\` overrides it). Each repo can also PUBLISH its parent in its config
(\`config stem\`), which is what makes a tree reconstructible with \`clone\` from its host alone.
A saved hierarchy lives at ~/.offshoot-stems/<root>.json (write one with \`discover --save\`; use it
elsewhere with \`--registry\`) — that file stays LOCAL state: filesystem paths and your \`ignore\` list.

The maintainer-side companion to \`offshoot\`: where \`offshoot\` lets a single descendant pull in template
updates (orphan branch + transform, no shared history), \`offshoot-fanout\` pushes one change to every
descendant via the \`stem\` remote against SHARED git history.
`;

function usageFor(sub: string): string {
	switch (sub) {
		case 'discover':
			return DISCOVER_USAGE;
		case 'link':
			return LINK_USAGE;
		case 'rename-remote':
			return RENAME_USAGE;
		case 'drift':
			return DRIFT_USAGE;
		case 'backport':
			return BACKPORT_USAGE;
		case 'status':
			return STATUS_USAGE;
		case 'config':
			return CONFIG_USAGE;
		case 'clone':
			return CLONE_USAGE;
		case 'skills':
			return SKILLS_USAGE;
		default:
			return FANOUT_USAGE;
	}
}

type OptDesc =
	| {
			type: 'string';
			short?: string;
			multiple?: boolean;
			default?: string | string[];
	  }
	| {type: 'boolean'; short?: string; default?: boolean};

function parseOpts(
	rest: string[],
	options: Record<string, OptDesc>,
): {
	values: Record<string, unknown>;
	positionals: string[];
} {
	const r = parseArgs({
		options,
		args: rest,
		strict: true,
		allowPositionals: true,
	});
	return {
		values: r.values as Record<string, unknown>,
		positionals: r.positionals,
	};
}

/**
 * Resolve a repo set from an explicit --registry file, else scan a folder,
 * together with the registry's persisted `ignore` list.
 */
function getRepos(
	folder: string,
	registry: string | undefined,
	remoteName: string,
): {repos: Repo[]; ignore: string[]} {
	if (registry) {
		const r = loadRegistry(registry);
		if (r) return {repos: r.repos, ignore: r.ignore};
		console.error(`registry not found or unreadable: ${registry}`);
	}
	return {repos: discoverRepos(folder, remoteName), ignore: []};
}

/** `--ignore` occurrences merged with a registry's persisted list. */
function mergeIgnore(values: Record<string, unknown>, fromRegistry: string[]) {
	const cli = (values.ignore as string[] | undefined) ?? [];
	return [...new Set([...fromRegistry, ...cli])];
}

export async function main(): Promise<number> {
	const argv = process.argv.slice(2);
	const first = argv[0];
	const sub = first && SUBCOMMANDS.has(first) ? first : 'fanout';
	const rest = sub === first ? argv.slice(1) : argv;

	if (rest.includes('-h') || rest.includes('--help')) {
		console.log(usageFor(sub));
		return 0;
	}

	switch (sub) {
		case 'fanout':
			return runFanout(rest);
		case 'discover':
			return runDiscover(rest);
		case 'link':
			return runLink(rest);
		case 'rename-remote':
			return runRename(rest);
		case 'drift':
			return runDrift(rest);
		case 'backport':
			return runBackport(rest);
		case 'status':
			return runStatus(rest);
		case 'config':
			return runConfig(rest);
		case 'clone':
			return runClone(rest);
		case 'skills':
			return runSkills(rest);
		default:
			console.log(TOP_USAGE);
			return 0;
	}
}

async function runFanout(rest: string[]): Promise<number> {
	const {values} = parseOpts(rest, {
		source: {type: 'string'},
		'base-dir': {type: 'string'},
		repos: {type: 'string', multiple: true},
		registry: {type: 'string'},
		branch: {type: 'string'},
		remote: {type: 'string', default: DEFAULT_REMOTE},
		'config-branch': {type: 'string', default: DEFAULT_CONFIG_BRANCH},
		'no-config': {type: 'boolean', default: false},
		verify: {type: 'boolean', default: false},
		ignore: {type: 'string', multiple: true},
		'dry-run': {type: 'boolean', default: false},
		'leave-conflicts': {type: 'boolean', default: false},
		'no-color': {type: 'boolean', default: false},
	});

	const remoteName = values.remote as string;
	const sourcePath = path.resolve(
		(values.source as string | undefined) ?? process.cwd(),
	);
	const baseDir = values['base-dir']
		? path.resolve(values['base-dir'] as string)
		: path.dirname(sourcePath);

	let repos: string[] | undefined;
	let registryIgnore: string[] = [];
	if (values.registry) {
		const r = loadRegistry(values.registry as string);
		if (r) {
			repos = r.repos.map((x) => x.path);
			registryIgnore = r.ignore;
		} else {
			console.error(
				`registry not found or unreadable: ${values.registry as string}`,
			);
			return 1;
		}
	} else if (values.repos) {
		repos = values.repos as string[];
	}

	const result = await propagate({
		sourcePath,
		baseDir,
		repos,
		branch: values.branch as string | undefined,
		remoteName,
		configBranch: values['config-branch'] as string,
		useConfig: !values['no-config'],
		verify: values.verify as boolean,
		ignore: mergeIgnore(values, registryIgnore),
		dryRun: values['dry-run'] as boolean,
		leaveConflicts: values['leave-conflicts'] as boolean,
	});
	console.log(formatReport(result, {color: !values['no-color']}));
	const s = summarize(result);
	const bad = s.conflicts + s.errors + s.dirty + s.verifyFailed;
	if (bad > 0) {
		console.log(
			`\n${bad} node(s) need attention (${s.conflicts} conflict, ${s.errors} error, ${s.dirty} dirty, ${s.verifyFailed} verify failed).`,
		);
	}
	for (const dir of keptWorktrees(result)) {
		console.log(`  left in place for inspection: ${dir}`);
		console.log(`    when done: git -C <repo> worktree remove --force ${dir}`);
	}
	return bad > 0 ? 1 : 0;
}

/** Temporary worktrees deliberately left behind (unresolved conflict, failed verify). */
function keptWorktrees(result: PropagateResult): string[] {
	const out: string[] = [];
	const walk = (n: PropagateResult) => {
		if (n.worktree) out.push(n.worktree);
		n.children.forEach(walk);
	};
	walk(result);
	return out;
}

function isDescendantOf(
	edge: {repo: {path: string}; parent: {path: string} | null},
	edges: {repo: {path: string}; parent: {path: string} | null}[],
	rootPath: string,
): boolean {
	const byPath = new Map(edges.map((e) => [e.repo.path, e] as const));
	let cur: typeof edge | undefined = edge;
	const seen = new Set<string>();
	while (cur && cur.parent && !seen.has(cur.repo.path)) {
		seen.add(cur.repo.path);
		if (path.resolve(cur.parent.path) === path.resolve(rootPath)) return true;
		cur = byPath.get(cur.parent.path);
	}
	return false;
}

function runDiscover(rest: string[]): number {
	const {values, positionals} = parseOpts(rest, {
		remote: {type: 'string', default: DEFAULT_REMOTE},
		'add-remotes': {type: 'boolean', default: false},
		root: {type: 'string'},
		yes: {type: 'boolean', default: false},
		save: {type: 'boolean', default: false},
		ignore: {type: 'string', multiple: true},
		'dry-run': {type: 'boolean', default: false},
		'no-color': {type: 'boolean', default: false},
	});

	const folder = path.resolve(positionals[0] ?? process.cwd());
	const remoteName = values.remote as string;
	const ignore = (values.ignore as string[] | undefined) ?? [];
	const trees = discoverAncestry(folder, remoteName, ignore);
	if (trees.length === 0) {
		console.log('No git repos found.');
		return 0;
	}
	console.log(formatAncestryReport(trees, {color: !values['no-color']}));

	if (values['add-remotes']) {
		const rootPath = values.root ? path.resolve(values.root as string) : null;
		if (rootPath === null && !values.yes && !values['dry-run']) {
			console.log(
				'\n--add-remotes needs --root <repo> or --yes. Nothing was changed.',
			);
			return 1;
		}
		let added = 0;
		let skipped = 0;
		for (const tree of trees) {
			for (const edge of tree.edges) {
				if (edge.parent === null) continue;
				if (edge.existingParentUrl !== null) {
					skipped++;
					continue;
				}
				if (rootPath !== null && !isDescendantOf(edge, tree.edges, rootPath))
					continue;
				const parentUrl = edge.parent.originUrl ?? edge.parent.path;
				if (values['dry-run']) {
					console.log(
						`  would add \`${remoteName}\` on ${edge.repo.name} -> ${parentUrl}`,
					);
					added++;
					continue;
				}
				const r = linkRemote(edge.repo.path, parentUrl, remoteName);
				console.log(
					`  ${r.status === 'error' ? '!' : '✓'} ${edge.repo.name} — ${r.message}`,
				);
				if (r.status === 'error') skipped++;
				else added++;
			}
		}
		console.log(
			`\n${added} remote(s) ${values['dry-run'] ? 'would be ' : ''}added, ${skipped} skipped.`,
		);
	}

	if (values.save) {
		const repos = discoverRepos(folder, remoteName).filter(
			(r) => !matchIgnore(r, ignore),
		);
		const rootFilter = values.root
			? path.resolve(values.root as string)
			: undefined;
		const files = saveRegistry(repos, remoteName, rootFilter, ignore);
		if (files.length === 0) {
			console.log('\nNo multi-repo families found; nothing saved.');
		} else {
			console.log('\nSaved registry:');
			for (const f of files) console.log(`  ${f}`);
		}
	}
	return 0;
}

function runLink(rest: string[]): number {
	const {values, positionals} = parseOpts(rest, {
		remote: {type: 'string', default: DEFAULT_REMOTE},
		to: {type: 'string', multiple: true},
		'no-color': {type: 'boolean', default: false},
	});
	const parentUrl = positionals[0];
	if (!parentUrl) {
		console.error(
			'link: a parent URL (or path) is required. See `offshoot-fanout link --help`.',
		);
		return 1;
	}
	const remoteName = values.remote as string;
	const children =
		values.to && (values.to as string[]).length > 0
			? (values.to as string[]).map((p) => path.resolve(p))
			: [process.cwd()];
	const results = children.map((c) => linkRemote(c, parentUrl, remoteName));
	console.log(formatLinkResults(results, {color: !values['no-color']}));
	return results.some((r) => r.status === 'error') ? 1 : 0;
}

function runRename(rest: string[]): number {
	const {values, positionals} = parseOpts(rest, {
		'dry-run': {type: 'boolean', default: false},
		'no-color': {type: 'boolean', default: false},
	});
	const from = positionals[0];
	const to = positionals[1];
	if (!from || !to) {
		console.error(
			'rename-remote: <from> <to> are required. See `offshoot-fanout rename-remote --help`.',
		);
		return 1;
	}
	const folder = path.resolve(positionals[2] ?? process.cwd());
	const results = renameRemotes(folder, from, to, values['dry-run'] as boolean);
	if (results.length === 0) {
		console.log(`No repos with a \`${from}\` remote found under ${folder}.`);
		return 0;
	}
	console.log(formatRenameResults(results, {color: !values['no-color']}));
	const changed = results.filter((r) => r.status === 'renamed').length;
	console.log(
		values['dry-run']
			? `\n(dry-run) ${changed} would be renamed; nothing was changed.`
			: `\n${changed} remote(s) renamed.`,
	);
	return results.some((r) => r.status === 'error' || r.status === 'taken')
		? 1
		: 0;
}

function runDrift(rest: string[]): number {
	const {values, positionals} = parseOpts(rest, {
		registry: {type: 'string'},
		remote: {type: 'string', default: DEFAULT_REMOTE},
		branch: {type: 'string'},
		'config-branch': {type: 'string', default: DEFAULT_CONFIG_BRANCH},
		'no-config': {type: 'boolean', default: false},
		ignore: {type: 'string', multiple: true},
		'no-color': {type: 'boolean', default: false},
	});
	const remoteName = values.remote as string;
	const folder = path.resolve(positionals[0] ?? process.cwd());
	const {repos, ignore} = getRepos(
		folder,
		values.registry as string | undefined,
		remoteName,
	);
	const results = driftTree(
		repos,
		remoteName,
		values.branch as string | undefined,
		{
			configBranch: values['config-branch'] as string,
			useConfig: !values['no-config'],
			ignore: mergeIgnore(values, ignore),
		},
	);
	console.log(formatDriftReport(results, {color: !values['no-color']}));
	return 0;
}

async function runBackport(rest: string[]): Promise<number> {
	const {values, positionals} = parseOpts(rest, {
		from: {type: 'string'},
		to: {type: 'string'},
		registry: {type: 'string'},
		remote: {type: 'string', default: DEFAULT_REMOTE},
		branch: {type: 'string'},
		cascade: {type: 'boolean', default: false},
		'dry-run': {type: 'boolean', default: false},
		'leave-conflicts': {type: 'boolean', default: false},
		'no-color': {type: 'boolean', default: false},
	});
	const commit = positionals[0];
	const from = values.from as string | undefined;
	if (!commit || !from) {
		console.error(
			'backport: <commit> and --from <repo> are required. See `offshoot-fanout backport --help`.',
		);
		return 1;
	}
	const remoteName = values.remote as string;
	const fromPath = path.resolve(from);
	const {repos} = getRepos(
		path.dirname(fromPath),
		values.registry as string | undefined,
		remoteName,
	);

	const result = backport({
		fromPath,
		commit,
		toPath: values.to ? path.resolve(values.to as string) : undefined,
		branch: values.branch as string | undefined,
		remoteName,
		repos,
		dryRun: values['dry-run'] as boolean,
		leaveConflicts: values['leave-conflicts'] as boolean,
	});

	const mark =
		result.status === 'backported'
			? '✓'
			: result.status === 'conflict'
				? '✗'
				: result.status === 'dry-run'
					? '•'
					: '!';
	console.log(
		`${mark} ${result.ancestorName || '?'}@${result.ancestorBranch} — ${result.message}`,
	);

	if (result.status === 'backported' && values.cascade) {
		console.log(`\nCascading from ${result.ancestorName}…`);
		const cascaded = await propagate({
			sourcePath: result.ancestorPath,
			repos: repos.map((r) => r.path),
			branch: values.branch as string | undefined,
			remoteName,
		});
		console.log(formatReport(cascaded, {color: !values['no-color']}));
	}
	return result.status === 'error' || result.status === 'conflict' ? 1 : 0;
}

async function runStatus(rest: string[]): Promise<number> {
	const {values, positionals} = parseOpts(rest, {
		registry: {type: 'string'},
		remote: {type: 'string', default: DEFAULT_REMOTE},
		branch: {type: 'string'},
		'config-branch': {type: 'string', default: DEFAULT_CONFIG_BRANCH},
		'no-config': {type: 'boolean', default: false},
		ignore: {type: 'string', multiple: true},
		'no-color': {type: 'boolean', default: false},
	});
	const remoteName = values.remote as string;
	const folder = path.resolve(positionals[0] ?? process.cwd());
	const {repos, ignore} = getRepos(
		folder,
		values.registry as string | undefined,
		remoteName,
	);
	const results = await statusTree(
		repos,
		remoteName,
		values.branch as string | undefined,
		{
			configBranch: values['config-branch'] as string,
			useConfig: !values['no-config'],
			ignore: mergeIgnore(values, ignore),
		},
	);
	console.log(formatStatusReport(results, {color: !values['no-color']}));
	const needsWork = results.some(
		(r) => r.counts.conflict > 0 || r.counts.error > 0 || r.counts.dirty > 0,
	);
	return needsWork ? 1 : 0;
}

function runConfig(rest: string[]): number {
	const {values, positionals} = parseOpts(rest, {
		repo: {type: 'string'},
		file: {type: 'string'},
		set: {type: 'string'},
		root: {type: 'boolean', default: false},
		'from-remote': {type: 'boolean', default: false},
		remote: {type: 'string', default: DEFAULT_REMOTE},
		'config-branch': {type: 'string', default: DEFAULT_CONFIG_BRANCH},
		'no-config': {type: 'boolean', default: false},
	});
	const verb = positionals[0] ?? 'show';
	if (verb !== 'show' && verb !== 'set' && verb !== 'stem') {
		console.error(
			`Unknown config command \`${verb}\`. Try \`show\`, \`set\` or \`stem\`.`,
		);
		return 2;
	}
	const repoPath = path.resolve(
		(values.repo as string | undefined) ?? process.cwd(),
	);
	const configBranch = values['config-branch'] as string;
	const remoteName = values.remote as string;

	if (verb === 'set') {
		const file = values.file as string | undefined;
		if (!file) {
			console.error(
				'config set: --file <path> is required. See `offshoot-fanout config --help`.',
			);
			return 1;
		}
		const result = writeConfig(repoPath, file, {branch: configBranch});
		console.log(`${result.ok ? '✓' : '!'} ${repoPath} — ${result.message}`);
		return result.ok ? 0 : 1;
	}

	if (verb === 'stem') {
		const explicit = values.set as string | undefined;
		const asRoot = values.root as boolean;
		const fromRemote =
			(values['from-remote'] as boolean) || (!explicit && !asRoot);
		if (explicit && asRoot) {
			console.error('config stem: --set and --root are mutually exclusive.');
			return 1;
		}

		let value: string | null;
		if (asRoot) {
			value = null;
		} else if (explicit) {
			value = explicit;
		} else {
			const remoteUrl = repoFromPath(repoPath, remoteName).originalUrl;
			if (!remoteUrl) {
				console.error(
					`config stem: ${repoPath} has no \`${remoteName}\` remote to read. ` +
						'Pass --set <owner/name>, or --root if this repo is the top of its tree.',
				);
				return 1;
			}
			// A local-path remote names a checkout, which means nothing to anyone
			// else: publish what that checkout's `origin` says instead.
			value = comparableRemote(remoteUrl);
			if (value !== remoteUrl) {
				console.log(
					`  \`${remoteName}\` points at the local clone ${remoteUrl}; publishing its origin instead`,
				);
			}
		}

		if (fromRemote && value === null && !asRoot) return 1;
		const result = setStem(repoPath, value, {branch: configBranch});
		console.log(`${result.ok ? '✓' : '!'} ${repoPath} — ${result.message}`);
		if (result.ok && result.commit) {
			console.log(
				`  push it with: git -C ${repoPath} push origin ${configBranch}`,
			);
		}
		return result.ok ? 0 : 1;
	}

	const useConfig = !values['no-config'];
	const resolved = resolveConfig(repoPath, {
		branch: configBranch,
		enabled: useConfig,
	});
	// Read the real remotes: the resolved parent is the point of `show`, and it
	// cannot be reported without knowing what the `stem` remote actually says.
	const repo = repoFromPath(repoPath, remoteName);
	const plan = planRepo(repo, {configBranch, useConfig});

	console.log(`${repo.name}  (${repoPath})`);
	switch (resolved.source) {
		case 'branch':
		case 'remote-branch':
			console.log(`  source: ${resolved.ref}`);
			console.log(
				JSON.stringify(resolved.config, null, 2)
					.split('\n')
					.map((l) => `  ${l}`)
					.join('\n'),
			);
			break;
		case 'disabled':
			console.log('  source: none (--no-config)');
			break;
		case 'error':
			console.log(`  source: ${resolved.ref} (UNUSABLE: ${resolved.error})`);
			break;
		default:
			console.log(
				resolved.note
					? `  source: none (${resolved.note}); defaults apply`
					: `  source: none (no \`${configBranch}\` or \`origin/${configBranch}\` branch); defaults apply`,
			);
	}

	const parent = resolveParent({
		remoteUrl: repo.originalUrl,
		...(resolved.config && 'stem' in resolved.config
			? {configStem: resolved.config.stem}
			: {}),
		remoteName,
	});
	console.log('\n  parent repo:');
	switch (parent.source) {
		case 'both':
			console.log(
				`    ${parent.id}  (config; \`${remoteName}\` remote agrees)`,
			);
			break;
		case 'config':
			console.log(
				`    ${parent.id}  (config; no \`${remoteName}\` remote here yet)`,
			);
			break;
		case 'remote':
			console.log(`    ${parent.url}  (\`${remoteName}\` remote only)`);
			console.log(
				`    ! not published: this edge exists only on this machine. \`config stem --from-remote\` fixes that.`,
			);
			break;
		case 'mismatch':
			console.log(`    ! MISMATCH, using the remote (it is what git fetches)`);
			console.log(`      config: ${parent.conflict?.config}`);
			console.log(`      remote: ${parent.conflict?.remote}`);
			break;
		case 'declared-root':
			console.log('    none: config declares this repo the root of its tree');
			break;
		default:
			console.log(
				`    unknown: no \`${remoteName}\` remote and no \`stem\` in the config`,
			);
	}
	if (parent.error) console.log(`    ! ${parent.error}`);

	console.log('\n  resolved nodes:');
	if (plan.error) {
		console.log(`    ! ${plan.error}`);
	} else {
		for (const b of plan.branches) {
			const kind =
				b.stems.length === 0
					? `root (fed by the \`stem\` remote)${b.name === plan.primary ? ', primary' : ''}`
					: b.stems.length === 1
						? `stem: ${b.stems[0]} (in-repo)`
						: `stems: ${b.stems.join(', ')} (in-repo, integration node)`;
			console.log(`    ${repo.name}@${b.name} — ${kind}`);
		}
		if (plan.note) console.log(`    (${plan.note})`);
	}
	console.log(
		`  verify: ${plan.verify ? `${plan.verify}   (only runs with --verify)` : 'none'}`,
	);
	return resolved.source === 'error' ? 1 : 0;
}

async function runClone(rest: string[]): Promise<number> {
	const {values, positionals} = parseOpts(rest, {
		dir: {type: 'string'},
		remote: {type: 'string', default: DEFAULT_REMOTE},
		'config-branch': {type: 'string', default: DEFAULT_CONFIG_BRANCH},
		protocol: {type: 'string'},
		'prefer-https': {type: 'boolean', default: false},
		'require-auth': {type: 'boolean', default: false},
		'dry-run': {type: 'boolean', default: false},
		'no-color': {type: 'boolean', default: false},
	});

	const root = positionals[0];
	if (!root) {
		console.error(
			'clone: give the root repo, e.g. `offshoot-fanout clone wighawag/template-svelte`.',
		);
		return 1;
	}
	const preferHttps = values['prefer-https'] as boolean;
	const protocol =
		(values.protocol as string | undefined) ??
		(preferHttps ? 'https' : undefined);
	if (protocol && protocol !== 'ssh' && protocol !== 'https') {
		console.error(
			`clone: --protocol must be ssh or https (got \`${protocol}\`).`,
		);
		return 1;
	}

	const dryRun = values['dry-run'] as boolean;
	let result;
	try {
		result = await cloneTree(root, {
			...(values.dir ? {dir: values.dir as string} : {}),
			configBranch: values['config-branch'] as string,
			remote: values.remote as string,
			...(protocol ? {protocol: protocol as 'ssh' | 'https'} : {}),
			requireAuth: values['require-auth'] as boolean,
			dryRun,
			onProgress: (line) => console.log(`  ${line}`),
		});
	} catch (e) {
		console.error(`! ${e instanceof Error ? e.message : String(e)}`);
		return 1;
	}

	console.log(
		`\n${result.root}  (root commit ${result.rootCommits.map((c) => c.slice(0, 10)).join(', ')})`,
	);

	// Index children by their parent's `owner/name`, so a stem written as an id,
	// a URL or a bare pair all land under the same key.
	const byParent = new Map<string, typeof result.members>();
	for (const m of result.members) {
		if (m.status !== 'member' || !m.stem) continue;
		const key = parseStem(m.stem).path.toLowerCase();
		byParent.set(key, [...(byParent.get(key) ?? []), m]);
	}
	const wiredFor = new Map(result.outcomes.map((o) => [o.member.fullName, o]));

	console.log('\n  tree:');
	const walk = (fullName: string, depth: number): void => {
		const outcome = wiredFor.get(fullName);
		const mark = outcome
			? outcome.action === 'cloned'
				? dryRun
					? 'would clone'
					: 'cloned'
				: outcome.action
			: '';
		console.log(
			`    ${'  '.repeat(depth)}${fullName}${mark ? `  (${mark})` : ''}`,
		);
		if (outcome?.message) {
			console.log(`    ${'  '.repeat(depth)}  ! ${outcome.message}`);
		}
		for (const child of byParent.get(fullName.toLowerCase()) ?? []) {
			walk(child.fullName, depth + 1);
		}
	};
	const rootMember = result.members.find((m) => m.status === 'root');
	if (rootMember) walk(rootMember.fullName, 0);

	if (result.outsideSubtree.length > 0) {
		console.log(
			'\n  other members of this family, not under the requested root (not cloned):',
		);
		for (const name of result.outsideSubtree) console.log(`    ${name}`);
	}

	const discarded = result.members.filter(
		(m) => m.status === 'unannotated' || m.status === 'foreign-root',
	);
	if (discarded.length > 0) {
		console.log(
			'\n  discarded (share the root commit, not part of this tree):',
		);
		for (const m of discarded) console.log(`    ${m.fullName} — ${m.reason}`);
	}

	const unreadable = result.members.filter((m) => m.status === 'unreadable');
	if (unreadable.length > 0) {
		console.log('\n  could not be read:');
		for (const m of unreadable)
			console.log(`    ! ${m.fullName} — ${m.reason}`);
	}

	if (result.dangling.length > 0) {
		console.log('\n  edges pointing outside the discovered set:');
		for (const d of result.dangling) {
			console.log(`    ! ${d.repo} stems from ${d.stem}, which was not found`);
		}
	}
	if (result.incomplete) {
		console.log(
			'\n  ! the host reported its search results as incomplete: some members may be missing.',
		);
	}
	if (result.auth === 'none') {
		// Silence here would be a lie: an unauthenticated search cannot see a
		// private member at all, so the tree above would look complete while a
		// whole branch of it was invisible. Measured on a real tree: 12 repos
		// found unauthenticated, 17 with a token.
		console.log(
			'\n  ! running UNAUTHENTICATED, so PRIVATE members of this tree were invisible — and an',
		);
		console.log(
			'    incomplete tree looks exactly like a complete one. Run `gh auth login`, or set',
		);
		console.log(
			'    GITHUB_TOKEN, then re-run. Use --require-auth to make this a hard failure.',
		);
	} else {
		console.log(`\n  authenticated via ${result.auth}`);
	}

	const failed = result.outcomes.filter((o) => o.action === 'failed');
	return failed.length > 0 || unreadable.length > 0 ? 1 : 0;
}

function runSkills(rest: string[]): number {
	const scope = rest.includes('--project') ? 'project' : 'user';
	const available = availableSkills();
	if (available.length === 0) {
		console.error(
			'No skills found beside this package. A published install carries them; a checkout keeps them at the repo root.',
		);
		return 1;
	}

	const verb = rest.find((argument) => !argument.startsWith('-'));
	if (verb && verb !== 'install' && verb !== 'list') {
		console.error(
			`Unknown skills command \`${verb}\`. Try \`list\` or \`install\`.`,
		);
		return 2;
	}

	if (verb !== 'install') {
		console.log(`${destinationFor(scope)}\n`);
		for (const skill of available) {
			const mark = isInstalled(skill, scope) ? 'installed' : 'not installed';
			console.log(`  ${skill.name}  (${mark})\n    ${skill.description}\n`);
		}
		console.log('Run `offshoot-fanout skills install` to copy them in.');
		return 0;
	}

	const installed = installSkills(scope);
	for (const entry of installed) {
		console.log(`  ${entry.replaced ? 'replaced' : 'installed'}  ${entry.to}`);
	}
	console.log(
		`\n${installed.length} skill${installed.length === 1 ? '' : 's'} copied. They are copies, so re-run this after upgrading offshoot-fanout.`,
	);
	return 0;
}

main()
	.then((code) => {
		process.exitCode = code;
	})
	.catch((e) => {
		console.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
		process.exitCode = 1;
	});
