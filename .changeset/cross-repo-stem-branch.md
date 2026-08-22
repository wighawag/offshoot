---
'offshoot-fanout': minor
---

Let a child repo name which branch of its parent feeds it, with `stemBranch`.

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
