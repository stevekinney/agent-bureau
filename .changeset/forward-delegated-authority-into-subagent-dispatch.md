---
'@lostgradient/operative': patch
---

`createSubagentTool` now reads the parent run's `delegatedAuthority` grant off its per-execution `ToolContext.executionContext` (threaded there from `AgentRunContext.delegatedAuthority`, matching the AB-233 `childRegistry`/`parentRunId` pattern), attenuates it with the tool's own `delegatedAuthority` construction option when supplied via `attenuateDelegatedAuthority`, and forwards the result into its `dispatchChildRun` call. Previously a subagent dispatched through `createSubagentTool` always received `delegatedAuthority: undefined` regardless of the parent's grant — `model-policy.ts` documented this wiring as a later issue's to make (AB-250/AB-251). A parent run with no grant and a tool with no narrowing of its own still dispatches with `delegatedAuthority` left `undefined`, unchanged from before.
