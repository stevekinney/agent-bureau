---
'@lostgradient/operative': minor
---

Expose tool-call stream events while the provider response is still open.

`withEnhancedStreaming` gains a `liveToolCalls` option that installs a new optional `StreamingHandle.report` channel, letting a `StreamingGenerateFunction` push structured events through mid-response rather than only text. The Anthropic and OpenAI streaming adapters report through it as the provider emits, so `stream:tool-call-start` and `stream:tool-call-delta` reach a host before the response closes instead of being reconstructed from the resolved `GenerateResponse` afterwards.

Additive and off by default: existing consumers see unchanged event timing and payloads, and a streaming function that reports nothing falls back to the reconstruction. Also exports the `LiveStreamEvent` type.
