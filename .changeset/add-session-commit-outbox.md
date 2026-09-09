---
'@lostgradient/operative': minor
---

Couple `SessionStore`'s emitter-dispatched durable events to their own commit through an outbox (AB-389), closing the known limitation `dispatchPersistEvent` documented on `create-session-store.ts` since AB-384 (PR #592): a crash between a commit succeeding and its listener dispatch running used to lose the `session.created`/`session.saved`/`session.deleted` fact forever, and two `SessionStore` instances sharing one persistent backend could record events out of true commit order.

`save()`, `update()`, and `delete()` no longer dispatch `SessionCreatedEvent`/`SessionSavedEvent`/`SessionDeletedEvent` directly. Each commit instead appends a `SessionOutboxEntry` — carrying the event's payload, incarnation, and the store's own monotonically increasing commit ordinal — to the SAME atomic `conditionalBatch` as the body/summary-index write (or, for `delete()`, the removal), and dispatches only a new best-effort `SessionOutboxAppendedEvent` drain trigger on `SessionStore.events`. `SessionStore` gains a new `outbox` surface: `outbox.pending()` lists entries in ordinal order, and `outbox.acknowledge(ordinal)` removes one once its replay has durably settled.

Every event class carries a new required `ordinal: number` constructor parameter naming the outbox entry it replays: `SessionCreatedEvent`, `SessionSavedEvent`, and `SessionDeletedEvent`. A new `SessionOutboxAppendedEvent` class and its `session.outbox-appended` event-map entry are added; both are exported from the package root and the `session/index.ts` subpath, alongside the new `SessionOutboxEntry` type.

A caller (Bureau's own drain loop) that needs the real `session.created`/`session.saved`/`session.deleted` facts must drain `outbox` itself and replay them — listening on `SessionStore.events` alone is no longer sufficient, since it now carries only the trigger, never the events themselves.
