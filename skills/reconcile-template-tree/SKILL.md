---
name: reconcile-template-tree
description: "Reconcile divergence across a template tree that tracks parents via `stem` git remotes (offshoot-fanout): find each change's home level, land it there once, cascade it to every descendant, resolve conflicts by intent, and verify each touched repo still builds. Use when the user wants a change moved up to its template home, propagated down to variants/descendants, a variant synced with its parent, or dependencies updated across the tree."
---

# Template tree reconciliation (with `offshoot-fanout`)

Repos that derive from each other form a tree: a base template, variants that add a layer, and sites built on those variants. Each repo names its parent through a git remote called `stem` (the offshoot convention: an offshoot grows from a stem; `offshoot-fanout` flows changes down the stems). A repo can also hold sibling variants as **branches**, where one branch derives from another the same way a child repo derives from its parent, so the real unit is a **node**: a `(repo, branch)` pair. Work done in one node constantly needs to move to another. Every change has a **home**: the highest level of the tree where it is still meaningful. Put it there once, then **cascade** it down. Anything landed below its home is a change every sibling silently misses.

The mechanical parts — mapping the tree, cascading a merge top to bottom, and reporting exactly where conflicts block — are done by `offshoot-fanout`. The judgment parts — deciding a change's home, and resolving a conflict by intent rather than by blindly taking a side — are yours. Do not shortcut them.

## 0. The tool

`offshoot-fanout` is the maintainer-side companion to `offshoot`. Subcommands:

```
offshoot-fanout fanout          propagate a change down the hierarchy (default)
offshoot-fanout status          one-command triage of a wired hierarchy (read-only)
offshoot-fanout drift           list descendant commits not yet in their parent (candidate backports)
offshoot-fanout backport        cherry-pick a descendant commit up onto an ancestor (its home), optionally cascade
offshoot-fanout discover        find repos that share ancestry; show the tree + wiring; optionally wire + save a registry
offshoot-fanout link            set/create the `stem` remote on repo(s)
offshoot-fanout rename-remote   bulk-rename the parent remote (e.g. original -> stem)
offshoot-fanout config          show or write a repo's config (which lives on an orphan branch)
```

The parent remote defaults to `stem`; `--remote <name>` overrides it everywhere. `fanout`, `discover --add-remotes`, `backport`, and `rename-remote` honor `--dry-run` (read-only). A saved hierarchy lives at `~/.offshoot-stems/<root>.json`; pass `--registry <file>` to `fanout`/`drift`/`backport`/`status` to use it instead of scanning. Run `offshoot-fanout <subcommand> --help` for options.

If `offshoot-fanout` is not on PATH, run the built CLI directly — build it once in the `offshoot` repo, then invoke `node <offshoot>/packages/offshoot-fanout/dist/cli.js …` in place of `offshoot-fanout …` below.

This skill ships with the package; `offshoot-fanout skills install` is what copies it into `~/.agents/skills`. It is a copy, so re-run that after upgrading the package to refresh it.

`offshoot-fanout` only merges repos that **share git history** with their parent (created by cloning/forking). A repo in the family that shares no history (scaffolded with transforms, like an `offshoot` project) cannot be merged — it is a **hand port**, never a merge. `discover` surfaces this: such repos form their own ancestry family or show no shared commits.

## 1. Map the tree (discover it, never assume it)

    offshoot-fanout discover <folder> --remote stem

This scans the folder, groups repos by shared commit history, and proposes a parent→child tree per family, marking each repo's `stem` wiring (`✓` wired, `⚠` unwired). Direction (which member is the root) is a *proposal* — root = fewest commits, tie-broken by oldest HEAD — because direction can't be proven once both sides diverged past the fork. When you act on it, anchor with `--root <repo>`.

Run it rather than trusting any snapshot. Sites get built on these templates without any list being updated, and a repo can drift far behind its parent before anyone notices. Membership is decided by shared ancestry + the `stem` remote, **not** by a `template-` prefix in the name — many `template-*` repos are unrelated.

### The tree is nodes, not repos

The cross-repo `stem` edge above is only one of the two kinds:

- **cross-repo**: the `stem` remote, a branch of the parent merges into each of the child's root branches. The parent's primary by default; a child built on a VARIANT of its parent names the branch it grows from with `stemBranch` (see below).
- **in-repo**: a branch whose stem is another branch *in the same repo*. One repo can hold four sibling variants of a template as branches (`main`, `variant/full`, `variant/offline`, `website`) plus scratch branches, and `variant/full` derives from `main` exactly the way a child repo derives from its parent.
- **in-repo with several stems**: an *integration branch* that combines independent extensions, e.g. `extended/complete` over `extended/hosted-account` + `extended/local-signer`. It merges every stem, in the order listed, and only once all of them are done.

Every report line is `repo@branch`, so the destination branch is always visible. A node with several stems is rendered in full under the first one and cross-linked under the others (`↳ … shown under …`); it is one node, counted once, not two.

If **any** stem of an integration node fails, the node is `skipped` rather than merged from just the stems that worked. If a later stem conflicts, the earlier merges stay committed and the message names both what landed and what blocked: resolve the conflict, then re-run, and the remaining stems continue from there. Two traps this exists to close, both observed on a live tree:

- A repo whose checked-out branch is *not* its node branch used to receive the update on the checked-out branch (a `variant/full` checkout swallowed a `main` update, and the report still said `merged`). The tool now never `git checkout`s: it merges in place if the target branch is checked out, otherwise in a temporary worktree, and says which branch it merged into.
- A **linked worktree** (`git worktree add`, e.g. `jolly-roger-work`) has a `.git` and inherits its repo's `stem` remote, so it looks exactly like a separate repo and produced a permanent "refusing to merge unrelated histories" false alarm. It is now always skipped and mentioned once as a worktree of its repo. Never add one to a registry or a `--repos` list.

A repo with no config is one node (`main`, else the checked-out branch), so a tree that only uses `main` needs no configuration at all. Where in-repo topology exists, declare it on the repo's **config branch** (§1b). Check what the tool resolved before planning anything:

    offshoot-fanout config show --repo <repo>

### 1b. Config lives on an orphan branch

A template carries no offshoot file in its working tree. Per-repo config sits on an orphan branch (default `offshoot`) in `fanout.config.json`, read with `git show` and never checked out:

```json
{
  "branches": {
    "main": {},
    "variant/full": {"stem": "main"},
    "extended/complete": {"stem": ["extended/hosted-account", "extended/local-signer"]}
  },
  "verify": "pnpm install && pnpm --filter ./web check"
}
```

Watch for the difference between an array and a chain. `["a", "b"]` says "combines two independent extensions"; `b` stemming from `a` says "b is built on a", so `b` inherits everything `a` does. Reach for the array when the extensions are siblings, and question any existing chain that was really meant as a combination: a chain silently pollutes each branch with the previous one's work.

`branches` is opt-in: when present, **only** the listed branches participate, which is how scratch branches (`work`) and unrelated variants (`variant/offline`, `website`) stay out of the cascade without being named. A branch with no `stem` is a root node fed by the cross-repo `stem` remote.

**A cross-repo edge has a branch at both ends, and the child names the far one.** `stem` is always a branch in the SAME repo; a root branch fed from a branch of the PARENT repo other than its primary says so with `stemBranch`:

```json
{"branches": {"main": {"stemBranch": "with/local-signer"}}}
```

Reach for it whenever a repo was built on a variant rather than on the parent's mainline, and check for it whenever a descendant conflicts far more than its siblings. Measured on a live tree: a site built on `with/local-signer` and fed from `main` reported **13 conflicted files against 3** from its real parent, and the ten extra were exactly the files that differ between the two branches. That is worse than noise, because the ordinary resolution of those ten silently reverts the site off the variant it is built on, in files that still compile, and thirteen conflicts in a repo that is behind reads as ordinary drift. A `stemBranch` naming a branch the parent does not participate with is reported and the node is excluded, rather than quietly falling back to the primary.

Write it with plumbing, which never touches the working tree or the current branch:

    offshoot-fanout config set --repo <repo> --file ./fanout.config.json

A branch named `offshoot` that holds no `fanout.config.json` is a name collision, not config: the defaults apply and the report says so. A config file that is present and does not parse is a hard error, and the node plus everything under it is skipped without a merge being attempted.

Do not propose an in-tree config file instead. Its content is per-repo, so a file at the root template would cascade to every descendant and conflict at every level on every change; an orphan branch has no merge base with anything, so it never propagates and never conflicts. Note the naming constraint: a branch named exactly `offshoot` forbids any `offshoot/*` branch, so keep the flat name or use `--config-branch offshoot/fanout` consistently.

Repos that exist on disk but must stay out of the tree (a deprecated template whose folder has not been deleted yet) are **maintainer-local** state, not repo config: use `--ignore <path-or-name>` (repeatable), and persist it with `discover --save`, which merges it into the registry's `ignore` array rather than clobbering it. Ignored nodes stay visible in the report as `ignored`; if something is missing from a report entirely, it was never a node, so find out why before assuming it is fine.

Confirm shared history before planning any merge, since a repo can look related and not be:

    git -C <child> merge-base HEAD stem/main      # non-empty = mergeable; empty = hand port

Persist the tree once you trust it, then reuse it instead of re-scanning:

    offshoot-fanout discover <folder> --remote stem --save --root <root>     # writes ~/.offshoot-stems/<root>.json
    offshoot-fanout fanout --registry ~/.offshoot-stems/<root>.json …        # or drift / backport --registry …

The registry records the **wired** tree (real `stem` parents, not the ancestry proposal), with each repo's `stemUrl` (null = unwired, a TODO to fix with `discover --add-remotes` or `link`).

Done when you can name the parent of every repo in play (or state it has none), and know which share history with their parent and which are hand-ports.

## 2. Triage: what needs doing

Before deciding anything, get the current state of the tree in one report. Run `status` against the registry (or the folder):

    offshoot-fanout status --registry ~/.offshoot-stems/<root>.json

It reports, per wired root:

- **downstream** — a `fanout --dry-run` of the root: who merges cleanly, who **conflicts** (with the conflicting files), and who is **blocked** behind a conflict. A conflict here is the first thing to resolve (§5) before anything below it can cascade.
- **upstream**, drift: each node's commits not yet in its stem (the parent repo's primary branch, or the sibling branch it derives from). These are **candidate backports** to review in §3.

`status` is read-only (it fetches objects and computes merges in memory with `git merge-tree`, so no branch, index or working tree is touched) and exits non-zero when a downstream conflict/error/dirty tree needs attention. Because a dry-run evaluates each node against its parent's *current* state, a node under one that would merge can read `up to date`; that is expected, and a real run cascades it. Its output is the work list: unwired repos to wire (§1), conflicts to resolve (§5), and drift to triage (§3). If nothing is listed, the tree is in sync — stop.

## 3. Find each change's home

Ask what the change actually depends on, climbing the tree until the answer stops being meaningful:

- nothing beyond the base stack (SvelteKit, service worker, PWA, build config, CI, error/404 handling) → the **base template**
- a layer's distinctive tooling (e.g. Tailwind/plugins/`.prose`; mdsvex/markdown/blog/RSS; wallets/viem/contracts/shadcn) → the **variant that introduces that layer**
- site content, branding, copy, images, deployment identity → stays in the **leaf**

The test: if a sibling would want it, it belongs upstream. If it would be dead code or nonsense in a sibling, it is too specific and stays put.

Split mixed commits. A commit bundling a generic fix with leaf-specific content gets re-authored upstream as only the generic part. Cherry-pick preserves authorship when history is shared and the commit is clean and self-contained; otherwise re-apply by hand with a message explaining the reasoning rather than the diff.

Done when every change in play is assigned to exactly one home, with the reason stated.

## 4. Land it, then cascade

Land the change once, at its home, and let merges carry it. Editing the same logical change in two repos independently guarantees a conflict later.

From the home repo (the landing point), cascade downward with `offshoot-fanout`, which fetches each parent's **local** HEAD so an intermediate merge flows to the leaves in one pass — no push required to cascade (publishing the result is a separate step, see §7):

    offshoot-fanout --dry-run                 # see what merges and where it conflicts
    offshoot-fanout                           # clean tree: merge down to every leaf in one pass

If the dry-run reports a conflict, **don't** run plain `offshoot-fanout` (it aborts on conflict and makes no progress). Instead, leave the merge in progress at the blocking node so you can resolve it:

    offshoot-fanout --leave-conflicts         # merges into the blocking node, leaves the conflict there

Now resolve the conflict in that node (§5), commit to complete the merge, then re-run `offshoot-fanout` from the home repo. The resolved node reports `up to date`, and the change cascades past it to the rest of the subtree.

When the conflicted node's branch was not checked out, the merge is sitting in a **temporary worktree** whose path the report prints. Resolve it there and commit; the branch is the same one, so the result lands correctly. Do not `git checkout` the branch in the main worktree to "fix" it.

A node that fails (conflict/error/dirty) is reported, and its descendants are marked `skipped` — the change never silently reaches them. Resolve the blocker, re-run, and the skipped subtree proceeds. Repos with no shared history are never merged by the tool; if the change is relevant there, hand-port it.

### When the change lives in a descendant (backport up first)

If the change you want to reconcile was made in a descendant but its home is an ancestor (a fix in a site that's really generic), move it **up** before cascading. Find candidates with `drift`, then cherry-pick one onto its home with `backport`:

    offshoot-fanout drift <folder>                                  # list each descendant's commits not yet in its parent
    offshoot-fanout backport <sha> --from <descendant> --to <home> --cascade

`--to` defaults to the descendant's immediate `stem` parent; pass a higher ancestor when the home is further up. `--cascade` runs `fanout` from the home afterward, spreading the now-upstream change back down to every sibling and leaf. The judgement of *which* descendant commit belongs upstream stays with you; `drift` only surfaces the candidates.

Done when every descendant of the landing point has been merged and named, plus any required hand-ports.

## 5. Resolve conflicts by intent

Conflicts are the leaf's specialisation meeting the parent's generic version.

- The descendant's version wins when the hunk is its **specialisation**: theme, content, UI kit, config values.
- The parent's version wins when the hunk is the **generic improvement** being propagated.
- Hunks containing one of each get merged by hand.
- **Lockfiles are never hand-merged**: check out either side, then run `pnpm install` to regenerate.

Read every resolved file afterwards. Taking a whole file with `--ours` or `--theirs` silently drops the other side's real change. `--leave-conflicts` is the mode that lets you do this; plain `fanout` (and `--dry-run`) abort and discard the in-progress merge, so nothing gets resolved.

## 6. Verify, because a clean merge proves nothing

Each repo can declare its own check command once, on its config branch, so nobody has to rediscover it per repo (these repos typically have no root `check` script and need something like `pnpm --filter ./web check`):

```json
{"verify": "pnpm install && pnpm --filter ./web check"}
```

Then run the cascade with verification on, and read the pass/fail reported per node in the same tree output:

    offshoot-fanout --verify

It is opt-in by design: `verify` is a command string read from a git ref, so it never runs unless you ask. A failing verify does not un-merge anything; it tells you which node to go fix. If that node was merged in a temporary worktree, the worktree is kept and its path printed, so reproduce the failure there. Remove it (`git -C <repo> worktree remove --force <path>`) once done, and check `git worktree list` for any you left behind.

For every node touched by the cascade that has no `verify` (or when you need more than it covers), do it by hand:

    pnpm install
    pnpm check                                 # or the repo's svelte-check script
    pnpm build <mode>                          # use a real mode when the repo takes one

Build with a **real mode**. Some of these apps only load their config under a specific mode, so a mode-less build ships an empty config and looks fine. When a node was merged in a temporary worktree, that worktree is gone by the time you read the report: check out or verify the branch itself, do not assume the repo's current checkout reflects the merge.

Establish a **baseline** first when a repo already has failures, so your regressions are distinguishable from what was already broken:

    git stash && pnpm install && pnpm check && git stash pop && pnpm install

Prefer a real browser check over reading the code when behaviour is UI-level and you changed it. This tree has produced bugs that typecheck cleanly and only appear at runtime: a promise that never settled, an error escaping an un-awaited click handler.

Done when each touched node installs, typechecks with zero errors, and builds, and when a repo declares `verify`, that its `--verify` result is green (or its failure is reported).

## 7. Push what you merged, and that means branches, not repos

The cascade works entirely on **local** refs, which is what lets one pass reach the leaves. The flip side is that publishing is a separate step, taken later against an already-merged tree, by which time the cascade output has scrolled away and nothing reminds you what it touched.

Push per **node**, not per repo. `git push origin main` in each repo is the natural habit, and it silently strands every multi-branch node: those merges stay local, `--dry-run` keeps reporting `up to date` (correctly — it compares local refs), and the branches quietly drift from their remotes. Seen in practice: a tree where every node reported up to date while one repo held +21, +21 and +25 unpushed merges on three variant branches.

Enumerate the tracked branches and push the ones that actually carry the work:

```sh
TIP=<the commit you landed at the home>
for br in $(git -C <repo> for-each-ref --format='%(refname:short)' refs/heads/); do
  git -C <repo> rev-parse --abbrev-ref "$br@{upstream}" >/dev/null 2>&1 || continue  # no upstream: skip
  git -C <repo> merge-base --is-ancestor "$TIP" "$br" || continue                    # not from this cascade
  git -C <repo> push origin "$br"
done
```

Both filters earn their place. The upstream check skips local scratch branches that have nowhere to go. The **ancestry** check is what stops you publishing someone's unrelated work-in-progress branch that merely happens to be ahead: a cascade is no reason to push a branch it never touched, and "it was ahead" is not consent.

Every cascade push should be a **fast-forward**. If one is rejected, or a branch reports behind, stop rather than reaching for `--force`: the remote moved while you worked, so the merge you are about to publish was computed against a stale parent and needs redoing.

Done when every node reports `rev-list --count <upstream>..<branch>` as 0, or is a branch you consciously chose not to push and said so in the report.

When you write that check as a loop, resolve the upstream **per branch**:

```sh
up=$(git -C <repo> rev-parse --abbrev-ref "$br@{upstream}") && git -C <repo> rev-list --count "$up..$br"
```

A bare `@{upstream}` inside the loop resolves against the repo's *current* HEAD, not against `$br`, so every branch gets measured from the checked-out branch's remote instead of its own. It reports large fabricated counts for branches that are in fact fully pushed, which reads exactly like the problem this section is about and sends you chasing it twice.

## Dependencies

Before changing any dependency or running an update, watch for two classes of trap that break **silently** rather than loudly:

- **Ceiling deps** — versions deliberately held below latest because a newer major breaks something quietly (e.g. a framework major that collapses inferred load types to `{}`, or a parser freeze that silently disables a plugin). An outdated check will flag them as behind; that is expected, not a task. If a bump is forced, say so in the report rather than doing it.
- **Deployed-artifact source deps** — a dependency that ships source which compiles to a deployed artifact (e.g. Solidity `.sol` that `src/` imports) is pinned exactly: bumping it changes bytecode that must keep matching what is deployed on chain. These look like ordinary toolchain packages in `package.json`; audit which deps ship such source and which `src/` actually imports, rather than assuming. The toolchain around them is free to move. After any contracts-adjacent change, compile with the **production** profile (the deploy scripts use it, and it enables the optimizer, so a default-profile build differs) and compare to the committed deployment — expect the executable code to match byte for byte, differing only in the trailing metadata blob.

Also: where `package.json` has a `packageManager` field, the CI workflow must not also set the setup action's `version:` (both fails with `ERR_PNPM_BAD_PM_VERSION`). A deliberate `split` + `minify` build strategy is sometimes required so a bundle doesn't stall on a throttled connection — don't revert it without reason. And a build **mode** must actually reach the config loader: a script that never receives the mode ships an empty config, so confirm the mode is consumed rather than forwarded to the child command.

## Report

Per node (`repo@branch`): what changed, which home it landed at and why, what was cascaded, how any judgement-call conflict was resolved, the verification output, and whether it was **pushed** (naming any branch deliberately left unpushed, and why). Name the branch, never just the repo: "merged into jolly-roger" is the report that hid a lost update for weeks. Call out what you could not verify, what you deliberately did not bump, and any pre-existing failure found along the way. A merge is not done until the result builds.