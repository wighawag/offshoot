# offshoot

Scaffold a project from a git template, then pull in template improvements later via **real git merges**.

```bash
npm create offshoot@latest wighawag/jolly-roger my-app
cd my-app
# ... months later ...
npx offshoot update
```

Node 20+, ESM, TypeScript, MIT. Requires the `git` binary; no Python, ever.

## Why this exists

You maintain a template. Someone scaffolds from it. Months later you fix a bug in the template, and they want the fix. The existing answers are Python: [copier](https://copier.readthedocs.io/) needs Python 3.10+, and [cruft](https://github.com/cruft/cruft) has had no commits since 2024-12-25. If your users have Node and npm, that is a hard sell.

offshoot is the Node answer, and it makes one further bet the Python tools do not.

## Core philosophy: the template is a working project

This is the constraint everything else follows from, and it rules out the usual approach.

A template should be a **real, runnable, testable project**. `wighawag/jolly-roger` builds, type-checks and passes its own tests. That is only possible if the template is not littered with `{{placeholder}}` syntax, because placeholders break the build, the type checker and the tests **in the template repo itself**.

So personalization happens by **replacement of a real token**, not by expansion of placeholders:

```jsonc
// in the template - valid, working, testable
{"name": "jolly-roger"}

// not this
{"name": "{{ project_name }}"}
```

Placeholder templating is still supported, for authors who want it. It is one strategy among several, never the default and never assumed.

## The architecture: an orphan `template` branch is the merge engine

There is no merge algorithm in offshoot. Git does the merging.

**Scaffold** puts the transformed template on an orphan branch, then branches your work off it:

```
git init -b template
(transform template@R with your answers into the directory)
git add -A && git commit -m "template: <template>@<ref>"
git checkout -b main
```

**Update** re-transforms the new template version onto that same branch, then merges:

```
git checkout template
(delete all tracked files, transform template@newref with the saved answers)
git add -A && git commit -m "template: <template>@<newref>"
git checkout main
git merge template
```

### Branch topology

```
                 transformed template@R          transformed template@R2
                          │                               │
template  ●───────────────●───────────────────────────────●
          │            (scaffold)                         │
          │                                               │  git merge
          └──●────●────●────●────●────●────●────●────●────●──▶  main
             │    │    │    │                              │
             └────┴────┴────┴── your commits ──────────────┘

   ▲                                                       ▲
   │                                                       │
 both branches share a root commit,                 the merge base is the
 so git has a merge base                            previous template commit
```

The template branch holds nothing but successive **transformed snapshots** of the template. Your branch holds your work. Because they share a root, `git merge` has a proper merge base and behaves exactly as it does for any other branch:

| Situation | Result |
| --- | --- |
| Template changed a file, you did not | auto-merged |
| Template added a file | added |
| You added a file the template does not have | untouched |
| Both edited **different lines** of a file | auto-merged |
| Both edited **the same lines** | conflict, in that file only |
| You do not like the result | `git merge --abort` |

Your history contains **zero commits from the template repository**. No remote is added, nothing is fetched into your object store; the template is downloaded as a tarball and re-committed by you. `git log` stays yours.

Every row of that table is an integration test in `packages/offshoot/test/merge-model.test.ts`, run against real git repositories in temp directories.

### The advantage over copier

copier must **regenerate your project from the OLD template version** to compute a diff against the new one. That is why it needs a documented "recover from a broken update" escape hatch: the regeneration can fail, or drift from what you actually got.

offshoot never re-transforms an old ref. **The previous transformed snapshot is already the previous commit on the template branch.** There is nothing to reconstruct, so there is nothing to recover from.

| | copier | offshoot |
| --- | --- | --- |
| Runtime | Python 3.10+ | Node 20+ |
| Template must be | annotated with `{{ }}` | a working project (or annotated, your choice) |
| Update mechanism | regenerate old version, diff, apply | `git merge` |
| Old version needed at update time | yes, re-rendered | no, it is a commit |
| Conflict UI | `.rej` files (or git merge) | your normal git conflict workflow |
| Recovery hatch needed | yes | no |
| Commits from the template in your log | no | no |

## Install

```bash
# scaffold, no install needed
npm create offshoot@latest wighawag/jolly-roger my-app

# or install the CLI
npm i -g offshoot
offshoot new wighawag/jolly-roger my-app
```

`npm create` forwards positional arguments directly, but **flags need a separator**:

```bash
npm create offshoot@latest wighawag/jolly-roger my-app -- --ref v2
```

which is why offshoot prefers positional arguments and interactive prompts. Note also that a globally installed `create-*` package shadows the registry version, so READMEs should always say `@latest`.

## Commands

| Command | What it does |
| --- | --- |
| `offshoot new <template> [dir]` | Scaffold. Accepts `user/repo`, `github:user/repo`, `user/repo#ref`, a local path. Add `--eject` for no template link at all. |
| `offshoot update [--ref <ref>]` | Pull template improvements. Refuses a dirty tree; prints the `git merge --abort` hatch on conflict. |
| `offshoot check` | Is a newer ref available? Non-zero exit for CI. |
| `offshoot rename <newName>` | Rename the project on both branches (see below). |
| `offshoot doctor` | Template-author lint, run inside the template repo. |
| `offshoot eject` | Cut the link permanently: delete the template branch and `.offshoot.json`, and strip the integration. |

One name per command. There is no `graft` alias.

## Opting out: just give me the code

Not everyone wants the machinery. Plenty of people want to start from a template once and never hear from it again, and a fresh repository with a second branch and a state file in it is clutter they did not ask for.

```bash
offshoot new wighawag/jolly-roger my-app --eject

# npm forwards positionals directly but needs a separator for flags,
# so through `npm create` it is either of these:
npm create offshoot@latest wighawag/jolly-roger my-app -- --eject
npm create offshoot@latest wighawag/jolly-roger my-app eject=true
```

You get the transformed project and nothing else:

- **no template branch** - a plain `git init` on your default branch, one commit
- **no `.offshoot.json`**
- **no dependency on offshoot** - it is removed from every `package.json` in the tree, along with any script that invokes it
- **no integration files** - whatever the template declares as update-only

```
$ git log --oneline && git branch --list
6889f1d Initial commit from github:wighawag/jolly-roger@33b7add
* main
```

Provenance survives in the commit message, for humans. Nothing links the project to the template mechanically, so `offshoot update` will not work there - which is the entire point. It says so, rather than failing obscurely.

`offshoot eject` is the same idea after the fact: `--eject` is "never link", the command is "stop being linked". Both do exactly the same stripping, so the flag and the command cannot drift into meaning different things.

### What counts as "the integration"

Two levels, with a deliberate boundary at what can be known rather than guessed.

**Automatic**, needing no config, because these things *are* the integration by definition:

- a dependency or devDependency named exactly `offshoot`
- a script that **invokes** offshoot: `offshoot update`, `npx offshoot check`, `pnpm build && offshoot check`

That detection is anchored to command position, so a script that merely mentions the word (`echo see offshoot docs`) or runs a different binary (`offshoot-deploy run`) is left alone.

**Declared**, for everything else. A file named `UPDATING.md` is not detectable as update-only, so removing it stays explicit:

```jsonc
// offshoot.config.json
{
  "eject": {
    "exclude": ["UPDATING.md", ".github/workflows/template-update.yml"],
    "packageJson": {
      "devDependencies": ["some-update-helper"],
      "scripts": ["check:template"]
    }
  }
}
```

`package.json` files are edited **structurally**, preserving each file's own indentation and trailing newline, and a file with nothing to strip is left byte-identical. A dependency section that ends up empty is dropped rather than left as `{}`. Custom transforms can read `ctx.eject` and react too.

Everything else is unchanged: the same transforms run, the same uniqueness gate applies. `--eject` removes the *link*, not the personalization.

### Should the template depend on offshoot?

It does not have to. `npx offshoot update` works without the project depending on anything: offshoot operates on the git repository, not on your `node_modules`.

But if you want `pnpm update-template` ergonomics, **declare it in the template**:

```jsonc
// in the TEMPLATE's package.json
{
  "scripts": {"update-template": "offshoot update"},
  "devDependencies": {"offshoot": "^0.1.0"}
}
```

Declaring it in the template is the only sane place. offshoot deliberately **injects nothing** into your `package.json`: an injected devDependency would exist on `main` but not on the template branch, so every single update would conflict on that line, forever. Anything the template declares is on both branches and merges cleanly, including a later version bump of offshoot itself.

### The lockfile

Removing a devDependency leaves the lockfile still pinning it. A plain `install` self-heals, but `pnpm install --frozen-lockfile` and `npm ci` - the CI defaults - fail outright, which would hand every ejected project a broken first CI run.

So when `--eject` (or `offshoot eject`) removes a dependency, offshoot detects the package manager (`packageManager` field first, then whichever lockfile is present) and refreshes the lockfile **before committing**, so the very first commit is self-consistent:

```
$ offshoot new wighawag/jolly-roger plain-app --eject
  updated pnpm-lock.yaml (removed offshoot)
```

This is strictly best effort, since offshoot is otherwise a files-and-git tool: no package manager installed, no network, or a `yarn` too old for `--mode update-lockfile`, and it degrades to a precise warning rather than failing the scaffold.

```
  pnpm-lock.yaml still references offshoot (pnpm not found).
  Run `pnpm install` to bring it back in line; `pnpm install --frozen-lockfile` will fail until you do.
```

It does nothing at all when nothing was removed, which is the common case.

## The transform layer

Everything is a function over an in-memory file tree, applied **before** anything is written to disk, so paths and contents are transformed together:

```ts
interface Transform {
  name: string;
  apply(files: VirtualFile[], answers: Answers, ctx: Ctx): VirtualFile[];
}

interface VirtualFile {
  path: string;       // relative, POSIX
  content: Buffer;    // raw bytes
  executable: boolean;
  binary: boolean;
  skip: boolean;
}
```

Transforms are ordered and composable. Three ship built in.

### 1. `rename` (the default)

Replaces a source token with the target name across **all case variants**, in file contents **and** in file and directory names. This is the logic of [`change-name`](https://github.com/wighawag/change-name), ported.

For `jolly-roger` -> `my-app`:

| variant | from | to |
| --- | --- | --- |
| paramCase | `jolly-roger` | `my-app` |
| camelCase | `jollyRoger` | `myApp` |
| pascalCase | `JollyRoger` | `MyApp` |
| constantCase | `JOLLY_ROGER` | `MY_APP` |
| capitalCase | `Jolly Roger` | `My App` |
| noCase | `jolly roger` | `my app` |
| snakeCase | `jolly_roger` | `my_app` |
| headerCase | `Jolly-Roger` | `My-App` |
| pathCase | `jolly/roger` | `my/app` |
| dotCase | `jolly.roger` | `my.app` |
| sentenceCase | `Jolly roger` | `My app` |

`change-name` pins `change-case@4`; offshoot uses v5 and maps the two renamed exports (`paramCase` -> `kebabCase`, `headerCase` -> `trainCase`) so behaviour is identical. A test asserts that against a real `change-case@4`.

### 2. `patterns`

An ordered list of explicit, **context-anchored** `[from, to]` pairs, which is `create-jolly-roger`'s `buildReplacements()` approach:

```ts
{type: "patterns", patterns: [
  {from: '"jolly-roger"', to: '"my-app"'},          // a package.json name, and nothing else
  {from: "Jolly Roger", to: (answers) => answers.title},
]}
```

The precision escape hatch for templates where blind token replacement is unsafe. `to` may be a function of the answers.

### 3. `template`

Placeholder expansion with [Eta](https://eta.js.org) v4. **Opt-in only**, and restricted to an explicit glob list, so a template can use placeholders in a handful of files while the rest of the project stays a working, unmarked codebase:

```ts
{type: "template", include: ["src/generated/**", "README.md"]}
```

Strategies compose: `patterns` then `rename`, or `rename` then `template`, whatever the template needs.

### Custom transforms

A template can register its own, so authors are not limited to the three built-ins:

```js
// offshoot.config.mjs
export default {
  transforms: [
    {type: "rename"},
    {name: "banner", apply: (files, answers) => files.map(/* ... */)},
  ],
};
```

## Delimiters: a deliberate asymmetry

Eta defaults to `<% %>`; offshoot overrides it to `{{ }}`.

- **File CONTENT delimiters are configurable**, via `contentTags`, defaulting to `["{{", "}}"]`. The escape hatch matters because `{{ }}` is Vue's interpolation syntax, so a Vue template would collide.
- **File and folder NAME interpolation is fixed at `{{ }}` and is NOT configurable.**

That asymmetry is a **safety property, not an oversight**. `<` and `>` are reserved characters in Windows filenames. If path delimiters were configurable, an author could set them to `<% %>` and produce a template repository that **cannot be checked out on Windows at all**. The config field is named `contentTags` precisely so its scope is unambiguous.

Two further rules for paths:

- Path interpolation supports **simple variable substitution only, never logic**. A filename never needs a loop.
- Path interpolation is **always active**, independent of the `template` strategy opt-in, because a path containing `{{` is unambiguous intent. `pathInterpolationExclude` covers the pathological case of a file that legitimately contains `{{` in its name.

So this works, and is tested:

```jsonc
// offshoot.config.json
{"contentTags": ["<%", "%>"]}
```
```
src/{{name}}.ts     ← always {{ }}
  content: <%= name %>   ← configured tags
```

One convenience: Eta outputs with `<%= %>`, so a bare `{{ name }}` would be an expression *statement* that silently renders nothing. offshoot promotes a tag whose entire body is a plain reference to an output tag, so `{{ name }}`, `{{= name }}` and `{{ it.name }}` all do the obvious thing, while `{{ if (x) { }}` still executes.

## The uniqueness gate

The known hazard with token replacement is a source token that also appears where it does **not** mean the project name, or a target name that collides with words already in the template.

`change-name` already had the detection: count the replacements for `from -> to`, then count the reverse `to -> from`, and a mismatch proves the transform is not round-trippable. offshoot promotes it to a first-class gate:

- It runs on **every transform**: at scaffold, and at **every update**. A new template ref can introduce occurrences that collide with a name chosen months earlier, and silently corrupting an update is the worst possible failure mode.
- On mismatch it **fails loudly**, with the file list and the offending occurrences, and requires explicit `--force`.

```
Uniqueness check failed for "jolly-roger" -> "my-app".
  13 replacement(s) applied, 15 found when reversing.
  "my-app" already occurs in the template where it does not mean the project, [...]

Files where the counts disagree:
  web/README.md

Offending occurrences:
  web/README.md:13: # create a new project in my-app
  web/README.md:14: npx sv create my-app

Pick a different name, add a `patterns` transform for the ambiguous spots,
or re-run with --force to accept the risk.
```

That is a real, unedited finding against the real `wighawag/jolly-roger`: it ships SvelteKit's stock `web/README.md`, which contains the literal string `my-app`.

### `offshoot doctor`, for template authors

Run inside the template repo, ideally in CI. It reports every occurrence of the source token, flags occurrences that look like ordinary words rather than project references (nothing quote-like, path-like or identifier-like adjacent to them), warns when the token is too short or too generic to replace safely, and runs the round-trip gate:

```bash
offshoot doctor                      # inventory + probe
offshoot doctor --name my-app        # would this user-chosen name be safe?
offshoot doctor --strict             # warnings are failures too
```

This turns "authors must pick a unique enough name" from folklore into a check.

### `doctor` is the only command that runs in a template

A template repository has **no `.offshoot.json`**, and must not have one: that file is created in the projects people scaffold *from* the template. `offshoot.config.*` is likewise never copied into generated output.

So the project commands refuse when run in a template, and say why rather than leaving you guessing:

```
$ offshoot update            # inside wighawag/jolly-roger itself
error: /path/to/jolly-roger looks like a TEMPLATE repository (it has offshoot.config.json),
not a project generated from one.
There is no .offshoot.json here, and there should not be: it is created in the projects
people scaffold FROM this template.
Template authors want `offshoot doctor`, which lints this repository.
```

They exit non-zero, so a misconfigured CI step fails rather than passing quietly. A zero-config template has no `offshoot.config` to detect, so there the message stays generic instead of guessing.

### A template that is itself an offshoot project

This works, and is worth knowing because it is easy to end up there: scaffold a project, then turn it into a template of your own. That repository legitimately has both an `.offshoot.json` (its own link upstream) and the role of a template.

Its state file is **never handed down**. Projects generated from it get their own `.offshoot.json`, pointing at *it*, and keep updating from it normally - your upstream link is yours, and your users' link is theirs.

## Binary handling

`create-jolly-roger` guarded binary files with:

```js
try { const content = readFileSync(path, "utf-8"); /* ... */ } catch { /* binary, skip */ }
```

That guard is **dead code**. Reading binary as utf-8 does not throw, it substitutes U+FFFD, and writing it back corrupts the file whenever a replacement matches. A 27-byte binary containing the token came back as 34 bytes.

offshoot uses real detection, ported from `change-name/is-text-or-binary`: extension lists plus a null-byte and invalid-sequence sniff. Binary files pass through **byte-identical**, but their **paths are still renamed**, and executable bits survive. All of that is asserted, including a regression test that reproduces the old corruption.

## Skip lists

Defaults, overridable per template:

- **directories**: `node_modules`, `.git`, `.svelte-kit`, `dist`, `artifacts`, `cache`, `generated`, `deployments`
- **files**: `pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`, `pnpm-workspace.yaml`

Skipped files are still **committed** to the template branch, just untransformed.

## Configuration

Optional `offshoot.config.{json,js,mjs,ts}` at the template root. **Zero-config must work**, and does: with no config file, the source token is inferred from the template repo name (`wighawag/jolly-roger` -> `jolly-roger`), the `rename` strategy runs, the target name is prompted for, and the default skip lists apply.

```ts
// offshoot.config.ts
import {defineConfig} from "offshoot";

export default defineConfig({
  sourceName: "jolly-roger",     // inferred from the repo name if omitted
  branch: "template",            // the orphan branch name
  transforms: [{type: "rename"}],
  prompts: [
    {name: "name", type: "text", message: "Project name:", validate: "^[a-z0-9]+(-[a-z0-9]+)*$"},
  ],
  contentTags: ["{{", "}}"],     // FILE CONTENTS ONLY; paths are always {{ }}
  skipDirs: ["node_modules", "dist"],
  skipFiles: ["pnpm-lock.yaml"],
  skipIfExists: [".env.example"],   // seeded once, never updated
  exclude: [".github/workflows/template-ci.yml"],  // never reaches the project
  pathInterpolationExclude: [],

  // Stripped only when a user scaffolds with `--eject`. offshoot removes its
  // own traces automatically; this is for the rest.
  eject: {
    exclude: ["UPDATING.md"],
    packageJson: {devDependencies: ["some-update-helper"], scripts: ["check:template"]},
  },
});
```

The config is read **from the fetched ref on every operation**, so authors can evolve it and existing projects pick up the new version on their next update.

## State file

A single `.offshoot.json` at the project root:

```json
{
  "template": "github:wighawag/jolly-roger",
  "ref": "a1b2c3d...",
  "track": "main",
  "sourceName": "jolly-roger",
  "answers": {"name": "my-app"},
  "version": 1
}
```

It lives **in the transformed output**, so it sits on the template branch and its `ref` updates automatically through the merge.

Deliberately **not** a key in `package.json`: the ref changes on every update, package managers rewrite `package.json` formatting on install, and a dedicated file the user never edits is guaranteed to merge cleanly.

`ref` is always a **concrete commit SHA**, never a floating branch name (`track` records the branch being followed, for `offshoot check`). Today's `create-jolly-roger` pins `#main` and records nothing, which makes updates impossible; that is exactly what this fixes.

### Template variants (tracking a branch other than the default)

`ref` and `track` are two different ideas on purpose: `ref` is the immutable commit you were last transformed from, `track` is the floating ref you follow to find the next one. So a template that ships variant branches just works:

```bash
offshoot new wighawag/jolly-roger#variant/full my-app
```

```json
{"template": "github:wighawag/jolly-roger", "ref": "12e8df3...", "track": "variant/full"}
```

From then on, plain `offshoot update` and `offshoot check` follow **`variant/full`**. Commits landing on `main` are ignored. Branch names containing a slash are handled.

You can also switch variants deliberately, which permanently changes what you follow:

```bash
offshoot update --ref variant/offline    # switch, and track variant/offline from now on
```

Because the switch is just another snapshot on the template branch, git merges it like anything else: you get the variant's files, your own work is untouched, and you only get conflicts where you had edited the same lines the variant changes.

One exception, so a one-off pin does not silently re-point you: updating to an **exact commit SHA** leaves `track` alone.

```bash
offshoot update --ref 12e8df3    # moves `ref`, keeps following `variant/full`
```

All of the above is covered in `test/tracking.test.ts`.

## The rename hazard

If you rename your project on `main` after scaffolding, the template branch still holds the old name, and the next update would try to merge the old name back in, conflicting in **every file**.

offshoot owns this:

```bash
offshoot rename my-better-name
```

which re-transforms the template branch at the **current** ref with the new name, commits, and merges into your branch. `offshoot update` detects the drift beforehand and refuses, pointing here.

Drift is detected two ways: the answers recorded on the template branch disagreeing with yours, or the recorded name having vanished from your branch while it is still present on the template branch.

## Library API

```ts
import {scaffold, update, defineConfig} from "offshoot";

await scaffold({template: "wighawag/jolly-roger", argv: process.argv.slice(2)});
await update({cwd: process.cwd()});
```

Which is all a per-template wrapper needs to be. `create-jolly-roger` becomes:

```js
#!/usr/bin/env node
import {scaffold} from "offshoot";
scaffold({template: "wighawag/jolly-roger", argv: process.argv.slice(2)});
```

Per-template wrappers stay owned by the template author, and a project scaffolded through one updates with plain `offshoot`, with the `create-*` package absent entirely (asserted by a test).

## Migrating `create-jolly-roger`

The acceptance target was that `offshoot new wighawag/jolly-roger my-app` produce output equivalent to `create-jolly-roger my-app`. `test/jolly-roger-equivalence.test.ts` asserts it against the **real** template, with `create-jolly-roger`'s substitution logic ported verbatim as the reference.

**Answer, per pattern: the generic `rename` strategy covers all of them. jolly-roger needs no `patterns` config.**

| `create-jolly-roger` pattern | Covered by | Notes |
| --- | --- | --- |
| `"jolly-roger"` | `paramCase` | Substring of the anchored form |
| `"jolly-roger-web"` | `paramCase` | `jolly-roger` + `-web` |
| `"jolly-roger-contracts"` | `paramCase` | same |
| `"jolly-roger-contracts/` | `paramCase` | same |
| `Jolly Roger` | `capitalCase` | Identical output (`my-app` -> `My App`) |
| `/jolly roger/i` | `noCase` | Identical output (`my-app` -> `my app`) |

The suite asserts that every line `create-jolly-roger` changes, offshoot changes **identically**, and that exactly **one** line differs beyond that:

```
scripts/run-e2e-tests.sh:85
  NODE_LOG="${TMPDIR:-/tmp}/jolly-roger-e2e-node.log"
```

No anchored pattern matches it, so `create-jolly-roger` leaves the template's name in the generated project. `rename` fixes it. The difference is asserted exactly, so it can never drift silently.

Two follow-ups for the jolly-roger template itself, both surfaced by `offshoot doctor`:

1. `web/README.md` contains SvelteKit's stock `npx sv create my-app`, which makes `my-app` a colliding target name. Either drop that file from the template, add it to `exclude`, or accept that users called `my-app` need `--force`.
2. Nothing else in the template trips the gate.

## Packages

A pnpm workspace publishing two packages, both MIT:

- **`offshoot`** - library plus CLI, the primary identity.
- **`create-offshoot`** - generic initializer, so `npm create offshoot user/repo my-app` works.

## Development

```bash
pnpm install
pnpm build
pnpm test        # integration tests use real git repos in temp dirs
```

The jolly-roger equivalence suite needs network access and skips itself cleanly without it.

### Releasing

[changesets](https://github.com/changesets/changesets) plus npm **Trusted Publishing (OIDC)**. There is no `NPM_TOKEN` anywhere: npm trusts this repository and `.github/workflows/release.yml` via the trusted publisher registered on each package, and publishes are stamped with provenance.

1. Land a PR that includes a changeset (`pnpm changeset`).
2. The release workflow opens or updates a "Version Packages" PR.
3. Merging that PR publishes the changed packages.

One thing to know before touching that workflow: `create-offshoot` depends on `offshoot` through `workspace:^`, which is only rewritten to a real range at publish time by **pnpm**. changesets detects pnpm and shells out to `pnpm publish`, so this works, but it is why `packageManager` must stay set in the root `package.json` and why publishing must never be switched to plain npm.

```
$ pnpm pack   # in packages/create-offshoot
dependencies: {"offshoot": "^0.1.0"}      # not "workspace:^"
```

## Out of scope for v1

No `adopt` command for retrofitting projects created by the current `create-jolly-roger`; there are no such users yet. The state file carries a `version` field so adoption can be added later without breaking existing projects.

## Credits

Ports logic from [`change-name`](https://github.com/wighawag/change-name) (MIT) and [`create-jolly-roger`](https://github.com/wighawag/create-jolly-roger). Binary detection derives from [istextorbinary](https://github.com/bevry/istextorbinary) (MIT). Fetching is [giget](https://github.com/unjs/giget); templating is [Eta](https://eta.js.org).

## License

MIT
