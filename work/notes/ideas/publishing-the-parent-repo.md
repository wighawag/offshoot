---
title: Publish the parent repo in fanout.config.json, so a tree's shape stops living on one laptop
type: decision
status: shipped
created: 2026-09-12
updated: 2026-09-12
---

## What was decided

`fanout.config.json` gained a top-level `stem` naming the PARENT REPO as `provider:owner/name` (`null` = this repo is the root), and `offshoot-fanout clone <owner/name>` rebuilds an entire tree from that field plus a git host. The `stem` git REMOTE keeps precedence for merging. This note records why each of those went the way it did, because two of them are the kind of decision that is expensive to reverse once trees are annotated.

## The problem, from a real incident

Ten repos across `template-svelte -> template-svelte-tailwind -> {template-svelte-shadcn -> jolly-roger, template-svelte-tailwind-blog}`, with `jolly-roger -> {template-commit-reveal -> reveal-or-die, bleeps, mandalas}`. Every edge existed only as a local git remote named `stem`. The laptop holding them was about to be wiped, and a git host cannot be asked "what descends from this repo". The registry at `~/.offshoot-stems/<root>.json` is not an answer: it stores absolute local paths, it goes stale through ordinary use, and it dies with the same machine.

## Why not just ask the host (the option that nearly won)

The obvious cheaper idea: skip the field entirely, since every descendant carries the family's root commit, and GitHub can search for it. That half works, and it works better than expected. One unauthenticated `hash:e47ad6b7ce` search returned twelve repos, including two under owners nobody remembered and one the maintainer had forgotten he owned. Commit search only indexes default branches, but that is not a problem for this probe: the root commit reaches `main` in every member, which is precisely what a later-branch commit would not do.

So MEMBERSHIP is free from the host, and the field is not needed for it.

DIRECTION is where it collapses, and the measurement is worth keeping. Running the existing `discoverAncestry` heuristic (order by commit count, attach each repo to the placed repo it shares most commits with) against the ground truth in the `stem` remotes:

| repo | inferred parent | actual parent |
|---|---|---|
| `reveal-or-die` | `template-svelte-shadcn` | `template-commit-reveal` |
| `jolly-roger` | `reveal-or-die` | `template-svelte-shadcn` |
| `mandalas` | `bleeps` | `jolly-roger` |

Seven of ten right, three wrong. `jolly-roger` landing under `reveal-or-die` inverts a three-repo chain end to end, because the descendant happens to have fewer commits than its ancestor, and "fewest commits is most ancestral" is the only ordering signal available. Fanning out on that graph merges a parent's content upward from its own grandchild. `mandalas` under `bleeps` is the sibling-versus-child case, which is not a weakness of this particular heuristic but genuinely undecidable from commit sets: two repos cloned from the same parent at the same commit have identical evidence.

The code already said so (`discoverAncestry`: direction "cannot be determined from history alone once both sides diverged past the fork", output is a PROPOSAL). The measurement just puts a number on it. Hence: membership from the host, direction from a stated field, and nothing inferred in `clone`.

## The precedence decision, which is the one that would hurt to change later

**The `stem` remote wins whenever it exists. The config is the fallback and the portable truth.**

The remote is what git actually fetches, and pointing `stem` at a sibling checkout on disk is not an edge case here, it is how the tree is worked on: `link` accepts a local path for exactly that reason. If a published id could override that, then annotating a tree would silently retarget merges away from the checkouts a maintainer deliberately wired, and the failure would be invisible until content arrived from the wrong place. The config's job is to make a FRESH machine reconstructible, and on a fresh machine there is no remote to lose to.

Absence of the field must stay valid indefinitely, since every tree that exists today has none. That falls out for free: `validate()` copies only known keys, so an older binary ignores the field rather than choking, and `writeConfig` hashes the file bytes rather than a re-serialization, so an older `config set` will not strip it either. Annotation can start before every machine is upgraded.

Disagreement is reported, never silently resolved, and never fatal by default. The subtlety that makes this usable: a `stem` remote pointing at `/home/me/dev/template-svelte` would "disagree" with `github:me/template-svelte` on every single run, so a local-path remote is resolved through its own `origin` before comparison. A warning that fires constantly on a correct setup is a warning everyone learns to ignore, which is worse than not having one.

## Three states, not two

`absent` (nobody said), `"owner/name"` (parent stated), `null` (stated to BE the root). Collapsing the last two would have been tempting and wrong: absence has to keep meaning "legacy, unannotated" forever, so it cannot also mean "root", or reconstruction has a permanent hole at the one node that defines the tree.

## The unplanned second use: the field as a membership marker

Once every real member is annotated, a repo that shares the root commit but has no `stem` field is not a member. `clone` discards it and says why. That turns out to matter more than expected on a real tree: the twelve search hits include a bug reproduction, a stranger's copy, and a repo that has not been maintained in years. Before the field there was no principled way to tell those from a genuine descendant, only a hand-maintained `ignore` list. Opting in beats opting out here, because a forgotten exclusion silently adopts a repo, whereas a forgotten annotation just leaves it out and prints the reason.

## Authentication turned out to be part of the design, not a deployment detail

Discovery was built against public search, which found twelve repos and looked right. With a credential the same search returns SEVENTEEN: five private repos, one of which (`conquest-website-2`) is a genuine member listed in the hand-written manifest this work replaces. The failure mode is the bad kind: an unauthenticated search does not report that private repos were excluded, it just returns fewer results, and a partial tree is indistinguishable from a complete one.

So the credential is resolved up front from `GITHUB_TOKEN`, then `GH_TOKEN`, then `gh auth token`. Reading `gh` matters: it is the credential the user already has, so the correct behaviour is the default one, with nothing to configure. The report always names the source it used, and `--require-auth` makes a missing credential fatal, which is what a provisioning script wants: a machine that silently restores two thirds of a tree is worse than one that refuses to start.

A useful accident of the same run: the private repos split cleanly into two groups. `conquest-website-2` has an `offshoot` config branch and only lacks the new field, while `bomber-world`, `conquest-v1`, `pollen-map` and `conquest-eth-explorations` have no config branch at all. The first is a member awaiting annotation; the rest are old repos that merely share history. That distinction was invisible before, and it is exactly the one the opt-in marker is for.

## What this costs

`config.ts` advertises that a repo matching the defaults "stays completely free of offshoot references". A discoverable tree requires every member to carry an `offshoot` branch, so that property is retired for annotated trees. It is a real cost and worth naming: the mitigation is only that the branch is orphan, so the working tree stays as clean as before, and the price is one extra ref on the host.

## What did NOT change

The registry keeps a distinct job rather than becoming redundant: filesystem paths ("where is each of these checked out on THIS machine") and the maintainer-local `ignore` list, which `core.ts` already documents as local state that must not live on a config branch. Only topology moved out of it.
