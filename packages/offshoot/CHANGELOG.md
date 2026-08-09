# offshoot

## 0.2.0

### Minor Changes

- 18d0da4: Add `defaults` to `scaffold()`: caller-supplied suggestions for prompts the user is still asked.

  A per-template wrapper often has an opinion about what to suggest (`create-jolly-roger` wants "my-onchain-app"), but that opinion belongs to the wrapper, not to the template. Previously the only way to change a prompt's initial value was an `offshoot.config` in the template repo, which forced a template to reference offshoot just to get a nicer default.

  ```js
  scaffold({
    template: "wighawag/jolly-roger",
    argv: process.argv.slice(2),
    defaults: { name: "my-onchain-app" },
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
