---
'@lostgradient/operative': minor
---

Adds the durable event history wire types (AB-91's `ab91-01` slice, AB-310).

`packages/operative/src/durable/event-history-types.ts` is new and exports `DurableEventOwnerKind` (`'run' | 'session'`), `DurableEventOwner`, `DurableEventEnvelope`, `DurableEventPage`, and `DurableEventGap` — the shapes Bureau's new `packages/bureau/src/durable-event-history.ts` store and `Bureau.eventHistory()` read/return. `DurableEventEnvelope` is a redacted, owner-scoped projection of Weft's `FleetEventEnvelope` (`kind`, `owner`, `sequence`, `cursor`, `emittedAtMs`, `payload`, plus a new `schemaVersion` field Weft's own envelope does not carry). `DurableEventGap` mirrors Weft's `FleetEventGapEnvelope` payload shape, returned instead of a page when a caller's `since` cursor predates the store's retention floor.

All new; nothing existing is renamed, reshaped, or removed.
