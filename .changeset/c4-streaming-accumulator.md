---
"conversationalist": minor
---

Add createStreamingAccumulator for multi-part streaming: accumulates text_delta, thinking_delta, input_json_delta, and signature_delta by block index, plus server-tool result blocks (web search, code execution) seeded at content_block_start. `finalize()` returns a `StreamFinalizeResult` — `{ segments }`, an ordered list where each segment is either an assistant-content run or a client tool call — so the caller appends them in order, keeping tool-call/tool-result pairing intact AND preserving true block order for interleaved sequences like `[text, tool_use, text]`. `contentOf` / `toolCallsOf` helpers are provided for when order across the content/tool boundary does not matter. An empty tool-input buffer is treated as a legitimate no-argument call (`{}`); a non-empty malformed buffer throws at finalize (naming the tool) so a corrupt or truncated stream is surfaced rather than masked.
