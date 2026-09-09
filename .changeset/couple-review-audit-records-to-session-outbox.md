---
'@lostgradient/operative': minor
---

Add a `'session.attachment'` variant to `SessionOutboxEntry` and an `options.outbox` parameter to `SessionStore.update()` (AB-391): `update(id, updater, { outbox: [{ namespace, payload }] })` appends each attachment as a `SessionOutboxEntry` in the SAME `conditionalBatch` as the update's own body, summary-index, and outbox-ordinal writes, at consecutive ordinals immediately after the update's own `session.created`/`session.saved` entry. `namespace`/`payload` are opaque to this store, interpreted only by whichever `SessionOutboxEntry` consumer recognizes the namespace it appended — no entry is appended, and no ordinal consumed, when the updater declines to commit.

This lets a caller couple its own durable write to a session-store commit it does not own, without inventing a second outbox. Agent Bureau uses it to append a review-transition audit record atomically with the session-store commit that resolves the review (`persistReviewResolution`), closing a crash window where the audit record could be lost even though the review was already durably resolved — see `packages/bureau/README.md`'s "Review-transition audit records ride the outbox" section.

`SessionStore.update()`'s `options.outbox` attachments are now validated and snapshotted at call time (a caller mutating one of its own attachment objects from inside its `updater` — after validation, before `commit()` serializes it — can no longer change what durably commits).

`@lostgradient/operative/test`'s `FaultOperation` gains the `storage:conditionalBatch` verb, and `FaultEngine.wrapStorage()` intercepts it alongside the original `get`/`set`/`delete`/`query` four — needed because Agent Bureau's audit trail now commits every write (ordinary and `dedupeKey`-guarded alike) through `conditionalBatch`'s key-collision fence rather than a plain `set`, and a test targeting one of those writes needs `wrapStorage` to reach it.
