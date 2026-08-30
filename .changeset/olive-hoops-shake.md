---
'offshoot-fanout': patch
---

Report a deliberately ignored node as `ignored` even when an ancestor failed. An exclusion (registry `ignore` or `--ignore`) was tested after blocking, so a node under a conflicting parent printed `skipped — parent not updated (conflict)`: word for word what a node that IS part of the cascade prints while waiting for the conflict to be fixed. A maintainer reading that would conclude the exclusion was not in force. Exclusion is a property of the node itself, so it is now decided first; `skipped` is said only about a node that would otherwise have been merged. `status` shares the same path and now counts such nodes under `ignored` rather than `blocked`.
