---
"conversationalist": minor
---

Add createStreamingAccumulator for multi-part streaming: accumulates text_delta, thinking_delta, input_json_delta, and signature_delta by block index. `finalize()` returns a `StreamFinalizeResult` — `{ content, toolCalls }` — so client `tool_use` blocks become `tool-call` messages (appended separately) rather than assistant content, keeping tool-call/tool-result pairing intact; server `server_tool_use` stays in `content`. A malformed or non-JSON tool-input buffer throws at finalize (naming the tool) instead of silently producing an empty-input tool call, so a corrupt or truncated stream is surfaced rather than masked.
