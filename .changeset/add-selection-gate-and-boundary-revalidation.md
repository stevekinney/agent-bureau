---
'@lostgradient/operative': minor
---

Adds `SelectionGate` and `runStep` boundary revalidation for backend selection (AB-64, implemented by AB-250).

`packages/operative/src/selection-gate.ts` is new and exports `SelectionGate` (`getPlan(): SelectionPlan | undefined`, `revalidate(): SelectionPlan`) and `createSelectionGate(options)`, its reference implementation. Both members are synchronous and pure — `select` (AB-249) is pure, and the boundary performs no input or output and never awaits a provider. `revalidate()` compares the recorded plan's `catalogRevision`/`policyRevision`/`availabilitySnapshotRevision` against the current values a caller-supplied `request()`/`options()` source reports: nothing changed returns the SAME plan by reference; a changed catalog or policy revision delegates to `select`'s own `options.revalidate` comparison (`'capability-changed'`/`'policy-changed'` when the prior selected candidate is no longer eligible); an availability-only change falls through to `select`'s ordinary zero-candidate path and surfaces as `'no-candidate'`.

`RunOptions` gains an optional `selection?: SelectionGate`, mirroring the shipped `steering?: SteeringGate` field — unlike `steering`, it carries no `runId` coupling. `run-step.ts` reads it at the same boundary the steering gate is already read: after the pause-wait loop, before backpressure. A revalidated plan that no longer reaches `outcome: 'selected'` fails the step with the new `SelectionRevalidationError` (kind `'policy'`, code `'SELECTION_REVALIDATION_FAILED'`), carrying both the failed replacement plan and the superseded plan it replaces — never silently falling back to the superseded plan's model. Omitting `RunOptions.selection` leaves `runStep` behaving exactly as it does today, matching how `steering` was introduced.

`DelegatedAuthority` now threads through `packages/operative/src/child-run.ts`'s `DispatchChildRunOptions.delegatedAuthority`, forwarded to `agent.run()` as the new `AgentRunContext.delegatedAuthority` — never through `BureauRunOptions`, per AB-64's decision record. `child-run.ts` also exports `attenuateDelegatedAuthority(parent, child)`, a pure helper that composes a parent's grant with the authority a dispatch site wants to hand one specific child: `grantedProviders`/`grantedModels` intersect (never widen), `maximumEffort` takes the lower tier, and the result's `policyVersion` is the attenuating (child) grant's own version — a child can never select a provider, model, route, or effort forbidden by any ancestor.

No `any` and no `as unknown as`.
