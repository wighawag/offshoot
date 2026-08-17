---
title: Track several template branches at once (layers), instead of switching between published combinations
type: idea
status: parked
created: 2026-08-17
updated: 2026-08-17
---

## The question

A template ships optional features as branches (jolly-roger: `main` → `with/local-signer` → `with/messaging`, `with/sync`, `with/hosted-account`, and integration branches like `with/all`). A project scaffolded from `with/local-signer` wants to add features one at a time and keep getting updates from each of them, independently.

Today, and after `offshoot add` (shipped 2026-08-17), the answer is: **switch to the published branch that carries the combination you want**. This note is about the other answer, the one where a project tracks several template branches at once. It is designed, costed, and deliberately not built.

## Why it is not just a state-file change

One project = one `.offshoot.json` = one `(template, track, ref)` = one orphan `template` branch. The merge works only because `template` and `main` share a root commit. A second, independently orphaned template branch has **no merge base** with `main`, so merging it means `--allow-unrelated-histories` and a conflict in every file. That, not the shape of the state file, is the blocker.

## The design that would work

- **One branch per source**, each holding successive full transformed snapshots of its upstream branch, exactly as `template` does now: `template/local-signer`, `template/messaging`.
- **A new layer branch is rooted at the tip of its stem's layer branch**, never orphaned. The merge base then exists, and the first merge's diff is exactly the feature, because snapshot(`with/messaging`) minus snapshot(`with/local-signer`) *is* messaging.
- **A downstream integration branch.** Keep a single `template` branch that merges the layer branches, and let `main` merge only that. Layer-versus-layer conflicts are then resolved on the template branch, away from the user's code, and `main` keeps its current one-merge UX. The user's repo becomes an integration node, the same DAG one level down from what `offshoot-fanout` does upstream.
- **One state file per layer** (`.offshoot/layers/<name>.json`), never one array in one file: each branch writes only its own file, so branches never fight over it, and a layer file that exists only on `main` is left untouched by a merge (the "you added a file the template does not have" row of the merge table).
- **Removal falls out for free**: commit the stem's snapshot onto the layer branch and merge; the diff deletes the feature.

## Why it is parked

1. **Integration needs testing, and testing needs a place.** If a project runs local-signer + messaging + sync, something must have verified those three merge and build together. Downstream layering means the first user of that combination finds out in their own repo, on top of their own code. Upstream, the combination is a branch, `fanout --verify` checks it, and the conflict is resolved once by the person who understands both features. So any combination worth supporting has to exist as a branch anyway, and a combination nobody is willing to test is one nobody should ship. Downstream layering's unique value is serving *untested* combinations.
2. **Multi-stem made the alternative cheap.** Before `offshoot-fanout` gained several stems per branch (539a9ca), publishing combinations meant chaining (which lies about the dependency) or hand-maintained integration branches. Now it is a config line and a topological sweep. The tool that removes most of the pressure for this feature already shipped.
3. **Composition conflicts would move from the maintainer to every user.** If two features touch the same file, an upstream integration branch resolves it once for everyone; layering makes every user resolve it, and re-resolve as it evolves.
4. **The cost is a multiplier on every existing command**, not one feature. `update` grows a "which layer"; `rename` has to re-transform every layer branch; the drift guard in `assertNoNameDrift` has several answer records to reconcile; `check`, `doctor` and `eject` all fan out; `source.ts` needs a blobless clone, because tarballs cannot answer merge-base questions and layering needs `merge-base(bX, bS)`.
5. **A lag hazard needs a hard invariant.** If a feature branch is behind its stem, its snapshot diff contains *reversions* of newer base content, and merging it silently rolls the project back. A layer would be addable only when its upstream branch contains its stem's tip. `offshoot-fanout`'s `status`/`drift` already computes exactly that, but offshoot would have to check it itself.

The 2^N objection to publishing combinations is real but smaller than it looks: a maintainer publishes only the combinations people ask for, and the same pairwise conflict recurring across integration branches is what `git rerere` is for.

## What was built instead

`offshoot add` (2026-08-17): resolve the target branch from the stem graph and call `update --ref`. No layer branches, no per-layer state, no clone, no new merge machinery. Roughly a tenth of the cost.

The strategic part: **that is the same CLI surface real layering would expose.** If the trigger below ever fires, the implementation behind `offshoot add` changes and no user-facing concept does.

## Trigger to revisit

- The combinations users request exceed what the maintainer will publish and test as branches (somewhere around 6 to 8 integration nodes), **or**
- a template family appears whose layers are genuinely orthogonal (disjoint file sets), and therefore do not need combined testing.

## Decided along the way, and worth keeping

- **Branch names must not encode lineage.** `extended/<stem>/<name>` survives git's ref rules only in its pure form (a flat `extended/local-signer` and a nested `extended/local-signer/*` cannot coexist, the same constraint the fanout config branch documents), but re-parenting a branch would become a rename that invalidates every downstream `track`, multi-stem is unencodable in a path, and the stem would be referenced by leaf, needing a lookup anyway. The lineage is mutable data with an authoritative home already: `fanout.config.json`.
- **A prefix is still worth having**, as a namespace and a filter (`git ls-remote --heads origin 'refs/heads/with/*'`), and for CLI sugar. It is just never what the tool resolves against.
- **`with/` beats `variant/` and `extended/`** for a compositional graph: "variant" implies pick-one, which is exactly wrong when features combine, and "extended" is an adjective that lands on the wrong noun (`extended/messaging` reads as "extended messaging"). `with/all` beats `with/complete`, since "complete" is a judgement on the base; the caveat is that `all` stops being well defined the day two features are mutually exclusive.
