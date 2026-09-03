---
'@lostgradient/operative': patch
---

Fixed `runStep`'s `steering.applied` dedupe (AB-221) to compare `SteeringDesiredState.configVersion` against `RunState.lastAppliedConfigVersion` with `>` instead of `!==`. A brand-new run seeds `lastAppliedConfigVersion` from `SteeringGate.getAppliedFloor()` — a session-wide value that can already exceed this particular run's own visible `configVersion` when a differently-scoped command (for example a pause bound to a different, earlier run) advanced the floor past the new run's own identity-only baseline. The previous unequal-only comparison re-fired `steering.applied` for that lower, already-applied version the moment the new run's boundary observed it; the dedupe cursor now only ever advances.
