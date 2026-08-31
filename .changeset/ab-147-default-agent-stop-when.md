---
'@lostgradient/operative': minor
---

`createAgent` now defaults `stopWhen` to `stopWhen.noToolCalls()` when the caller omits it, instead of running every step to `maximumSteps` with no stop condition at all. Pass an explicit `stopWhen` (still fully overridable) for agents that must finish on a tool call, such as a handoff.
