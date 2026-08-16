---
'offshoot-fanout': minor
---

A branch can now declare **several stems**, so an integration branch that combines independent extensions is expressible: `"extended/complete": {"stem": ["extended/hosted-account", "extended/local-signer"]}`. `stem` still accepts a plain string, so every existing config keeps working.

The alternative was chaining, which says something different and usually wrong: that one extension is built on the other, so each inherits the previous one's work.

The node graph becomes a DAG, which changes three things:

- **Order.** Traversal is now a topological sweep instead of a walk: an integration node is processed only once **every** stem is done, so it can never be merged against one stem's stale state (the failure this project exists to prevent). Anything the sweep cannot reach is a stem cycle, and is now reported as an error rather than silently dropped, which the old visited-set walk did.
- **Merging.** Stems are merged one at a time, in the order the config lists them, so each gets its own conflict and its own chance at `--leave-conflicts`. If any stem fails, the node is `skipped` rather than merged from the stems that worked. If a *later* stem conflicts, the earlier merges are already committed and are kept: the message names both what landed and what blocked, and re-running continues from there.
- **Reporting.** A node with several stems is rendered in full under its first stem and cross-linked under the others (`↳ … also merges from here; shown under …`). It is counted once, in `summarize` and in `status`.

Drift compares an integration node against **all** of its stems at once (`git log <branch> --not <stem1> <stem2>`), so it is not reported as drifting from what it just merged. `--dry-run` predicts each stem against the branch as it stands, since `git merge-tree` needs a commit and there is no commit for "the branch after stem 1 merged": exact for a single-stem node, approximate for the stems after the first, and the message says so.
