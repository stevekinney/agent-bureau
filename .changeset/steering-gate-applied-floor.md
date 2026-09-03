---
'@lostgradient/operative': minor
---

`SteeringGate` (AB-67's runtime steering contract) gains an optional `getAppliedFloor?(): number` method: the highest `SteeringDesiredState.configVersion` the gate has already observed applied by any run on the owning session. `executeLoop` and the durable driver each call it once, at the start of a brand-new run only, to seed `RunState.lastAppliedConfigVersion`/`RunCursor.lastAppliedConfigVersion` — closing a gap where a fresh run on a session whose `configVersion` a PRIOR run already applied would otherwise re-observe and re-fire `steering.applied` for it. Optional and purely additive: a gate that omits it (or an absent `steering` dependency entirely) seeds every fresh run's dedupe cursor at 0, identical to today's behavior.

This is a mechanical companion to `packages/bureau`'s AB-199 (`Bureau.submitSteeringCommand`'s cross-run dedupe requirement), threaded through `packages/operative` because `SteeringGate` and the two run drivers that seed from it are operative-owned types AB-199's own gate implementation is the first real consumer of.
