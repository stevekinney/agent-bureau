---
'@lostgradient/operative': minor
---

`SessionHandle.recover()` now surfaces a failed durable re-attach through `emitter` instead of returning an indistinguishable `null`. `SessionRecoverEvent` gains a `failures` array (each entry carrying the rejected `runId` and its `error`), populated whenever `engine.resume()` rejects while re-attaching to a session's `running` refs — distinguishing "nothing to resume" (`failures: []`) from "resume was attempted and failed" (`failures.length > 0`). `recover()` itself keeps returning `AgentRun | null` and never throws.
