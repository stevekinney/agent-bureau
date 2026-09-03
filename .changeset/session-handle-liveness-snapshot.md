---
'@lostgradient/operative': minor
---

Adds AB-215's (obs-02) `LivenessObservable` wiring to `SessionHandle`: `snapshot()` returns a `LivenessSnapshot` narrowed to `kind: 'session'`, and `subscribeSnapshot(observer, options?)` delivers it immediately, then again on every revision change, until `unsubscribe()` or `options.signal` aborts it (a session never reaches a terminal liveness status). `durability` is always `'process-local'` (AB-39).

The `session.monitor` `StallPolicy` row (`policies.ts`) drives a watchdog for the lifetime of an active `monitor()` loop, built via `createStallWatchdog` over the SAME `setTimeoutFunction`/`clearTimeoutFunction` pair `sleep()`/`monitor()` already use — no second timer seam. Each `session.monitor.tick` records a `'host-reachability'` pulse and sets `lastActivityAt`/`lastHeartbeatAt`/`lastProgressAt`. A `HumanWaitParkedEvent` observed on a run this session started moves the session to `status: 'waiting'` with a `DeclaredWait` (`reason: 'review'` when the event carries a `prompt`, `'signal'` otherwise, `deadline` intentionally absent per AB-88's unbounded-wait exception); the watchdog is paused for the wait's duration so elapsed time never accrues toward stalled/unreachable, and resumes fresh once `session.signal()` delivers the matching signal.

Additive only — no change to `session.signal`/`update`/`query`/`monitor` semantics beyond the new `snapshot()`/`subscribeSnapshot()` members.
