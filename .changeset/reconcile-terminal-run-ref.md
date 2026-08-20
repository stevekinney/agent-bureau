---
'@lostgradient/operative': patch
---

Fix `session.recover()` leaving a session's `RunRef` stranded at `status: 'running'` forever when a recovered durable run reaches a terminal state before `recover()` resumes it. `engine.resume()` rejecting for an already-terminal workflow now reconciles the persisted `RunRef` (and recovered conversation history) to the workflow's actual terminal status instead of being silently swallowed; an unknown `runId` is left untouched.
