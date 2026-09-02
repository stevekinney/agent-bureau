---
'@lostgradient/operative': minor
---

Resume agent reasoning with a delivered `requestHumanInput` signal payload, instead of discarding it.

Per AB-41's ratified decision record, the durable `agentRun` workflow now captures the value `ctx.waitForSignal()` returns and continues the same run with one more agent generation step, seeded by a deterministic `[signal:{name}] {payload}` conversation message — never merely unparking into an immediate return. A `requestHumanInput` tool call now commits its step and parks before another generation call can run without the requested input (previously the loop could run additional generation calls before the post-loop park block was ever reached). Re-parking from within the continuation step is supported: if it itself calls `requestHumanInput` again, the workflow parks again rather than returning. The final `AgentRunWorkflowResult` is produced only after the resumed agent reaches a normal terminal condition — a delivered signal alone never finalizes a pre-signal result.

A new `packages/operative/src/durable/continuation-input.ts` module (re-exported from `@lostgradient/operative/durable`) owns the deterministic rendering: `SignalContinuationInput`, `buildSignalContinuationInput`, `isDeniedSignalPayload` (the AB-46-ratified `{ __abDenied: true, reason?: string }` denial sentinel, rendered as `[signal:{name}] denied: {reason}`), and `renderSignalContinuation`, which defensively falls back to a fixed `[unserializable payload]` placeholder rather than crashing the workflow body when `JSON.stringify` cannot render a delivered payload.

`AgentRunWorkflowResult.humanWaitSignal` now reports the last signal the run genuinely parked on and was released for as a historical fact, persisting across the run's eventual termination rather than only appearing when the run happened to still be "parked" at return time. `SessionHandle.signal()`'s documentation is updated to describe the continuation behavior.
