# offshoot-fanout

Propagate a template change **down** to every descendant repo and report merge conflicts — the **maintainer-side** companion to [`offshoot`](../offshoot).

| | `offshoot` | `offshoot-fanout` |
|---|---|---|
| who runs it | the descendant's developer | the template maintainer |
| mechanism | orphan `template` **branch** + transform, for descendants that **don't** share history | `stem` **remote** + `git merge` against **shared** history |
| direction | **pull** one update into one project | **push** one change to every descendant |

`offshoot-fanout` walks a family of repos that derive from each other via a `stem` git remote (the parent template), and merges the parent's current branch into each descendant, top to bottom, so a change made anywhere in the hierarchy flows to the leaves in one pass. No push required: each child fetches its parent's **local** HEAD, so a freshly-merged intermediate template cascades its new state to its own children immediately.

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
◆ template-svelte source
└─ ✗ template-svelte-tailwind CONFLICT — conflict in 2 file(s) — aborted
     web/src/lib/core/notifications/Notifications.svelte
   ├─ ⊘ template-svelte-shadcn skipped — parent not updated (conflict)
   │   └─ ⊘ jolly-roger skipped — parent not updated (skipped)
   └─ …
```

Options: `--source`, `--base-dir`, `--repos`, `--branch` (default `main`), `--remote` (default `stem`), `--dry-run`, `--leave-conflicts`, `--no-color`. Exit code is non-zero if any descendant conflicts/errors/has a dirty tree.

## drift

Find descendant commits that aren't yet in their parent — the candidate backports. For each repo with a
`stem` parent, lists `git log stem/main..HEAD`:

```bash
offshoot-fanout drift ./dev-folder --remote stem
```

```
▲ conquest-website-2 (95 ahead)
  e76298ef  notifications: adopt the generic service + service-worker DI from jolly-roger
  a434315d  core: sync framework-agnostic drift from jolly-roger
▲ template-svelte-tailwind (22 ahead)
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

`discover --save` persists each **wired** hierarchy (defined by the real `stem` remotes, not shared commits) to `~/.offshoot-stems/<root>.json` — one file per hierarchy, so several independent trees coexist. Each entry records the repo's `originUrl`, its current `stemUrl` (null = unwired), and its real `stem` parent. The other commands then take `--registry <file>` to operate off the saved tree instead of scanning:

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

1. **Discover** — scan the source's parent dir for git repos, read each one's `origin` and `stem` remotes.
2. **Build the tree** — match each repo's `stem` URL (normalized across SSH/HTTPS/`.git`/case) to another repo's `origin` URL to find its parent.
3. **Cascade** (BFS) — each child fetches its parent's **local** clone (freshest post-merge state), then `git merge --no-ff`. On conflict, abort (or leave with `--leave-conflicts`) and report the files.
4. A failed node's descendants are marked `skipped` (still visited/rendered) rather than merged against stale state.

`--dry-run` does `git fetch` + `git merge --no-commit --no-ff` then `git merge --abort` — leaves the working tree and branches untouched (only objects are fetched).

## Adding a repo to the hierarchy

```bash
git remote add stem <parent-template-url>
```

The repo must share at least one common ancestor commit with its parent (created by cloning/forking). If it was scaffolded with placeholders and shares no history, that's `offshoot`'s job (orphan branch + transform), not this one.