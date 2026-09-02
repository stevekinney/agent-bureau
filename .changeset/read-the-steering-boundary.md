---
'@lostgradient/operative': minor
---

Implemented AB-67's `runStep` boundary read: model/provider/route/effort/pause/resume steering now applies at the entry of `runStep` (`packages/operative/src/run-step.ts:390-397`), the single point both the in-memory `executeLoop` driver and the durable `run-workflow.ts` driver reach once per step.

- `RunOptions` gains an optional `steering?: SteeringGate` field. `SteeringGate` is a new exported interface — `getDesiredState(): SteeringDesiredState` and `awaitResume(): Promise<void>` — the contract a caller (e.g. Bureau's `submitSteeringCommand` admission path) implements to supply the session's real desired steering state and resolve on the accept side of a `resume`. Omitting `steering` leaves `runStep` behaving exactly as it does today, with no thrown error.
- `buildStepDeps` (`loop.ts:30`) threads `RunOptions.steering` into `StepDeps.steering`, reachable by both the in-memory driver (`loop.ts:102`) and the durable driver (`run-workflow.ts:481`, via `DurableRunDeps.options: RunOptions`) with no duplicated construction logic.
- A `paused: true` desired state at the boundary blocks the step until a matching `resume` releases it OR the step's own `AbortSignal` fires, whichever comes first; on abort, the step resolves with the identical `{ kind: 'abort', ... }` shape an unpaused abort already produces.
- `GenerateContext` and `BeforeGenerateContext` gain a `steering?: SteeringDesiredState` field carrying the session's desired route/model/provider/effort, populated at the boundary read and re-applied after any `beforeGenerate` hook returns a replacement context — the field is not hook-overridable.
- `createRoutingGenerate` consults `GenerateContext.steering.route` for a route override, taking priority over its `strategy(context, routes)` read, and its doc comment names the pattern a non-routing provider factory (`createAnthropicProvider` and siblings) must follow to honor a `model`/`provider`/`effort` steering override.

`policyRef` resolution and override-against-catalog validation are out of scope (AB-66, AB-65); a `route`/`model`/`provider`/`effort` `override` is honored as given.
