---
'armorer': minor
'@lostgradient/operative': minor
---

`ToolExecuteOptions` gains two optional per-call fields: `traceContext?: unknown` and `executionContext?: Record<string, unknown>`. `createToolbox` threads both into the per-call `RuntimeToolContext` (`context.traceContext`/`context.executionContext`), falling back to the toolbox's own base context when a call supplies neither (AB-233).

`packages/operative/src/run-step.ts`'s toolbox execute call site now passes the run's active trace context through `traceContext`, and this run's own `childRegistry`/`runId` through `executionContext: { childRegistry, parentRunId }`. A `createSubagentTool` reached through the ordinary `createAgent`-driven agent loop now observes the parent run's trace context automatically — no more building a toolbox with a matching `context: { traceContext }` to make `context.traceContext` reach a subagent tool (the operative README's documented limitation is removed).

This also closes an AB-50 reuse gap: `createSubagentTool` previously captured `parentContext.registry`/`parentContext.parentRunId` once at tool construction, so one tool instance reused across two `agent.run()` calls shared a child registry (either run's `abortChild` could cancel the other's child) and nested dispatch stamped every child with the same frozen `parentRunId`. `createSubagentTool` now reads `childRegistry`/`parentRunId` from `ToolContext.executionContext` at execute time, in preference to `parentContext.registry`/`parentContext.parentRunId`, which remain supported as construction-time defaults for a direct `dispatchChildRun` caller or a tool built outside the ordinary loop.

`RunOptions` (operative) gains a new optional `childRegistry?: ChildRunRegistry` field, threaded automatically from `AgentRunContext.childRegistry` when a run is started through `createAgent`'s returned agent.
