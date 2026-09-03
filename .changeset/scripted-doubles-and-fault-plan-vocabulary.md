---
'@lostgradient/operative': minor
---

Adds scripted generate, tool, and hook test doubles plus the `FaultPlan` type vocabulary (AB-92's Decision, implemented by AB-257).

`packages/operative/src/test/fault-plan.ts` is new and exports `FaultBoundary`, `FaultOperation`, `FaultOccurrence`, `FaultPlanEntry`, `FaultPlan`, and `FiredFault` — AB-92's fault-plan vocabulary, verbatim. `FiredFault` is the shape's canonical definition; `event-recorder.ts`'s `CausalTraceEntry.faultEvidence` now imports it instead of redeclaring it, so `faultEvidence.boundary` is typed as `FaultBoundary` rather than `string`. This slice ships only the vocabulary — no fault engine exists yet (that's AB-95).

`packages/operative/src/test/scripted-generate.ts` is new and exports `createScriptedGenerate(script)`, returning a `GenerateFunction` double that consumes one `ScriptedGenerateStep` per call (`respond`, `stream`, `block`, `fail`, `ignore-abort`), records every call, and exposes `assertReceived(index, expected)` to assert the `conversation`, `tools`, `model`, `effort`, `signal`, and `traceContext` a call received. A `block` step suspends the call until a named barrier is released (`reached`/`release`), then transparently resolves with the next scripted step. `withTraceContext` is exposed for a caller to wire onto `RunOptions.withTraceContext`, since `GenerateContext` itself carries no `traceContext` field.

`packages/operative/src/test/scripted-tool.ts` is new and exports `createScriptedTool(name, script)` (a toolbox-ready `Tool` double, built on `armorer`'s `createTool`) and `createScriptedHook(phase, script)` for one of the four `'before-model' | 'after-model' | 'before-tool' | 'after-tool'` phases, registerable on a `HookRegistry<OperativeHookMap>` via its own `hookName`. Both record their calls, support the same `block`/`resolve`/`reject` script vocabulary, and expose `settled(): Promise<readonly ScriptedSettlement[]>` so a test never polls for an async side effect to finish.

Every new export is re-exported from `@lostgradient/operative/test`. No production code outside `src/test/` changes behavior; every double is a value a caller passes through an existing public option (`generate`, `toolbox`, `hooks`).
