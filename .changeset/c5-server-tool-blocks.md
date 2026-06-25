---
"conversationalist": minor
---

Add tool_use, server_tool_use, web_search_tool_result, and code-execution result (code_execution / bash_code_execution / text_editor_code_execution) content block types with full Anthropic adapter round-trip support, so server-tool results are preserved in history instead of being dropped. The streaming accumulator also handles these result blocks (their content is seeded at content_block_start). The adapter preserves true Anthropic block order: groupable blocks (text, thinking, images, server-tool blocks) within one message round-trip as a single ordered multi-part message rather than being fragmented, while role-bearing blocks (tool_use → tool-call, tool_result → tool-result) keep their position in the sequence.
