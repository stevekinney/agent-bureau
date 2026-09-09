---
'@lostgradient/operative': minor
---

Adds `AgentSession.incarnation` and dispatches `SessionCreatedEvent`/`SessionSavedEvent` with it (AB-384).

`AgentSession` gains an `incarnation: string` field: minted by `SessionStore` (`create-session-store.ts`'s `commit()`) the first time an id's body is committed — a brand-new id, or one recreated after its previous body was deleted — and preserved unchanged across every later `save()`/`update()` of that same live body. `createAgentSession()` sets it to `''` for a not-yet-persisted session; a record loaded from before this field existed (`parseSession`) also defaults to `''`, so it mints fresh on that record's next write rather than failing to parse.

`SessionStore.save()`/`update()` now dispatch `SessionCreatedEvent` (first successful commit of a live body) or `SessionSavedEvent` (every later commit) on a new `SessionStore.events: TypedEventTarget<OperativeEventMap>` — both classes' constructors gain a required third `incarnation` argument. `SessionDeletedEvent`'s constructor gains a required second `incarnation` argument, carrying the deleted record's own value at the moment of deletion. `events` is a required (non-optional) member of the `SessionStore` interface: a caller supplying its own `SessionStore` implementation, rather than `createSessionStore()`'s, must add it.

Nothing else is renamed, reshaped, or removed.
