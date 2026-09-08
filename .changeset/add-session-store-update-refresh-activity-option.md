---
'@lostgradient/operative': minor
---

Add an optional `{ refreshActivity?: boolean }` third parameter to `SessionStore.update()` (AB-363, Codex review PR #568, "Avoid refreshing session activity during retention pruning").

`update()` always stamped a fresh `updatedAt` on a successful write. Since `SessionStore.list()` sorts by `updatedAt` by default and `cleanup({ olderThan })` uses that same field as its age cutoff, a background maintenance write that only prunes stale metadata (never touching the session's real content) could reorder or resurrect an otherwise-inactive session purely by having written to it. Passing `{ refreshActivity: false }` persists the updater's result without advancing `updatedAt`; the default (`true`, or the option omitted entirely) preserves the exact existing behavior for every current caller.
