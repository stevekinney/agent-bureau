---
'@lostgradient/operative': minor
---

Change `SessionStore.delete(id)` to resolve `Promise<boolean>` instead of `Promise<void>` (AB-371).

`delete(id)` now resolves `true` only when that specific call actually removed a live record, and `false` when there was nothing to remove — the id never existed, or another caller already deleted it. `createSessionStore()`'s own implementation computes this atomically, from the same delete-and-count compare-and-swap that removes the record, never a separate existence check followed by a delete.

**Migration for a custom `SessionStore` implementation**: return `true` from `delete(id)` when your backing store actually removed a record it had for that id, and `false` when it did not. A store that still resolves `void` (or unconditionally resolves `true`) makes any caller relying on the return value — such as Bureau's `deleteSession`, which now uses it to avoid producing a duplicate durable `session.deleted` record and notification when two processes race to delete the same session over one shared persistent store — treat every call as if it won, even when it didn't.
