---
'@lostgradient/operative': patch
---

Fix `generate.completed` carrying raw, pre-redaction model output when an output guardrail is configured with `action: 'redact'` (or `'block'`) (AB-302).

`GenerateCompletedEvent` is now dispatched after both output-guardrail validation stages (`RunOptions.validateResponse` and the `validateResponse` hook registry) rather than immediately after the raw provider response returns. Any consumer of this event — a live gateway subscriber over SSE or WebSocket, an OpenTelemetry span, a custom event listener — now observes the same post-guardrail content the run's final result carries, never the original flagged content. A step whose generation is entirely short-circuited by a `prepareStep` hook still never dispatches `generate.completed`, matching prior behavior.

Streaming deltas remain a separate, already-decided surface (AB-40, `packages/bureau/src/runtime-composition.ts`): bureau forces buffered, non-streaming generation whenever its auto-wired default guardrail preset is active, specifically so no delta reaches a client before the post-guardrail point; a caller supplying a custom `guardrails` config keeps streaming and its deltas remain pre-guardrail by design.
