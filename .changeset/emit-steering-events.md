---
'@lostgradient/operative': minor
---

Emitted AB-67's steering event family (AB-90/AB-221). `packages/operative/src/events.ts` gains five new event classes, exported and added to `OperativeEventMap`:

- `SteeringAppliedEvent` (`steering.applied`) — dispatched by `runStep` at the AB-67/AB-198 boundary (entry of `runStep`, immediately after the abort check and before backpressure) the moment an accepted command's `configVersion` is first observed there. Fires at most once per distinct `configVersion` a run observes, never once per step — deduplicated via a new `RunState.lastAppliedConfigVersion` field (threaded across a durable checkpoint boundary via `RunCursor.lastAppliedConfigVersion`, mirroring `schemaAttempts`). The check runs after every boundary read, including inside the pause-wait loop's re-reads — not only once after the loop exits — so a `pause` command itself fires its own `steering.applied` (per AB-67's pause row: "applied at the boundary"), distinct from the `resume` that later releases the step. Carries `sessionId` (read from the new `SteeringGate.sessionId` field — required, since `SteeringDesiredState`/`SteeringEffectiveState` carry no `sessionId` of their own) and the exact `SteeringEffectiveState` the boundary stamped. Never fires for `configVersion === 0` (the un-steered default) or when the run has no `runId` to stamp `appliedAtRunId` with. Cursor-advancing, per AB-87's AC5 resolution.
- Dedupe is per-run only: a session whose `configVersion` a prior run already applied is re-observed and re-fired by a fresh run starting at `lastAppliedConfigVersion: 0`. Deduping across runs on the same session needs the `SteeringGate` implementation itself to remember what it has applied — that is AB-199's responsibility (`submitSteeringCommand`'s `SteeringGate`), not this boundary's.
- `SteeringAcceptedEvent` (`steering.accepted`), `SteeringRejectedEvent` (`steering.rejected`), `SteeringSupersededEvent` (`steering.superseded`), and `SteeringFailedEvent` (`steering.failed`) — exported and added to `OperativeEventMap` for Bureau's `submitSteeringCommand` admission surface (AB-199, Backlog) to dispatch against. This package does not dispatch them itself; it owns only the `runStep` boundary transition.

`SteeringGate` (an existing exported interface from AB-198) gains a required `sessionId: string` field.

No `SteeringRequestedEvent` exists: AB-67's `requested` state is never persisted or dispatched standalone (admission is synchronous validate-then-accept-or-reject).
