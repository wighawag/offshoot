# offshoot-fanout

Propagate a template change **down** to every descendant repo and report merge conflicts — the **maintainer-side** companion to [`offshoot`](../offshoot).

| | `offshoot` | `offshoot-fanout` |
|---|---|---|
| who runs it | the descendant's developer | the template maintainer |
| mechanism | orphan `template` **branch** + transform, for descendants that **don't** share history | `stem` **remote** + `git merge` against **shared** history |
| direction | **pull** one update into one project | **push** one change to every descendant |

`offshoot-fanout` walks a family of repos that derive from each other via a `stem` git remote (the parent template), and merges the parent's current branch into each descendant, top to bottom, so a change made anywhere in the hierarchy flows to the leaves in one pass. No push required: each child fetches its parent's **local** ref, so a freshly-merged intermediate template cascades its new state to its own children immediately.

The unit of work is a **node**: a `(repo, branch)` pair, not a repo. That is what makes the destination branch something the tool controls and reports, instead of "whatever the child happened to have checked out".

> The parent remote is named `stem` by default (an offshoot grows from a stem; fanout flows down the stems). `--remote <name>` overrides it everywhere. This is deliberately distinct from `offshoot`'s `template` **branch**, which uses an orphan-branch transform model — the two mechanisms serve disjoint repo types.

Requires the `git` binary and Node 20+.

## Subcommands

```
offshoot-fanout status         one-command triage: what needs doing (wiring, downstream, upstream)
offshoot-fanout fanout         propagate a change down the hierarchy (default)
offshoot-fanout drift          list descendant commits not yet in their parent (candidate backports)
offshoot-fanout backport       cherry-pick a descendant commit up onto an ancestor (its home), optionally cascade
offshoot-fanout discover       find repos that share common ancestry; optionally wire remotes; optionally save a registry
offshoot-fanout link           set/create the parent remote on repo(s)
offshoot-fanout rename-remote  bulk-rename the parent remote (e.g. original -> stem)
offshoot-fanout config         show or write a repo's config (which lives on an orphan branch)
offshoot-fanout skills         install the agent skill into ~/.agents/skills
```

Run `offshoot-fanout <subcommand> --help` for full options. A saved hierarchy lives at
`~/.offshoot-stems/<root>.json` (write one with `discover --save`; use it elsewhere with `--registry`).

## Agent skill

This package ships a `reconcile-template-tree` skill that drives the whole flow (map → triage → find each change's home → land + cascade + backport → resolve conflicts → verify). Install it for your agent:

```bash
offshoot-fanout skills            # list the skill(s) and whether they are installed
offshoot-fanout skills install    # copy into ~/.agents/skills
offshoot-fanout skills install --project   # or into ./.agents/skills, beside the code
```

Skills are copied (not symlinked), so re-run `install` after upgrading the package.

## fanout (default)

From inside the repo you changed (the "spot"):

```bash
offshoot-fanout --dry-run      # report only; no merge commits, no branch changes
offshoot-fanout                # merge down the tree
```

```
◆ template-svelte@main source
└─ ✗ template-svelte-tailwind@main CONFLICT — conflict in 2 file(s) — aborted
     web/src/lib/core/notifications/Notifications.svelte
   ├─ ⊘ template-svelte-shadcn@main skipped — parent not updated (conflict)
   │   └─ ⊘ jolly-roger@main skipped — parent not updated (skipped)
   └─ …
– jolly-roger-work is a linked worktree of jolly-roger (same repository) — not a node
```

Every line names the node as `repo@branch`, because the destination branch is the thing that used to be invisible.

Options: `--source`, `--base-dir`, `--repos`, `--registry`, `--branch` (global override), `--remote` (default `stem`), `--config-branch` (default `offshoot`), `--no-config`, `--verify`, `--ignore` (repeatable), `--dry-run`, `--leave-conflicts`, `--no-color`. Exit code is non-zero if any node conflicts/errors/has a dirty tree/fails `--verify`.

## Nodes: `(repo, branch)`

Two kinds of edge feed a node:

- **cross-repo**: the `stem` remote match (a child's `stem` URL normalizes to a parent's `origin` URL), from the parent's **primary** branch into each of the child's **root** branches. Needs a fetch.
- **in-repo**: a branch whose stem is another branch *in the same repo*. `variant/full` derives from `main` exactly the way a child repo derives from its parent, and no fetch is involved.

A repo with no config is a single node: `main` if that branch exists, otherwise the repo's current HEAD branch (which the report says out loud). So a tree where every repo only uses `main` behaves exactly as before. `--branch <name>` is a **global override**: every repo becomes one node at that branch, and `branches` config is ignored.

BFS over nodes gives the correct order for free: `shadcn@main` → `jolly-roger@main` → `jolly-roger@variant/full`. A failed node still marks its descendants `skipped`.

## Merging into a branch that is not checked out

`git checkout` is never used: it mutates your working state and dies on a dirty tree. Instead:

- if the target branch is already checked out (in the repo's main worktree, or in one of its linked worktrees), the merge happens **in place, there**, exactly as before, so you find the conflict where you expect it and `--leave-conflicts` behaves as documented;
- otherwise the merge happens in a **temporary linked worktree** (`git worktree add`), removed afterwards;
- on conflict inside a temporary worktree, `--leave-conflicts` **keeps** it and prints its path (otherwise the flag would be meaningless for that node). A failed `--verify` keeps it for the same reason;
- a dirty tree only blocks the branch that is actually checked out, not the whole repo. A dirty branch is reported as `dirty` by `--dry-run` and `status` too, so a dry-run never promises a merge that the real run then refuses.

```
✗ jolly-roger@main CONFLICT — conflict in 1 file(s) — left in a temporary worktree: /tmp/offshoot-fanout-worktrees/jolly-roger-main-6f1a2b3c
  left in place for inspection: /tmp/offshoot-fanout-worktrees/jolly-roger-main-6f1a2b3c
    when done: git -C <repo> worktree remove --force /tmp/offshoot-fanout-worktrees/jolly-roger-main-6f1a2b3c
```

Resolve it there, commit, then re-run `fanout`; the node reports `up to date` and the cascade continues past it. Kept worktrees are never cleaned up behind your back, so remove them yourself when done (the command is printed, and `git worktree list` in the repo shows any you have forgotten).

## Config on an orphan branch

A template should not have to carry an offshoot-specific file in its working tree, so config lives on an **orphan branch** (default `offshoot`) in `fanout.config.json`, and is read without ever checking it out:

```bash
git show offshoot:fanout.config.json
git show origin/offshoot:fanout.config.json   # fallback on a fresh clone
```

```json
{
  "branches": {
    "main": {},
    "variant/full": {"stem": "main"}
  },
  "verify": "pnpm install && pnpm --filter ./web check"
}
```

- `branches` is **opt-in**: when present, only the listed branches participate. That is what keeps `work`, `variant/offline` and `website` out of the cascade without naming them. A branch with no `stem` is a root node fed by the cross-repo `stem` remote.
- `verify` is a command run in a merged node. It only ever runs behind `--verify`, never automatically, because it means executing a command string read from a git ref. Pass/fail is reported per node in the same tree output.

Absent config means today's defaults, so a repo that matches the defaults stays completely free of offshoot references. `offshoot` is an ordinary word, so a branch of that name holding **no** `fanout.config.json` is treated as a name collision (defaults apply, and the report says so) rather than an error. A config file that *is* there and does not parse is a real error: the node fails and its descendants are skipped, without any merge being attempted.

```bash
offshoot-fanout config show --repo ./jolly-roger      # resolved config + where it came from
offshoot-fanout config set  --repo ./jolly-roger --file ./fanout.config.json
offshoot-fanout fanout --config-branch offshoot/fanout   # a different branch
offshoot-fanout fanout --no-config                       # ignore config branches entirely
```

`config set` writes with plumbing (`hash-object -w`, `mktree`, `commit-tree`, `update-ref`), so your working tree, index and current branch are never touched, and the orphan branch is created if absent.

> **Why a branch and not a file at the root.** An in-tree `.offshoot-fanout.json` in the root template would cascade into every descendant and conflict at every level on every change, because the file's entire content is per-repo (each repo's branch list, each repo's verify command). A file that must differ at every level, living on a branch that merges to every level, is a permanent conflict generator. An orphan branch has no merge base with anything, so it never propagates and never conflicts.

> **Naming.** The default branch name is flat: `offshoot`. Git cannot hold both a branch named `offshoot` and any `offshoot/*` branch (a ref file cannot also be a directory), so pick one convention: keep the flat name, or use a nested config branch (`--config-branch offshoot/fanout`) and never create the flat one.

## Ignoring things

**Linked worktrees are always skipped**, not as an option. A linked worktree (`git worktree add`) is the *same repository*: it has a `.git`, and it inherits its repo's `stem` remote, so remotes alone can never tell them apart. It is detected by comparing `git rev-parse --git-dir` with `--git-common-dir`, never becomes a node, and is mentioned once as a worktree of its repo:

```
– jolly-roger-work is a linked worktree of jolly-roger (same repository) — not a node
```

**Explicit ignores** are for repos that exist on disk but must stay out of the tree (a deprecated template whose folder has not been deleted yet). This is maintainer-local state, so it lives in the CLI and the registry, never in a repo's config branch:

```bash
offshoot-fanout status --ignore template-onchain-app --ignore ./old-thing
offshoot-fanout discover . --save --root ./template-svelte --ignore template-onchain-app
```

`--ignore` takes a repo name or a path and is repeatable; `discover --save` merges it into the registry's `ignore` array, **preserving** any existing entries rather than clobbering them. Ignored and skipped nodes stay visible in the report (`– deprecated@main ignored`), never silently absent.

## verify

None of a real template tree's repos necessarily has a root `check` script, and rediscovering the right command per repo by hand is exactly the toil this removes. Declare it once per repo on its config branch, then opt in:

```bash
offshoot-fanout --verify
```

```
✓ jolly-roger@main merged — merged 12 file(s) into main in a temporary worktree
  ✓ verify passed
  └─ ✓ jolly-roger@variant/full merged — merged 12 file(s) into variant/full in a temporary worktree
     ✗ verify FAILED (exit 1): 5 errors, 0 warnings
```

A failing verify does not un-merge anything and does not block the cascade (the merge already happened); it is reported per node and makes the exit code non-zero. When the node was merged in a temporary worktree, that worktree is **kept** and its path printed, so there is somewhere to go and reproduce the failure.

## drift

Find descendant commits that aren't yet in their parent, the candidate backports. Reported per **node**, against that node's stem: the parent repo's primary branch for a root branch, or the sibling branch named by its `stem` for an in-repo branch.

```bash
offshoot-fanout drift ./dev-folder --remote stem
```

```
▲ conquest-website-2@main (95 ahead of template-svelte-tailwind-blog@main)
  e76298ef  notifications: adopt the generic service + service-worker DI from jolly-roger
  a434315d  core: sync framework-agnostic drift from jolly-roger
▲ template-svelte-tailwind@main (22 ahead of template-svelte@main)
  …
```

Review the list, then `backport` the commits that genuinely belong upstream. Read-only (fetches objects).

## backport

Move a descendant commit **up** to its home ancestor: cherry-pick it onto the ancestor, then (with
`--cascade`) fan it back out to every descendant.

```bash
offshoot-fanout backport e76298ef --from ./conquest-website-2 --to ./template-svelte --cascade
```

`--to` defaults to the `--from` repo's immediate `stem` parent; pass a higher ancestor when the change's
home is further up the tree. `--dry-run` shows the commit without applying; `--leave-conflicts` keeps
a conflicted cherry-pick in progress for manual resolution (same pattern as `fanout`).

The full loop: `drift` spots relevant descendant changes → `backport --to <home>` lands one upstream →
`fanout` (or `backport --cascade`) spreads it back down. The judgement of *which* commit belongs where
stays with you; the tool does the mechanics.

## discover

Find repos that share common git ancestry — scans a folder, groups repos by shared commit history, and proposes a parent→child tree per family (root = fewest commits, tie-broken by oldest HEAD). Direction can't be proven once both sides diverged past the fork, so the tree is a **proposal** — review before applying.

```bash
offshoot-fanout discover ./some-folder --remote stem
offshoot-fanout discover ./some-folder --add-remotes --root ./template-svelte   # wire the unwired descendants of that root
offshoot-fanout discover ./some-folder --add-remotes --yes --dry-run             # preview what would be added
offshoot-fanout discover ./some-folder --save --root ./template-svelte          # persist that hierarchy to a registry
```

`--add-remotes` adds the `stem` remote to unwired repos (pointing at their detected parent's `origin` URL). It needs `--root <repo>` (anchor direction; only that root's subtree is wired) or `--yes` (accept the proposed tree). `--dry-run` shows what would be added without adding. `--save` writes a registry (see below); scoped to one hierarchy with `--root`.

## Registry

`discover --save` persists each **wired** hierarchy (defined by the real `stem` remotes, not shared commits) to `~/.offshoot-stems/<root>.json`, one file per hierarchy, so several independent trees coexist. Each entry records the repo's `originUrl`, its current `stemUrl` (null = unwired), and its real `stem` parent; an optional `ignore: []` array carries the maintainer-local exclusions. The other commands then take `--registry <file>` to operate off the saved tree instead of scanning:

```bash
offshoot-fanout fanout  --registry ~/.offshoot-stems/template-svelte.json --dry-run
offshoot-fanout drift   --registry ~/.offshoot-stems/template-svelte.json
offshoot-fanout backport <sha> --from ./jolly-roger --registry ~/.offshoot-stems/template-svelte.json --cascade
```

## link

Manually set/create the parent remote on repo(s) — for the one-off cases discovery can't handle:

```bash
offshoot-fanout link git@github.com:wighawag/template-svelte.git --to ./my-app --remote stem
```

Adds (or repoints) `stem` on each `--to` repo (default: cwd).

## rename-remote

Migrate the parent-remote name across a folder, e.g. `original` → `stem`:

```bash
offshoot-fanout rename-remote original stem ./dev-folder --dry-run   # preview
offshoot-fanout rename-remote original stem ./dev-folder             # do it
```

Renames `original`→`stem` in every repo that has `original`; repos without it are skipped; a `stem` that already exists with a different URL is left untouched (not clobbered). **`--dry-run` is read-only** (it reports "would rename" and performs nothing).

## Library

```ts
import {propagate, formatReport, discoverAncestry} from 'offshoot-fanout';

const result = await propagate({sourcePath: '/path/to/template-svelte', dryRun: true});
console.log(formatReport(result));

const families = discoverAncestry('/path/to/dev-folder'); // FamilyTree[]
```

## How fanout works

1. **Discover**: scan the source's parent dir for git repos, read each one's `origin` and `stem` remotes. Linked worktrees are excluded here.
2. **Plan each repo**: read its config branch with `git show` (never checking it out) to get its participating branches and their in-repo stems; with no config, one node at `main` (or the checked-out branch).
3. **Build the tree**: match each repo's `stem` URL (normalized across SSH/HTTPS/`.git`/case) to another repo's `origin` URL to find its parent, then wire parent-primary → child-root edges and in-repo branch edges.
4. **Cascade** (BFS over nodes): each child fetches its parent's **local** clone (freshest post-merge state) and merges the fetched commit with `git merge --no-ff`, in place or in a temporary worktree. On conflict, abort (or leave with `--leave-conflicts`) and report the files.
5. A failed node's descendants are marked `skipped` (still visited/rendered) rather than merged against stale state.

`--dry-run` fetches objects, then computes the merge **in memory** with `git merge-tree --write-tree`: no branch, index, working tree or worktree is touched. (On git older than 2.38 it falls back to `git merge --no-commit --no-ff` + `git merge --abort`.) One consequence worth knowing: a dry-run evaluates each node against its parent's *current* state, so a node below one that would merge can report `up to date` where a real run would merge.

## Adding a repo to the hierarchy

```bash
git remote add stem <parent-template-url>
```

The repo must share at least one common ancestor commit with its parent (created by cloning/forking). If it was scaffolded with placeholders and shares no history, that's `offshoot`'s job (orphan branch + transform), not this one.