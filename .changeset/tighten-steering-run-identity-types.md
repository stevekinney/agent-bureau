---
'@lostgradient/operative': minor
---

Tightened two exported steering types (AB-236, closing gaps AB-221's review found in AB-203's exported shapes):

- `SteeringCommandFailure` is now a discriminated union on `reason` instead of one interface with an optional field. The `'superseded-by'` member requires `readonly supersededBy: string`; every other member forbids it (`supersededBy?: never`). A literal that supplies `supersededBy` alongside a different `reason`, or omits it alongside `'superseded-by'`, is now a compile error instead of a documented-only invariant.
- `RunOptions` makes `runId` required whenever `steering` is set. `runStep`'s AB-221 `steering.applied` dispatch stamps `SteeringEffectiveState.appliedAtRunId` from `runId` and has no honest fallback when it's absent — a steering-enabled run with no `runId` used to silently never fire that event. AB-67's decision record names two ways to close this: make `runId` required whenever `steering` is set, or synthesize one through the identifier seam AB-214 introduces. **AB-214 has not merged**, so this release takes the type-level option: `RunOptions` is now a discriminated pair on `steering`/`runId` (a conditional-type variant) rather than two independently-optional fields.

**Migration:** a caller constructing a steering-enabled `RunOptions` literal — directly, or through `executeLoop`, `buildStepDeps`, or `createActiveRun` — must now also supply `runId`. A run with no `steering` is unaffected; `runId` stays optional there, exactly as before. A derived options type built with `Omit<RunOptions, ...>` or `Partial<RunOptions>` no longer preserves this pairing (both are non-distributive over a union) — use a distributive `Omit`/`Pick` if a derived type still needs to enforce it.

When AB-214 merges, `createActiveRun` may instead synthesize a `runId` for a steering-enabled run with none supplied, which could relax this constraint — a separate, later decision, not made here. Type-only: no runtime behavior is added or changed by this release.
