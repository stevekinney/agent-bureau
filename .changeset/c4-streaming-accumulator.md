---
"@lostgradient/conversationalist": minor
---

Add createStreamingAccumulator for multi-part streaming: accumulates text_delta, thinking_delta, input_json_delta, and signature_delta by block index. Client `tool_use` and server `server_tool_use` blocks finalize into their own distinct content types rather than being conflated. A malformed or non-JSON tool-input buffer throws at finalize (naming the tool) instead of silently producing an empty-input tool call, so a corrupt or truncated stream is surfaced rather than masked.
