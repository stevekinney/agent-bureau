---
'armorer': minor
---

`instrument()` (`armorer/instrumentation`) no longer calls `span.recordException(...)` for a cancelled tool call, closing a gap AB-230 left open (AB-237, grounded in AB-87's telemetry redaction column).

A cancellation error is derived from a caller-supplied abort reason and can itself carry tool-argument content — for example an `Error` whose `message` embeds the reason. Passing that `Error` to OpenTelemetry's `recordException` serializes it verbatim onto the exception event's `exception.message`/`exception.stacktrace` attributes, which leaked the reason even though AB-230's changelog claimed "a genuine `Error` on any error/cancelled path is still recorded via `recordException`, unchanged." That claim no longer holds for the cancelled path specifically — the error/denied paths are unaffected and still call `recordException` for a genuine `Error`.

On a cancellation, only the non-privileged category now reaches the span, on both `error.type` (unchanged) and a new attribute, `armorer.tool.cancellation_category`, added so a cancellation is queryable without colliding with the `error`/`denied` use of `error.type`.

If a downstream telemetry consumer read `exception.message`/`exception.stacktrace` off a cancelled tool span's exception event, that event no longer fires for cancellations; `armorer.tool.cancellation_category` (or `error.type`) is the replacement signal.

The same reason also reached `span.status.message` through a second path: a tool created without `telemetry: true` never emits `tool.finished` at all (`create-tool.ts`'s `finishTelemetry` returns early), so its cancellation was previously reported only through the toolbox-level `error` event fallback, which copied `result.error.message` verbatim onto the span status. That fallback now applies the same sanitization — a fixed `status.message` of `Cancelled` plus `error.type`/`armorer.tool.cancellation_category`, regardless of whether the tool opted into `telemetry: true`.
