---
'@lostgradient/operative': patch
---

`createAgentSchedule`/`createAgentScheduler` and `createDurableHeartbeat` now dispatch `AgentScheduledEvent` (`schedule.created`) through the same optional `emitter` AB-223 added, exactly once for a genuinely new registration — never for an idempotent re-registration that reuses an existing schedule, and never for a shared heartbeat's re-registration. `AgentScheduledEvent` was exported from `@lostgradient/operative` but never dispatched anywhere under `src` until now (AB-298, found by AB-223's implementation, #446). `createDurableHeartbeat`'s dispatch sets `agentName` to `DURABLE_HEARTBEAT_TICK_WORKFLOW_TYPE` (`'durableHeartbeatTick'`), the honest analog of "what this schedule fires" for a heartbeat, which has no per-agent identity of its own.
