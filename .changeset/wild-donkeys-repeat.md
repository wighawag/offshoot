---
'offshoot': minor
---

**`offshoot add [<feature>]`**: adopt an optional feature a template ships as a branch.

A template that offers optional features publishes them as branches, and publishes the combinations it supports as branches too (`with/all`). Adding one is therefore not a new merge mechanism: it is a switch to the branch carrying *what the project already has, plus that feature*, which is the variant switch `offshoot update --ref` has always done. All `add` does is find that branch.

```bash
offshoot add messaging        # resolves to: offshoot update --ref with/messaging
offshoot add                  # no argument: list what can be added
offshoot add sync --dry-run   # resolve the target, change nothing
```

- **The feature sets come from the stem graph, not from branch names.** offshoot reads `fanout.config.json` on the template's config branch (default `offshoot`, `--config-branch` to override), the same graph `offshoot-fanout` already uses, so the maintainer declares it once and the template's working tree still carries no offshoot file.
- **A branch is adoptable only if it says so**, with a new opt-in `"feature": true` (which `offshoot-fanout` ignores). The graph is the maintainer's *cascade* graph and most of what is in it is not a feature: a `website` branch, a docs branch, an integration branch that only combines others. A branch carries every declared feature among itself and everything it stems from, so a prerequisite comes along on its own (`add messaging` from `main` also brings `with/local-signer`), an integration branch carries exactly the union of its stems and stays offered as a reachable combination, and the base cannot be marked at all.
- **No naming convention is baked in.** The argument is matched against the graph: exact branch name first, then a unique *last path segment*, so `messaging` finds `with/messaging` but never `with/foo-messaging`. Ambiguity is an error listing the candidates, never a guess, and `track` always records the full branch name. A template can name its branches anything.
- **A combination the template does not publish is refused**, naming the branches that do carry it (`with/all (also brings with/hosted-account)`). The target of an `add` is always a real branch someone built and tested, so a project is never handed a combination nobody has ever run; a refusal that keeps coming up is the signal for the template to publish that integration branch.

Also fixed: `offshoot update --ref <branch>` re-points `track` when the new branch is at the **same commit** as the current one (a renamed branch, or a feature branch that has not diverged yet). It used to report "already up to date" and leave `track` pointing at a branch that may be about to disappear.
