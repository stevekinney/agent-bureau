---
'@lostgradient/operative': minor
---

Add a runtime witness for `RunnableAgent`'s has-output type parameter (AB-234).

`RunnableAgent<O, H>` gains a readonly `hasOutput: boolean` — a real runtime witness for `H`, mirroring `AgentRun`'s existing `hasOutput` boolean. `createAgent` and `createLazyAgent` populate it (`output !== undefined`, or the new `hasOutput` option on `createLazyAgent`'s second argument). `isSuccessfulRunResult` accepts it as an optional second argument, and `createSubagentTool`'s success narrowing now passes `agent.hasOutput` through: a hand-written `RunnableAgent<O, true>` that never attaches `schemaValidation` at all is rejected as a failed run instead of being misread as a schema-less success — closing a soundness gap `isSuccessfulRunResult`'s own doc comment previously documented as open. Omitting the second argument preserves prior behavior for every existing caller.

`RunnableAgent.run` and `StandaloneAgent.run` are now declared as property-typed functions rather than method shorthand, so their parameter is checked contravariantly instead of bivariantly: a hand-written agent whose `run` only accepts `string` (rejecting the `{ conversation }` resumption form of `AgentInput`) no longer satisfies the contract.

**Migration**: any hand-written object literal satisfying `RunnableAgent<O, H>` (test doubles, catalog entries, lazy-loader fixtures) now needs an explicit `hasOutput: boolean` field — set it to `false` for a schema-less agent, `true` for one with a validated `output`. A `createLazyAgent(loader)` call for a schema-backed agent (`H = true`) should also pass `{ hasOutput: true }` as the second argument so the synchronously-returned wrapper's witness is truthful before the loader ever runs.
