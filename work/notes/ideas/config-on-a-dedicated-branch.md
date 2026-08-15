---
title: Read offshoot.config from a dedicated branch, so a template repo carries no reference to offshoot
type: idea
status: incubating
created: 2026-08-09
updated: 2026-08-15
---

## Shipped in offshoot-fanout; still parked for offshoot (2026-08-15)

`offshoot-fanout` now reads its per-repo config from an orphan branch (default `offshoot`, file `fanout.config.json`, `--config-branch` to override, `--no-config` to disable), written by `offshoot-fanout config set` with pure plumbing. **This does not unpark the idea for `offshoot` itself**, because the hard part below does not exist in fanout:

- **No config-to-content pairing problem.** The whole difficulty here is "which config commit corresponds to content commit X", and it only arises because `offshoot` re-transforms *older* refs (`rename`, `new user/repo#<old-ref>`). `offshoot-fanout` only ever operates on the current local HEADs of repos it merges between; it never re-transforms an older ref. So there is no `configRef` to record, no timestamp correlation, no pin flag, and no `--config-ref` escape hatch. Read the tip, use the tip.
- **The motivation is stronger there, too.** Fanout config is genuinely per-repo (each repo's branch list, each repo's verify command), so an in-tree file at the root template would cascade into all seven descendants and conflict at every level on every change. An orphan branch has no merge base with anything, so it never propagates and never conflicts. For fanout the branch is not purity, it is the only shape that works.

What transfers back if `offshoot` ever builds this: the flat-vs-nested naming constraint (a branch named exactly `offshoot` forbids any `offshoot/*` branch, since a ref file cannot also be a directory, and fanout keeps the flat name while documenting the nested alternative), the `git show <branch>:<file>` read with an `origin/<branch>` fallback for fresh clones, and the plumbing write (`hash-object -w` + `mktree` + `commit-tree` + `update-ref`) that never touches the working tree, the index or the current branch.

Everything below is the original 2026-08-09 note, unchanged, and still describes `offshoot`'s situation.

## The proposal

Let a template put its `offshoot.config.*` on a dedicated orphan branch (default
name `offshoot`, configurable) instead of at the root of its working tree.
offshoot resolves that branch, reads the config from it, and transforms as
usual.

The motivation is the project's own core philosophy taken one step further. We
already insist that **the template is a working project**: no `{{placeholder}}`
litter, because that breaks the template's own build, type checker and tests.
An `offshoot.config.json` sitting in the root is a milder version of the same
smell — a file that has nothing to do with the project, visible to everyone who
clones it, tying a general-purpose template to one particular scaffolder. A
template consumed by offshoot arguably should not have to advertise offshoot.

Owner intent (2026-08-09): "could offshoot support reading a config on the
config/offshoot branch? so the template remain without ref to offshoot?"

## Why this is NOT urgent (current status: deliberately parked)

The two things that pushed jolly-roger toward needing a config both got solved
without one:

1. **The `my-app` collision.** jolly-roger shipped SvelteKit's stock
   `web/README.md`, which contains the literal string `my-app` ("npx sv create
   my-app"), so the uniqueness gate refused the target name `my-app` (13
   replacements forward, 15 reversing). The fix is to delete that file from the
   template — it is `sv create` boilerplate, documents how to create a SvelteKit
   project to someone who just created one, and is referenced nowhere.
   Empirically verified against the real template at `33b7add`:

   | target name | with `web/README.md` | without it |
   | --- | --- | --- |
   | `my-app` | FAIL (13 vs 15) | PASS |
   | `my-onchain-app` | PASS | PASS |

2. **The prompt default.** create-jolly-roger wanted to suggest
   `my-onchain-app` rather than the source token. Solved by adding `defaults`
   to `scaffold()` (offshoot 0.2.0), which puts the opinion in the WRAPPER where
   it belongs, not in the template.

So jolly-roger now needs **no offshoot config at all**, which is the outcome the
branch idea was reaching for. This idea therefore only pays off for a template
that genuinely needs config (`patterns`, custom `prompts`, `skipIfExists`,
`exclude`) *and* wants to stay tool-agnostic.

## The hard part: pairing a config commit to a content commit

Two branches with no shared history. Git has no relation "which commit on branch
B corresponds to commit X on branch A", so the pairing must come from somewhere
outside git. This is the question that has to be answered before building.

Owner's framing (2026-08-09): "what if someone calls update on an older ref, it
would fetch the config/offshoot branch and see it not matching, but can it
actually find the matching one?"

**Answer: it cannot reliably find it — and it does not need to**, because the
state file can record the pairing as it goes.

| operation | how the config ref is obtained | discovery needed? |
| --- | --- | --- |
| `new` (fresh) | config branch tip; record the SHA | no |
| `update` | config branch tip again; record the new SHA | no |
| `rename` | re-transforms at the RECORDED content ref, so use the RECORDED `configRef` | no |
| `new user/repo#<old-ref>` | nothing recorded yet — the only open case | yes |

`rename` is the case that looked dangerous (it re-transforms an old ref, so a
drifting config could make the rename produce output unrelated to the name
change, which would then merge into `main` as spurious diffs). Recording
`configRef` in `.offshoot.json` removes it entirely.

### For the one remaining case, the tip is the RIGHT answer, not a compromise

Counter-intuitive but important: **config is instructions for the tool, not
template content.** If an author adds `exclude: ["web/README.md"]` today because
they discovered a collision, you *want* that applied when someone scaffolds an
old content ref. Date-matching would deliberately hand them the old, known-buggy
config. The config branch is effectively a bug-fix channel, so newest-wins is a
feature rather than a wart.

### Rejected alternatives for discovery

- **Timestamp correlation.** `git rev-list -1 --before=<content commit date>
  <config branch>` (and GitHub's `?until=` on the commits API) does work and is
  roughly git-native. Rejected as a default: committer dates are rewritten by
  rebase/amend, and it silently picks up a config commit that merely happened to
  land just before a content commit. Also it fights the "newest config is most
  correct" argument above. Could be offered as an opt-in flag.
- **Config branch merges the content branch** (not an orphan), so config commits
  have content commits as ancestors and `git merge-base --is-ancestor` answers
  the question exactly. Rejected: the branch then carries the whole tree (a full
  second download instead of a tiny one) and the author must remember to merge
  before every config change.
- **Config declares which content refs it applies from.** Ceremony, and authors
  will get it wrong.

## Sketch of the design, if built

- Branch name defaults to `offshoot`, overridable (note: distinct from the
  existing `branch` option, which names the orphan branch in the GENERATED
  project — needs a clearly different name, e.g. `configBranch`, to avoid a
  confusing collision).
- Expected to be an **orphan** branch containing only `offshoot.config.*`, so
  the extra fetch is tiny. Document that; a non-orphan branch means a full
  second tarball.
- Detection is nearly free: `git ls-remote` already runs to resolve the content
  ref, so the config branch's existence and SHA come from the same call.
- New `configRef` field in `.offshoot.json`, pinned like `ref`. Forward
  compatible: absent means "config came from the tree", which is every project
  created before this exists.
- Precedence when both exist: **in-tree config wins** (it is ref-coupled and
  visible), branch config is the fallback. Alternatively error out; decide
  before building.
- `--config-ref <sha>` escape hatch for pinning an old config deliberately.
- `offshoot doctor` must learn to look on the branch, or it will report a
  template as zero-config when it is not.
- `offshoot check` should probably also report a config-branch change, since it
  can alter the transform without the content ref moving at all.

Estimated a day with tests.

## Costs to weigh before building

- **Discoverability.** A config nobody sees in the repo is easy to forget.
  Someone browsing the repo on GitHub sees no sign the template is
  offshoot-aware — which is the entire point, and simultaneously the risk.
- **A second moving part.** Two refs to resolve, record, advance and reason
  about, in a design whose main selling point is that there is nothing to
  reconstruct.
- **It buys purity, not capability.** Nothing becomes possible that an in-tree
  config cannot already do.

## Trigger to revisit

When a real template needs `patterns`/`prompts`/`skipIfExists` AND its author
objects to an offshoot file in the repo root. Until then the in-tree config
covers every case, and jolly-roger needs no config at all.
