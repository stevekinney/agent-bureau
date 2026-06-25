---
"operative": minor
---

Phase F: durable multi-agent layer (F1/F2/F3).

**F1 substrate swap**: `createSubagentTool` emits `ChildWorkflowStartedEvent` on each delegation, carrying parent/child agent names, parent run id, mapped input, and a `durable` flag (true when the bureau has `.persistence()` set). The event is dispatched before the child run executes, satisfying the C3 completeness rule.

**F2 handoff as durable session-continuation**: `RunRef` now carries `agentName` so a session records which agent handled each run. `AgentRunWorkflowInput` and `DurableActiveRunOptions` require `agentName`; `createHandoffTool` emits `HandoffOccurredEvent` (with optional `sessionId` for durable continuation) when a `sourceContext` is provided. The trust-boundary guard `isAgentRunWorkflowInput` now also requires `agentName`—runs checkpointed before this upgrade are treated as not-reconstructable (cross-upgrade in-flight runs are out of scope).

**F3 human-in-the-loop**: New `createRequestHumanInputTool` (analogous to `createScheduleWakeupTool`) parks a durable run via `yield* ctx.waitForSignal(signalName)` after the step loop exits, and emits `HumanWaitParkedEvent` (C3 rule). New `PendingHumanWait` type on `DurableRunDeps`; `AgentRunWorkflowResult` carries `humanWaitSignal` on resume. Released by `session.signal(runId, signalName, payload)`.

New exports: `ChildWorkflowStartedEvent`, `HandoffOccurredEvent`, `HumanWaitParkedEvent`, `createRequestHumanInputTool`, and matching hook context types (`ChildWorkflowStartedHookContext`, `HandoffOccurredHookContext`, `HumanWaitParkedHookContext`).
