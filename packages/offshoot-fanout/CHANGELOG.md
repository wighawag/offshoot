# offshoot-fanout

## 0.6.0

### Minor Changes

- de6667a: `clone` now produces a tree `fanout` can actually run on, by creating a local tracking branch for every branch each repo's own `fanout.config.json` names.

  The verb promised "the tree comes back on a machine that has never seen it", and what came back could not run the tool's own primary verb. `git clone` leaves one local branch, so every other node of a repo was a remote-tracking ref the cascade cannot merge into. Measured on the real 11-repo tree, `clone` into an empty directory followed immediately by `offshoot-fanout --dry-run` reported:

  ```
  ✗ template-commit-reveal@with/pixi-js  CONFLICT — conflict in 0 file(s) merging main
  ⊘ template-commit-reveal@with/all      skipped — parent not updated (conflict)
  ⊘ reveal-or-die@main                   skipped — parent not updated (skipped)
  ```

  Nothing was wrong with the tree, and `conflict in 0 file(s)` was a second bug on top of the first (fixed separately). The same clone now reports all 17 nodes up to date with no other setup.

  This is not a new read. `clone` already parses every repo's config off its config branch to discover the tree's edges, and `.branches` is in the object it has just parsed, so the loop every consumer was re-implementing is now done once, where the data already is.

  Decisions worth knowing:

  - **On by default**, with `--no-branches` for a minimal clone. A tree that cannot run `fanout` is broken rather than minimal.
  - **A named branch origin does not have is reported and exits non-zero**, per repo and in a summary. An existing clone is fetched first, so "not on origin" is a fact rather than a claim about a stale ref cache; `--dry-run` does not write, so it labels its answer provisional instead.
  - **The exit code follows one rule**: non-zero when what came back is not what was asked for. That now also covers a repo that was _skipped_ because its directory was taken, and a search the host itself truncated, both of which lose more than a branch does and both of which used to exit 0 in silence. A missing credential stays zero, because `--require-auth` already exists to make that call.
  - **An existing local branch is never moved**, so re-running on a machine with work in progress is safe. The whole verb stays idempotent.
  - **The config branch is materialised too**, and is the single exception to "never move a branch": it is fast-forwarded to origin on a re-run, because it holds no work, is never checked out, and a stale copy silently changes which nodes exist at all (a local `offshoot` outranks `origin/offshoot` in `resolveConfig`). Divergence is reported, not resolved. Materialising it at all fixes a worse bug: without a local `offshoot`, `config stem` found no parent ref, committed a _parentless_ config commit, announced "created", and printed a push command origin rejects as non-fast-forward.
  - **Branches no config names are not created**, including `tooling`. `branches` exists to keep scratch branches out of the cascade without naming them, and `tooling` is a maintainer's local cache of the stem's orphan branch, in no config and unmergeable by construction, so rebuilding it would mean inventing an edge no config states. The help and README say so, with the one-liner (`git fetch stem tooling:tooling`).
  - **The `stem` remote is wired but not fetched.** The cascade fetches a cross-repo edge from the parent's sibling clone, not from that remote, so a fetch per repo would buy nothing. Also stated rather than left to be discovered.

### Patch Changes

- de6667a: `clone` no longer rebuilds the wrong tree, or writes into a repo it was not pointed at.

  Three failure modes found while reviewing the verb as a whole, all of which reported success:

  - **The family was identified from whatever branch happened to be checked out.** The root commit probe was `rev-list --max-parents=0 HEAD`. A maintainer of a tree like this keeps orphan branches (the config branch; a `tooling` branch), and with one of those checked out the probe returns the orphan's root commit, the host search matches only repos carrying that hash, and `clone` reports a one-repo family as if it were the tree. It now probes the default branch (`origin/HEAD`, else `main`), and says which ref it used when the probe fails.
  - **A same-named repo at the root path was probed without question.** `~/dev/template-commit-reveal` belonging to something else was used to identify the family, so the entire reconstruction was of a different tree, reported with full confidence; the only hint was the root's own `skipped, exists with a different origin` line, buried underneath everything it had got wrong. `clone` now refuses up front, naming both origins.
  - **A directory nested inside a checkout was treated as a clone of the enclosing repo.** `--is-inside-work-tree` is true for any directory under a repo, so an empty `template-x/` inside one was read as an existing clone: its enclosing repo's `origin` was inspected and, with no origin to disagree with, a `stem` remote would be wired into the enclosing repo. Path checks now use a new `isRepoRoot`, which compares `rev-parse --show-toplevel` against the path itself.

  Also in `clone`: `owner/..` parses as a repo name and resolved to the parent of `--dir`, now rejected; an existing root clone with no `origin` no longer silently selects https (which defeats the private-member argument that makes ssh the default); and `origin/<branch>` is read as `refs/remotes/origin/<branch>` rather than as a DWIM rev that a legal local branch named `origin/<branch>` would win. A branch name from a third-party config that begins with `-` is rejected rather than passed to argv.

  The per-repo branch lines of the report moved out of the CLI into `formatBranchLines` in `report.ts`, pure and exported. That seam was untested, and a dry run was announcing branches it would create in repos the same report had just said it would leave untouched, which is the "dry run contradicts the real run" failure the branch work exists to remove, reintroduced in the reporter.

- de6667a: A node whose branch does not exist locally is now an error that names the branch, instead of a conflict in zero files.

  `git merge-tree --write-tree` exits 1 for two unrelated things: "merge completed, conflicts present", and "not something we can merge". The dry-run fast path read every exit 1 as the first, so a node at a branch that only exists as a remote-tracking ref reported

  ```
  ✗ template-commit-reveal@with/pixi-js  CONFLICT — conflict in 0 file(s) merging main
  ```

  A zero-file conflict looks enough like a real merge result to send a diagnosis the wrong way, and it did: it was the visible symptom of `clone` not creating the branches its configs name, and it pointed at the merge rather than at the clone.

  Two things were wrong and both are fixed:

  - **The dry run contradicted the real run.** A real run reached `openWorkspace` and said the branch does not exist; only `--dry-run` and `status` claimed a conflict. Since the entire purpose of those two is to predict a real run, the branch check now happens once, before either path, so they cannot disagree. The message says which branch is missing, whether origin has it, and how to create it:

    ```
    ! template-commit-reveal@with/pixi-js error — no local branch `with/pixi-js` (named in
      offshoot:fanout.config.json), though `origin/with/pixi-js` exists. A remote-tracking
      ref cannot be merged into. Create it with `git branch --track with/pixi-js
      origin/with/pixi-js`, or re-run `offshoot-fanout clone`, which materialises every
      branch a config names
    ```

  - **Exit 1 is no longer assumed to mean "conflict".** git prints the merged tree's OID as the first line of stdout for a conflict and nothing at all for a failure, and a real conflict always names at least one file, so the OID is the discriminator, exactly as the success path already required. Anything else falls back to the worktree path, which produces a real error rather than inventing a merge result.

  Also fixed in the test harness: `setRemote` removed and re-added the remote, which deletes its remote-tracking refs, so re-pointing `origin` on a freshly cloned fixture silently discarded every `refs/remotes/origin/*` the clone had just fetched. It now uses `set-url` when the remote exists, which makes cloned fixtures actually resemble a clone.

## 0.5.1

### Patch Changes

- 90bdd7f: Fix three things `clone` got wrong the first time it was pointed at a real tree.

  **It cloned the whole family when asked for a subtree.** Every member shares the root commit, so discovery from any repo sees all of them; classification then marked each annotated repo a member regardless of whether it descended from the REQUESTED root. The printed tree was correctly scoped while the cloning was not, so `clone wighawag/template-svelte-tailwind-blog` drew a three-repo tree and put eleven repos on disk. Cloning is now restricted to repos reachable from the requested root by following `stem` edges, and the family members outside that subtree are listed as such rather than fetched. The walk goes down one generation at a time, so a cycle from a mis-annotated repo terminates instead of spinning.

  **It defaulted to https, which cannot fetch what discovery can see.** Discovery is authenticated and therefore finds private members, but an https clone of a private repo fails asking for a username no non-interactive run can supply: a private member was discovered, listed in the tree, and failed while its ten public siblings succeeded. The default is now ssh, or `gh`'s configured `git_protocol` when it says https, so the credential that can see the tree can also fetch it. `--prefer-https` forces the old behaviour.

  **`config stem` echoed the wrong value.** `--from-remote` reports what it wrote, but printed the raw clone URL it read rather than the canonical id that lands in the file, so the confirmation described something other than the change. It now reports the recorded value, in the message and in the commit subject.

  Also reports the root as `cloned` rather than `existing` when the run itself created it.

## 0.5.0

### Minor Changes

- 74f5217: Publish the parent REPO in `fanout.config.json`, and add `offshoot-fanout clone` to rebuild a whole tree from it.

  A tree's shape lived only in local `stem` remotes, so it died with the machine holding it: a git host cannot be asked "what descends from this repo", and the saved registry is local state that goes stale and does not travel. The new top-level `stem` field names the parent as `provider:owner/name` (the spelling `.offshoot.json` already uses), with `null` declaring a root, so `offshoot-fanout clone <owner/name>` reconstructs everything from one repo name: the family is found by searching the host for repos containing the root commit, and each repo's own `stem` field supplies the edges.

  Direction is stated rather than inferred, because inferring it does not work. Measured against the real ten-repo tree, deducing edges from shared history got three wrong, including a chain inverted end to end when a descendant happened to carry fewer commits than its ancestor; fanning out on that graph would merge a parent's content up from its own grandchild. So `clone` reports an edge it cannot read instead of guessing one, and a repo that shares the root commit but has no `stem` field is discarded as unannotated. That makes the field the opt-in marker for "maintained as part of this tree", which is what keeps old experiments and strangers' copies out.

  The `stem` REMOTE still wins for merging wherever it exists: it is what git actually fetches, and pointing it at a sibling checkout on disk is how a maintainer works on a tree locally, so a published id must never silently retarget a merge. The config is the portable truth and the fallback for a fresh clone. Absence stays valid indefinitely, which is every tree that exists today. Disagreement between the two is reported by `config show` and `clone` rather than silently resolved, and a local-path remote is compared through its own `origin` first, so a local checkout of the right parent is not mistaken for drift.

  `clone` takes a credential from `GITHUB_TOKEN`, then `GH_TOKEN`, then `gh auth token`, so anyone logged into the `gh` CLI gets private members with no setup. That is not a convenience: an unauthenticated commit search cannot see private repos at all and does not say so, which on the tree this was built against means 12 repos found instead of 17. The report names the credential source it used, warns explicitly when it had none, and `--require-auth` makes a missing credential fatal for provisioning scripts, where silently restoring two thirds of a tree is worse than refusing to start.

  `config stem --from-remote` migrates a repo by publishing the edge its `stem` remote already knows, preserving everything else in the config, and `config show` now renders the resolved parent and where it came from (config, remote, both, or a mismatch). The registry keeps its distinct job: filesystem paths and the maintainer-local `ignore` list, neither of which belongs in a published config.

## 0.4.1

### Patch Changes

- 27b333f: Report a deliberately ignored node as `ignored` even when an ancestor failed. An exclusion (registry `ignore` or `--ignore`) was tested after blocking, so a node under a conflicting parent printed `skipped — parent not updated (conflict)`: word for word what a node that IS part of the cascade prints while waiting for the conflict to be fixed. A maintainer reading that would conclude the exclusion was not in force. Exclusion is a property of the node itself, so it is now decided first; `skipped` is said only about a node that would otherwise have been merged. `status` shares the same path and now counts such nodes under `ignored` rather than `blocked`.

## 0.4.0

### Minor Changes

- f6446a6: Let a child repo name which branch of its parent feeds it, with `stemBranch`.

  A cross-repo edge has a branch at both ends. The child already declared which of
  its branches receives an update; it could not say which branch of the parent
  sends it, so every child hung off the parent's primary and a repo built on a
  variant of its parent was wired to the wrong parent by construction.

  ```json
  {"branches": {"main": {"stemBranch": "with/local-signer"}}}
  ```

  Measured on a live tree: a site built on `with/local-signer` and fed from `main`
  reported 14 conflicted files where its real parent gives 4, and the ten extra
  were exactly the files that differ between the two branches. That is worse than
  noise, because the ordinary resolution of those ten silently reverts the site off
  the variant it is built on, in files that still compile, and a large conflict
  count in a repo that is behind reads as ordinary drift.

  `stem` still means a branch in the same repo, and setting both on one branch is
  an error. A `stemBranch` naming a branch the parent does not participate with is
  reported and the node is left out, rather than quietly falling back to the
  primary: a node missing from a report is the failure nobody investigates.

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
