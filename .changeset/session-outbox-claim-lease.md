---
'@lostgradient/operative': minor
---

Add a claim lease to `SessionStore.outbox` (AB-390), closing the AB-389 residual where two processes sharing one persistent backend could both replay the same unacknowledged commit-outbox entry.

`outbox.claim(ordinal, { owner, until })` takes exclusive replay rights on one entry via a compare-and-swap on the entry's own new `claim` field (`SessionOutboxClaim`, `{ owner, until }`) — never a separate lock record. It resolves `true` when the entry is unclaimed, its prior claim's `until` has already passed by this store's own `RuntimeServices.clock.now()`, or `owner` already held it (claim renewal always succeeds); `false` when a different, still-unexpired owner holds it, or the entry no longer exists.

`outbox.acknowledge(ordinal, owner)` now takes the claiming `owner` as a required second argument and only removes the entry when `owner` still holds its claim (verified by the same compare-and-swap discipline), returning `true` when the entry is gone after the call (removed by this call, or already gone) and `false` when a different owner reclaimed it first. This is a breaking change to `SessionStore.outbox.acknowledge`'s signature for any caller-supplied `SessionStore` implementation or direct caller of the built-in one; `pending()`'s signature is unchanged.

A drainer that crashes between winning a claim and acknowledging leaves the entry claimed but undelivered only until its own lease's `until` passes — a later drain (the same process's next tick, or a peer's) reclaims and completes it exactly once, closing the gap where `audit-trail.ts`'s `session.deleted` listener and a direct `bureau.addEventListener('session.deleted', ...)` consumer could each observe a replay twice.
