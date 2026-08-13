# offshoot-fanout

## 0.1.0

### Minor Changes

- b79e9b5: Initial release of `offshoot-fanout`: the maintainer-side companion to `offshoot`. Keep a template tree's `stem` remotes current from changes anywhere in the hierarchy.

  - `status` — one-command triage: for each wired root, downstream `fanout --dry-run` (conflicts + blocked) plus upstream `drift` (candidate backports).
  - `fanout` — propagate a change DOWN to every descendant via real `git merge` against shared history (one pass to the leaves, `--dry-run`, `--leave-conflicts`, conflict-skips-subtree reporting).
  - `drift` — list descendant commits not yet in their parent (candidate backports).
  - `backport` — cherry-pick a descendant commit UP onto an ancestor (its "home"), `--to` defaults to the immediate `stem` parent, `--cascade` then fans out from that ancestor.
  - `discover` — find repos sharing ancestry; `--add-remotes` wires unwired repos; `--save` writes a registry.
  - `link` / `rename-remote` — set/create or bulk-rename the parent remote (e.g. `original` → `stem`).
  - Registry: `discover --save` persists each wired hierarchy to `~/.offshoot-stems/<root>.json`; `fanout`/`drift`/`backport`/`status` accept `--registry <file>` to operate off the saved tree.
  - `skills` — install the bundled `reconcile-template-tree` agent skill into `~/.agents/skills` (`--project` for `./.agents/skills`).

  Targets the shared-history `stem`-remote family; descendants without shared history remain `offshoot`'s job. Zero runtime deps; 21 tests against real temp git repos.
