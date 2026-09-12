---
'offshoot-fanout': patch
---

Fix three things `clone` got wrong the first time it was pointed at a real tree.

**It cloned the whole family when asked for a subtree.** Every member shares the root commit, so discovery from any repo sees all of them; classification then marked each annotated repo a member regardless of whether it descended from the REQUESTED root. The printed tree was correctly scoped while the cloning was not, so `clone wighawag/template-svelte-tailwind-blog` drew a three-repo tree and put eleven repos on disk. Cloning is now restricted to repos reachable from the requested root by following `stem` edges, and the family members outside that subtree are listed as such rather than fetched. The walk goes down one generation at a time, so a cycle from a mis-annotated repo terminates instead of spinning.

**It defaulted to https, which cannot fetch what discovery can see.** Discovery is authenticated and therefore finds private members, but an https clone of a private repo fails asking for a username no non-interactive run can supply: a private member was discovered, listed in the tree, and failed while its ten public siblings succeeded. The default is now ssh, or `gh`'s configured `git_protocol` when it says https, so the credential that can see the tree can also fetch it. `--prefer-https` forces the old behaviour.

**`config stem` echoed the wrong value.** `--from-remote` reports what it wrote, but printed the raw clone URL it read rather than the canonical id that lands in the file, so the confirmation described something other than the change. It now reports the recorded value, in the message and in the commit subject.

Also reports the root as `cloned` rather than `existing` when the run itself created it.
