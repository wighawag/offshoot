---
'offshoot-fanout': patch
---

**Skill: a push step, because cascading and publishing are not the same act.**

The `reconcile-template-tree` skill ended at "verify" and never said to push, which left the last step to habit. The habit is `git push origin main` per repo, and that silently strands every multi-branch node: the cascade merges into `(repo, branch)` pairs, so a repo holding variant branches keeps those merges local while `--dry-run` goes on reporting `up to date` — correctly, since it compares local refs. Observed in a real run: every node up to date while one repo held +21, +21 and +25 unpushed merges on three variant branches.

The new §7 pushes per node, filtered twice: skip branches with no upstream, and skip branches that do not contain the commit landed at the home. The second filter is the important one — a cascade is no reason to publish an unrelated work-in-progress branch that merely happens to be ahead, and "it was ahead" is not consent. It also states that cascade pushes are fast-forwards, and that a rejection means the remote moved and the merge was computed against a stale parent, so it needs redoing rather than `--force`.

Includes the `@{upstream}` trap found while testing the snippet: inside a loop over branches, a bare `@{upstream}` resolves against the repo's *current* HEAD rather than the branch being examined, so fully-pushed branches report large fabricated counts — the exact symptom §7 is about, which sends a reader chasing it twice.

`§4` now says "no push required *to cascade*" and points at §7, and the report asks for push state per node, naming any branch deliberately left unpushed and why.
