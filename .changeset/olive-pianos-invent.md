---
'offshoot-fanout': patch
---

A node whose branch does not exist locally is now an error that names the branch, instead of a conflict in zero files.

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
