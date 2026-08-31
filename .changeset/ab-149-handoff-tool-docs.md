---
'@lostgradient/operative': patch
---

Correct the `createHandoffTool` documentation. Warn against `stopWhen.noToolCalls()`, which never terminates a handoff loop, and recommend composing `stopWhen.every(stopWhen.toolCalled(name), stopWhen.not(stopWhen.toolOutcome('error')))` with a step cap instead of bare `stopWhen.toolCalled(name)` — the latter inspects only the generated call name, so it also fires on a handoff whose arguments fail validation, ending the run with no `HANDOFF_MARKER` and `extractHandoffTarget` returning `undefined`. Document that `undefined` check as mandatory, and document the default `z.object({})` input schema alongside an honest account of a custom one: it constrains and validates the call but does not travel into the handoff marker, so the values are recoverable from the recorded tool call on `RunResult.steps`, not from `extractHandoffTarget`.
