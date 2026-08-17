# offshoot

## 0.3.0

### Minor Changes

- 715f2ab: **`offshoot add [<feature>]`**: adopt an optional feature a template ships as a branch.

  A template that offers optional features publishes them as branches, and publishes the combinations it supports as branches too (`with/all`). Adding one is therefore not a new merge mechanism: it is a switch to the branch carrying _what the project already has, plus that feature_, which is the variant switch `offshoot update --ref` has always done. All `add` does is find that branch.

  ```bash
  offshoot add messaging        # resolves to: offshoot update --ref with/messaging
  offshoot add                  # no argument: list what can be added
  offshoot add sync --dry-run   # resolve the target, change nothing
  ```

  - **The feature sets come from the stem graph, not from branch names.** offshoot reads `fanout.config.json` on the template's config branch (default `offshoot`, `--config-branch` to override), the same graph `offshoot-fanout` already uses, so the maintainer declares it once and the template's working tree still carries no offshoot file.
  - **A branch is adoptable only if it says so**, with a new opt-in `"feature": true` (which `offshoot-fanout` ignores). The graph is the maintainer's _cascade_ graph and most of what is in it is not a feature: a `website` branch, a docs branch, an integration branch that only combines others. A branch carries every declared feature among itself and everything it stems from, so a prerequisite comes along on its own (`add messaging` from `main` also brings `with/local-signer`), an integration branch carries exactly the union of its stems and stays offered as a reachable combination, and the base cannot be marked at all.
  - **No naming convention is baked in.** The argument is matched against the graph: exact branch name first, then a unique _last path segment_, so `messaging` finds `with/messaging` but never `with/foo-messaging`. Ambiguity is an error listing the candidates, never a guess, and `track` always records the full branch name. A template can name its branches anything.
  - **A combination the template does not publish is refused**, naming the branches that do carry it (`with/all (also brings with/hosted-account)`). The target of an `add` is always a real branch someone built and tested, so a project is never handed a combination nobody has ever run; a refusal that keeps coming up is the signal for the template to publish that integration branch.

  Also fixed: `offshoot update --ref <branch>` re-points `track` when the new branch is at the **same commit** as the current one (a renamed branch, or a feature branch that has not diverged yet). It used to report "already up to date" and leave `track` pointing at a branch that may be about to disappear.

## 0.2.0

### Minor Changes

- 18d0da4: Add `defaults` to `scaffold()`: caller-supplied suggestions for prompts the user is still asked.

  A per-template wrapper often has an opinion about what to suggest (`create-jolly-roger` wants "my-onchain-app"), but that opinion belongs to the wrapper, not to the template. Previously the only way to change a prompt's initial value was an `offshoot.config` in the template repo, which forced a template to reference offshoot just to get a nicer default.

  ```js
  scaffold({
  	template: 'wighawag/jolly-roger',
  	argv: process.argv.slice(2),
  	defaults: {name: 'my-onchain-app'},
  });
  ```

  `defaults` only changes what is offered; `answers` still supplies a value and skips the question. A real answer (a positional argument, `--answer`, or an explicit `answers` entry) always wins.

## 0.1.0

### Minor Changes

- 109abc7: First release.

  Scaffold a project from a git template, then pull in template improvements later via real git merges.

  - The transformed template lives on an orphan `template` branch; your work branches off it. An update re-transforms the new template version onto that branch and merges, so git does the merging and your history contains zero commits from the template repo.
  - Three composable transform strategies: `rename` (the default, token replacement across every case variant, in contents _and_ paths), `patterns` (context-anchored pairs), and `template` (opt-in Eta placeholders, scoped to a glob).
  - The template stays a real, working project: no `{{placeholder}}` syntax required, so its own build, type checker and tests keep passing.
  - A round-trip uniqueness gate runs on every scaffold _and_ every update, refusing a name that is not safely replaceable without `--force`.
  - `offshoot doctor` lints a template repository for authors.
  - `offshoot new --eject` (and `offshoot eject`) cut the link entirely, for people who just want the code.
