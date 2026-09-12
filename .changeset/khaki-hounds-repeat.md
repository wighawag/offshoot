---
'offshoot-fanout': patch
---

`clone` no longer rebuilds the wrong tree, or writes into a repo it was not pointed at.

Three failure modes found while reviewing the verb as a whole, all of which reported success:

- **The family was identified from whatever branch happened to be checked out.** The root commit probe was `rev-list --max-parents=0 HEAD`. A maintainer of a tree like this keeps orphan branches (the config branch; a `tooling` branch), and with one of those checked out the probe returns the orphan's root commit, the host search matches only repos carrying that hash, and `clone` reports a one-repo family as if it were the tree. It now probes the default branch (`origin/HEAD`, else `main`), and says which ref it used when the probe fails.
- **A same-named repo at the root path was probed without question.** `~/dev/template-commit-reveal` belonging to something else was used to identify the family, so the entire reconstruction was of a different tree, reported with full confidence; the only hint was the root's own `skipped, exists with a different origin` line, buried underneath everything it had got wrong. `clone` now refuses up front, naming both origins.
- **A directory nested inside a checkout was treated as a clone of the enclosing repo.** `--is-inside-work-tree` is true for any directory under a repo, so an empty `template-x/` inside one was read as an existing clone: its enclosing repo's `origin` was inspected and, with no origin to disagree with, a `stem` remote would be wired into the enclosing repo. Path checks now use a new `isRepoRoot`, which compares `rev-parse --show-toplevel` against the path itself.

Also in `clone`: `owner/..` parses as a repo name and resolved to the parent of `--dir`, now rejected; an existing root clone with no `origin` no longer silently selects https (which defeats the private-member argument that makes ssh the default); and `origin/<branch>` is read as `refs/remotes/origin/<branch>` rather than as a DWIM rev that a legal local branch named `origin/<branch>` would win. A branch name from a third-party config that begins with `-` is rejected rather than passed to argv.

The per-repo branch lines of the report moved out of the CLI into `formatBranchLines` in `report.ts`, pure and exported. That seam was untested, and a dry run was announcing branches it would create in repos the same report had just said it would leave untouched, which is the "dry run contradicts the real run" failure the branch work exists to remove, reintroduced in the reporter.
