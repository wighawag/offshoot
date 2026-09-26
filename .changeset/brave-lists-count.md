---
'offshoot-fanout': minor
---

List options take every value, and no argument is ever silently dropped.

`--repos`, `--ignore` and `--to` were parsed as REPEATABLE only (`node:util` `parseArgs` `multiple: true`), so `fanout --repos a b c` kept `a` and turned `b` and `c` into positionals that `fanout` never reads. The cascade ran over one repo and reported a clean, successful run, with no warning.

- A list option now takes every following argument up to the next one starting with `--`: `--repos a b c --verify` is three repos. The repeated form (`--repos a --repos b`) still works and concatenates, in command-line order.
- Every subcommand now rejects a positional it does not read, exiting 2 with a message that names it and suggests the likely intent (`did you mean \`--repos a b c\`?`). Commands that take positionals (`discover [folder]`, `link <parent>`, `backport <commit>`, ...) keep them and reject extras. Unknown options also exit 2 with a short message instead of a stack trace, and a mistyped subcommand (`offshoot-fanout statuss`) is reported as one.
- `--help` marks each list option as taking one or more values, repeatable.

Minor rather than patch, because a command line that was valid before can now mean something different, or be refused:

- A positional placed AFTER a list option is now part of the list. Write `drift <folder> --ignore x`, or `drift --ignore x -- <folder>`. Where that would silently retarget a command, it is refused instead: on `discover`, `drift` and `status`, an `--ignore` value that is an existing directory but not a repo, with no `[folder]` given, is an error suggesting the intended order, rather than a scan of the current directory (for `discover --add-remotes`, that scan would wire remotes across the wrong tree). `link --to c <parent>` now says to put `<parent>` before `--to`.
- `skills` parses its options strictly like every other subcommand, so an option it does not know (e.g. `skills list --no-color`) is now an error instead of being ignored.
