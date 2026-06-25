---
"conversationalist": minor
---

Protocol hardening and fixes for the new content-block surface:

- **Streaming signature accumulation**: `BlockAccumulator.setSignature` is replaced by `appendSignatureDelta`, which concatenates `signature_delta` chunks instead of replacing — Anthropic may split a thinking block's signature across events, and the full value must survive byte-for-byte for extended-thinking replay.
- **No client tool-use as content**: `ToolUseContent` is removed from `MultiModalContent`. A client tool call is a `tool-call` ROLE message (so a later `tool-result` can pair to it); allowing it as assistant content created an orphaned-tool-result hazard. The streaming accumulator already routes client `tool_use` to tool-call segments.
- **Container uploads preserved**: add `ContainerUploadContent` (`container_upload`) so files uploaded into a code-execution container round-trip through the Anthropic adapter instead of being dropped.
- **Structural payload redaction**: the PII-redaction plugin now redacts string leaves inside `server_tool_use` input and `web_search_tool_result` / code-execution result content blocks — previously only role-level tool results and text parts were scrubbed, so PII in these structural blocks could be exported/persisted despite redaction being enabled.
