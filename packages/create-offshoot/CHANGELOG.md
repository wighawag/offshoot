# create-offshoot

## 0.1.2

### Patch Changes

- Updated dependencies [715f2ab]
  - offshoot@0.3.0

## 0.1.1

### Patch Changes

- Updated dependencies [18d0da4]
  - offshoot@0.2.0

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

### Patch Changes

- Updated dependencies [109abc7]
  - offshoot@0.1.0
