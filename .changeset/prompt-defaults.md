---
"offshoot": minor
---

Add `defaults` to `scaffold()`: caller-supplied suggestions for prompts the user is still asked.

A per-template wrapper often has an opinion about what to suggest (`create-jolly-roger` wants "my-onchain-app"), but that opinion belongs to the wrapper, not to the template. Previously the only way to change a prompt's initial value was an `offshoot.config` in the template repo, which forced a template to reference offshoot just to get a nicer default.

```js
scaffold({
  template: "wighawag/jolly-roger",
  argv: process.argv.slice(2),
  defaults: {name: "my-onchain-app"},
});
```

`defaults` only changes what is offered; `answers` still supplies a value and skips the question. A real answer (a positional argument, `--answer`, or an explicit `answers` entry) always wins.
