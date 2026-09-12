---
'offshoot': patch
---

Pin the end-to-end scaffold in the jolly-roger equivalence suite to `PINNED_REF`, like the rest of the suite.

The file already pins the template to a fixed commit, and says why: upstream evolution must not be able to break this suite "and with it every publish from this monorepo". One case escaped the pin. Every other test works from the pre-fetched `templateDir` resolved at `PINNED_REF`, but the acceptance case called `scaffold()` with a bare `wighawag/jolly-roger`, which resolves live `main`.

So it broke exactly as predicted, from a commit in a different repository: on 2026-09-06 jolly-roger rewrote `home.e2e.ts` to read the app's name from `web-config.json` rather than spelling it out, the literal the assertion looks for stopped existing, and the next publish from this monorepo failed on a template file nobody here had touched. Pinning that call restores the intended property, which is that this suite describes the template at one known commit and changes only when someone deliberately bumps the SHA.
