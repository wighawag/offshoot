# offshoot-fanout

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
