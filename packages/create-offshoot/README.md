# create-offshoot

Generic initializer for [offshoot](https://github.com/wighawag/offshoot): scaffold a project from a git template, then pull in template improvements later via real git merges.

```bash
npm create offshoot@latest wighawag/jolly-roger my-app
```

Accepts `user/repo`, `github:user/repo`, `user/repo#ref`, `gitlab:user/repo`, or a local path.

`npm create` forwards positional arguments directly, but flags need a separator:

```bash
npm create offshoot@latest wighawag/jolly-roger my-app -- --ref v2
```

Use `@latest`: a globally installed `create-*` package shadows the registry version.

## Just the code, no update mechanism

```bash
npm create offshoot@latest wighawag/jolly-roger my-app -- --eject

# npm forwards positionals directly but needs `--` before flags,
# so this equivalent spelling avoids the separator entirely:
npm create offshoot@latest wighawag/jolly-roger my-app eject=true
```

No template branch, no `.offshoot.json`, no dependency on offshoot: a plain git repository with one commit. `offshoot update` will not work there, which is the point.

Once the project exists, updates need only `offshoot`, not this package:

```bash
cd my-app
npx offshoot update
```

See the [main README](https://github.com/wighawag/offshoot#readme) for the template-branch model, the transform strategies and the uniqueness gate.

## License

MIT
