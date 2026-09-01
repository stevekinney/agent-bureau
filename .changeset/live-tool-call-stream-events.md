---
'@lostgradient/operative': minor
---

Expose tool-call stream events while the provider response is still open.

`withEnhancedStreaming` gains a `liveToolCalls` option that installs a new optional `StreamingHandle.report` channel, letting a `StreamingGenerateFunction` push structured events through mid-response rather than only text. The Anthropic and OpenAI streaming adapters report through it as the provider emits, so `stream:tool-call-start` and `stream:tool-call-delta` reach a host before the response closes instead of being reconstructed from the resolved `GenerateResponse` afterwards.

Additive and off by default: existing consumers see unchanged event timing and payloads, and a streaming function that reports nothing falls back to the reconstruction. Reporting is per call rather than all-or-nothing — a function that reports only some of its tool calls still gets the reconstructed sequence for the rest.

Also exports the `LiveStreamEvent` type and adds a `set-block-tool-name` variant to `StreamCommand`, which reconciles a block started before its tool name was known against the name the resolved response supplies.
