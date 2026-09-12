---
'offshoot-fanout': minor
---

`clone` now produces a tree `fanout` can actually run on, by creating a local tracking branch for every branch each repo's own `fanout.config.json` names.

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
- **The exit code follows one rule**: non-zero when what came back is not what was asked for. That now also covers a repo that was *skipped* because its directory was taken, and a search the host itself truncated, both of which lose more than a branch does and both of which used to exit 0 in silence. A missing credential stays zero, because `--require-auth` already exists to make that call.
- **An existing local branch is never moved**, so re-running on a machine with work in progress is safe. The whole verb stays idempotent.
- **The config branch is materialised too**, and is the single exception to "never move a branch": it is fast-forwarded to origin on a re-run, because it holds no work, is never checked out, and a stale copy silently changes which nodes exist at all (a local `offshoot` outranks `origin/offshoot` in `resolveConfig`). Divergence is reported, not resolved. Materialising it at all fixes a worse bug: without a local `offshoot`, `config stem` found no parent ref, committed a *parentless* config commit, announced "created", and printed a push command origin rejects as non-fast-forward.
- **Branches no config names are not created**, including `tooling`. `branches` exists to keep scratch branches out of the cascade without naming them, and `tooling` is a maintainer's local cache of the stem's orphan branch, in no config and unmergeable by construction, so rebuilding it would mean inventing an edge no config states. The help and README say so, with the one-liner (`git fetch stem tooling:tooling`).
- **The `stem` remote is wired but not fetched.** The cascade fetches a cross-repo edge from the parent's sibling clone, not from that remote, so a fetch per repo would buy nothing. Also stated rather than left to be discovered.
