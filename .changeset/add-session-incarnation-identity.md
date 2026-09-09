---
'@lostgradient/operative': minor
---

Adds `AgentSession.incarnation` and dispatches `SessionCreatedEvent`/`SessionSavedEvent` with it (AB-384).

`AgentSession` gains an `incarnation: string` field: minted by `SessionStore` (`create-session-store.ts`'s `commit()`) the first time an id's body is committed — a brand-new id, or one recreated after its previous body was deleted — and preserved unchanged across every later `save()`/`update()` of that same live body. `createAgentSession()` sets it to `''` for a not-yet-persisted session; a record loaded from before this field existed (`parseSession`) also defaults to `''`, so it mints fresh on that record's next write rather than failing to parse.

`SessionStore.save()`/`update()` now dispatch `SessionCreatedEvent` (first successful commit of a live body) or `SessionSavedEvent` (every later commit) on a new `SessionStore.events: TypedEventTarget<OperativeEventMap>` — both classes' constructors gain a required third `incarnation` argument. `SessionDeletedEvent`'s constructor gains a required second `incarnation` argument, carrying the deleted record's own value at the moment of deletion. `events` is a required (non-optional) member of the `SessionStore` interface: a caller supplying its own `SessionStore` implementation, rather than `createSessionStore()`'s, must add it.

`SessionStore.delete()` gains an overload, `delete(id, { returnIncarnation: true }): Promise<{ removed: boolean; incarnation: string | undefined }>`, alongside the existing `delete(id): Promise<boolean>` (unchanged, still the AB-371 contract). The new overload reports the incarnation of the exact body the delete atomically removed, closing a real race a caller reading `load(id)` before calling `delete(id)` would otherwise have (another process can delete-and-recreate the id between those two calls).

`save()`/`update()` reject with the new `StaleSessionIncarnationError` when a candidate names a specific, nonempty `incarnation` that no longer matches the live body's current one (a caller writing back a prior incarnation's own object after that body was deleted and the id recreated). A candidate with `incarnation: ''` — the `createAgentSession()` default — is never rejected this way. `StaleSessionIncarnationError` (and the pre-existing but previously-unexported `SessionConflictError`) are now exported from `@lostgradient/operative`'s root and `session/` subpath entry points.

`saveAgentSession()` gains an optional third `options.runtime` argument, forwarded to `createSessionStore()` so a caller using `createAgentSession({ runtime })` mints `incarnation` from that same injected runtime rather than a second default one.

Nothing else is renamed, reshaped, or removed.
