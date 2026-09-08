---
'@lostgradient/operative': minor
---

Add `AgentRunContext.principal` (AB-241), forwarded by `createAgent`'s run path into `RunOptions.principal` the same way `signal` and `traceContext` already forward — a plumbing-only addition with no behavior attached at the operative layer.

`bureau` (private, no changeset) consumes this to honor `BureauRunOptions.principal` on `bureau.run(name, input, options)` catalog dispatch instead of throwing synchronously: the direct (in-memory) dispatch branch forwards it to the agent's own `run()`, and the durable dispatch branch additionally records it exactly as `Bureau.createRun` does — `LivenessSnapshot.owner` and the in-memory `runAttribution` map `eventHistory`'s principal-authorization gate consults — so a caller sees the same attribution regardless of which branch a given agent takes. `BureauRunOptions.principal` now validates as a string (`BureauError` `BAD_REQUEST` otherwise) rather than rejecting every value.
