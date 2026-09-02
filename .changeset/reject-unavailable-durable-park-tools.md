---
'@lostgradient/operative': minor
---

Reject `scheduleWakeup` and `requestHumanInput` when no durable run backs them, instead of silently no-oping.

Both tools previously wrote their pending slot and returned `{ scheduled: true }` / `{ parked: true }` unconditionally, even in an in-memory run with no durable engine attached — a success-shaped result for a park that never happened. Per AB-41's ratified decision record, `ScheduleWakeupContext` and `RequestHumanInputContext` now carry a required `durable: boolean` signal; `execute` throws a new `DurableCapabilityUnavailableError` (`code: 'DurableCapabilityUnavailableError'`, `category: 'unavailable'`, `retryable: false`) instead of mutating the context or dispatching a park event when `durable` is `false`. The thrown error satisfies Armorer's `isToolError` guard directly, so a standalone `createAgent` toolbox surfaces a `ToolExecutionResult` with `error.category === 'unavailable'`.

`@lostgradient/bureau`'s `requestHumanInput` composition (`humanInput: true`) already omits the tool from a run's effective toolbox whenever no durable engine is attached — this release makes that the documented preference, and threads `durable: true` into the context it constructs so a real durable run (ephemeral `MemoryStorage`-backed or persistent) keeps parking exactly as before. `scheduleWakeup` has no Bureau composition wiring today, so only its factory-level rejection is exercised in production; wiring it into Bureau is out of scope for this change.
