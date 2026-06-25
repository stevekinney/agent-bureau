---
"conversationalist": minor
---

Add tool_use, server_tool_use, and web_search_tool_result content block types with full Anthropic adapter round-trip support. The adapter now preserves true Anthropic block order: groupable blocks (text, thinking, images, server-tool blocks) within one message round-trip as a single ordered multi-part message rather than being fragmented, while role-bearing blocks (tool_use → tool-call, tool_result → tool-result) keep their position in the sequence.
