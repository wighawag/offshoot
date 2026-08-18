# offshoot-fanout

## 0.3.1

### Patch Changes

- 1b80efd: **Skill: a push step, because cascading and publishing are not the same act.**

  The `reconcile-template-tree` skill ended at "verify" and never said to push, which left the last step to habit. The habit is `git push origin main` per repo, and that silently strands every multi-branch node: the cascade merges into `(repo, branch)` pairs, so a repo holding variant branches keeps those merges local while `--dry-run` goes on reporting `up to date` — correctly, since it compares local refs. Observed in a real run: every node up to date while one repo held +21, +21 and +25 unpushed merges on three variant branches.

  The new §7 pushes per node, filtered twice: skip branches with no upstream, and skip branches that do not contain the commit landed at the home. The second filter is the important one — a cascade is no reason to publish an unrelated work-in-progress branch that merely happens to be ahead, and "it was ahead" is not consent. It also states that cascade pushes are fast-forwards, and that a rejection means the remote moved and the merge was computed against a stale parent, so it needs redoing rather than `--force`.

  Includes the `@{upstream}` trap found while testing the snippet: inside a loop over branches, a bare `@{upstream}` resolves against the repo's _current_ HEAD rather than the branch being examined, so fully-pushed branches report large fabricated counts — the exact symptom §7 is about, which sends a reader chasing it twice.

  `§4` now says "no push required _to cascade_" and points at §7, and the report asks for push state per node, naming any branch deliberately left unpushed and why.

## 0.3.0

### Minor Changes

- 539a9ca: A branch can now declare **several stems**, so an integration branch that combines independent extensions is expressible: `"extended/complete": {"stem": ["extended/hosted-account", "extended/local-signer"]}`. `stem` still accepts a plain string, so every existing config keeps working.

  The alternative was chaining, which says something different and usually wrong: that one extension is built on the other, so each inherits the previous one's work.

  The node graph becomes a DAG, which changes three things:

  - **Order.** Traversal is now a topological sweep instead of a walk: an integration node is processed only once **every** stem is done, so it can never be merged against one stem's stale state (the failure this project exists to prevent). Anything the sweep cannot reach is a stem cycle, and is now reported as an error rather than silently dropped, which the old visited-set walk did.
  - **Merging.** Stems are merged one at a time, in the order the config lists them, so each gets its own conflict and its own chance at `--leave-conflicts`. If any stem fails, the node is `skipped` rather than merged from the stems that worked. If a _later_ stem conflicts, the earlier merges are already committed and are kept: the message names both what landed and what blocked, and re-running continues from there.
  - **Reporting.** A node with several stems is rendered in full under its first stem and cross-linked under the others (`↳ … also merges from here; shown under …`). It is counted once, in `summarize` and in `status`.

  Drift compares an integration node against **all** of its stems at once (`git log <branch> --not <stem1> <stem2>`), so it is not reported as drifting from what it just merged. `--dry-run` predicts each stem against the branch as it stands, since `git merge-tree` needs a commit and there is no commit for "the branch after stem 1 merged": exact for a single-stem node, approximate for the stems after the first, and the message says so.

## 0.2.0

### Minor Changes

- dd58951: Branch-aware fanout: the unit of work is now a `(repo, branch)` node, not a repo.

  - **The destination branch is controlled and reported.** Every report line is `repo@branch`. A change no longer lands on "whatever the child happened to have checked out" while the report says `merged`. Repos with no config keep today's behaviour exactly: one node at `main`, or the checked-out branch when there is no `main` (the report says which was chosen). `--branch` still works as a global override.
  - **In-repo topology.** A branch can declare another branch of the same repo as its stem, so `shadcn@main` → `jolly-roger@main` → `jolly-roger@variant/full` cascades in one pass, in that order. BFS over nodes gives the ordering; a failed node still marks its descendants `skipped`.
  - **Merging into a branch that is not checked out.** Never `git checkout`. The merge happens in place when the target branch is checked out, otherwise in a temporary linked worktree that is removed afterwards, or kept (with its path reported) when `--leave-conflicts` leaves a conflict in it. A dirty tree now only blocks the branch that is actually checked out.
  - **Config on an orphan branch.** Per-repo config lives on a branch (default `offshoot`) in `fanout.config.json`, read with `git show` (with an `origin/<branch>` fallback) and never checked out, so a template carries no offshoot file in its working tree. `branches` is opt-in and keeps scratch branches out of the cascade without naming them; `verify` is a command run in merged nodes, only ever behind the new `--verify` flag, and a failed one keeps its temporary worktree so the failure can be reproduced. New `offshoot-fanout config show|set`, plus `--config-branch` and `--no-config`. Absent config means the defaults, so a repo that matches them stays free of offshoot references; a branch of that name holding no config file is treated as a name collision rather than an error, since only a config that is present and unparseable should stop a cascade.
  - **Linked worktrees are never repos.** Detected via `--git-dir` vs `--git-common-dir`, always skipped, and mentioned once as a worktree of their repo. This removes the permanent "refusing to merge unrelated histories" false alarm a `git worktree add` sibling produced.
  - **Explicit ignores.** `--ignore <path-or-name>` (repeatable) plus an `ignore` array in the registry, which `discover --save` now preserves and merges into rather than clobbering. Ignored and skipped nodes stay visible in the report.
  - `--dry-run` and `status` are now genuinely read-only: they compute merges in memory with `git merge-tree` instead of merging and aborting. They still report a dirty branch as `dirty`, so a dry-run never promises a merge the real run refuses.

## 0.1.0

### Minor Changes

- b79e9b5: Initial release of `offshoot-fanout`: the maintainer-side companion to `offshoot`. Keep a template tree's `stem` remotes current from changes anywhere in the hierarchy.

  - `status` — one-command triage: for each wired root, downstream `fanout --dry-run` (conflicts + blocked) plus upstream `drift` (candidate backports).
  - `fanout` — propagate a change DOWN to every descendant via real `git merge` against shared history (one pass to the leaves, `--dry-run`, `--leave-conflicts`, conflict-skips-subtree reporting).
  - `drift` — list descendant commits not yet in their parent (candidate backports).
  - `backport` — cherry-pick a descendant commit UP onto an ancestor (its "home"), `--to` defaults to the immediate `stem` parent, `--cascade` then fans out from that ancestor.
  - `discover` — find repos sharing ancestry; `--add-remotes` wires unwired repos; `--save` writes a registry.
  - `link` / `rename-remote` — set/create or bulk-rename the parent remote (e.g. `original` → `stem`).
  - Registry: `discover --save` persists each wired hierarchy to `~/.offshoot-stems/<root>.json`; `fanout`/`drift`/`backport`/`status` accept `--registry <file>` to operate off the saved tree.
  - `skills` — install the bundled `reconcile-template-tree` agent skill into `~/.agents/skills` (`--project` for `./.agents/skills`).

  Targets the shared-history `stem`-remote family; descendants without shared history remain `offshoot`'s job. Zero runtime deps; 21 tests against real temp git repos.
