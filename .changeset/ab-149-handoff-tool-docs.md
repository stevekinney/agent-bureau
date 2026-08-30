---
'@lostgradient/operative': patch
---

Document `stopWhen.toolCalled(name)` as the correct pairing for `createHandoffTool` (and warn against `stopWhen.noToolCalls()`, which never terminates a handoff loop), and document the default `z.object({})` input schema with an example of supplying a custom one.
