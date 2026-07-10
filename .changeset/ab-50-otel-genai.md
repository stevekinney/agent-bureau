---
"armorer": minor
---

Align `armorer/instrumentation`'s tool span with the OTel GenAI semantic conventions (pinned to `open-telemetry/semantic-conventions-genai` commit `63f8200`): the span is renamed from `tool {name}` to `execute_tool {name}`, its kind changes from `CLIENT` to `INTERNAL`, and it now carries `gen_ai.operation.name: 'execute_tool'`, `gen_ai.tool.call.id`, `gen_ai.tool.call.arguments`, `gen_ai.tool.call.result`, `gen_ai.tool.description`, and `error.type` on failure. Non-standard fields (duration, digests, cancellation reason, internal status) move from `gen_ai.tool.*` to `armorer.tool.*` so they no longer squat the reserved `gen_ai.*` attribute namespace. This is a breaking rename for anyone matching on the old span name or attribute keys — see the mapping table in the `armorer`/`operative` READMEs.
