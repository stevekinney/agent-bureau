---
'armorer': minor
---

`instrument()` (`armorer/instrumentation`) no longer attaches privileged tool-argument or tool-result content to OpenTelemetry span attributes (AB-230, auditing the gap AB-87 declared: "a privileged tool argument must not become a span attribute, and nothing today verifies that").

Four attributes are removed rather than redacted with a placeholder — `gen_ai.tool.call.arguments`/`gen_ai.tool.call.result` are Opt-In under the OTel GenAI semantic conventions specifically because they can carry sensitive data, so this package no longer opts in:

- `gen_ai.tool.call.arguments` — previously attached on the `execute_tool` span (from `call.arguments`) and as an attribute on the span's `tool.started` event (from `params`). Both sites now omit it; the `tool.started` event still fires as a timing marker, with no attributes.
- `gen_ai.tool.call.result` — previously attached on a successful `tool.finished` close (from `result`).
- `armorer.tool.cancellation_reason` — previously attached on a cancelled `tool.finished` close, serializing the cancellation error (which is derived from a caller-supplied abort reason and can itself carry argument content).
- `armorer.tool.error` — previously attached on an error/denied `tool.finished` close for a thrown/returned value that was not an `Error` instance (which can itself carry argument or result content).

If a downstream telemetry consumer depended on any of these, `armorer.tool.input_digest`/`armorer.tool.output_digest` remain as the non-privileged correlation handle, and `error.type` (the error category, unchanged) remains for the error paths. A genuine `Error` on any error/cancelled path is still recorded via the standard OpenTelemetry `recordException` API, unchanged.

No attribute name changed or was renamed — only content removed — so no dashboard query keyed on an attribute _name_ breaks; a query that projected the _value_ of one of the four attributes above will now see it absent.
