---
'@lostgradient/operative': minor
---

Widen `DurableEventOwnerKind` (`@lostgradient/operative/durable`) from `'run' | 'session'` to `'run' | 'session' | 'schedule'` (AB-320).

A `'schedule'` owner (`{ kind: 'schedule', id: scheduleId }`) carries a schedule's four DEFINITION lifecycle events — `schedule.created`, `schedule.paused`, `schedule.resumed`, `schedule.cancelled` (AB-298/AB-223) — which had no owner to record under before this change. A scheduled FIRE's terminal outcome (`schedule.completed`/`schedule.failed`) stays recorded under the fired run's own `{ kind: 'run', id: runId }` owner, unchanged ("a schedule fire is an ordinary run," AB-87's coordinator ruling): a schedule's own durable page carries its four definition events only, never a fire, and the fired run's own page carries the fire only, never a definition event.

`bureau`'s `createDurableEventProducer` now listens for the four schedule-definition events on the bureau's own event surface (they never traverse the `'action'` stream) and records each exactly once under the schedule's owner. This is additive: `DurableEventOwnerKind` widening is backward-compatible for any code narrowing over `'run' | 'session'` already, and no existing recorded owner or payload shape changes.
