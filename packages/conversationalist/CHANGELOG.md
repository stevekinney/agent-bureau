# Changelog

## 0.3.0

### Minor Changes

- 09c7301: Remove Conversation-owned persistence from Conversationalist. Conversation instances now remain pure state/event objects; callers should persist `Conversation.current` themselves or use Bureau/Operative session persistence. This also removes Conversationalist's direct `@lostgradient/weft` dependency.
- bc80889: Add document multimodal content with base64 and reference sources, including provider fallbacks and Anthropic document block export.
- 6aab434: Add an incremental append-log projection builder with stable-identity prefix detection.
- b44dd7a: Add unsafe streaming primitives for render-side projections that contain incomplete tool-call/tool-result pairs.

### Patch Changes

- d3ec2a6: Add runtime availability hooks for Armorer tools and propagate the new unavailable tool error category through shared tool-result schemas.

## 0.2.1

### Patch Changes

- 3472e8b: Remove workspace-only development dependencies from published package manifests and fail package-shape validation when a packed manifest leaks `workspace:` dependency ranges.

## 0.2.0

### Minor Changes

- cdf515f: Add extended-thinking content block support: ThinkingContent (preserving `signature`) and RedactedThinkingContent (preserving the encrypted `data` field, per Anthropic's block shape) in the message model, with the Anthropic adapter round-tripping both byte-for-byte. Cited text blocks also preserve their `citations` array so web-search citations survive the round-trip instead of being dropped.
- cdf515f: Add createStreamingAccumulator for multi-part streaming: accumulates text_delta, thinking_delta, input_json_delta, and signature_delta by block index, plus server-tool result blocks (web search, code execution) seeded at content_block_start. `finalize()` returns a `StreamFinalizeResult` — `{ segments }`, an ordered list where each segment is either an assistant-content run or a client tool call — so the caller appends them in order, keeping tool-call/tool-result pairing intact AND preserving true block order for interleaved sequences like `[text, tool_use, text]`. `contentOf` / `toolCallsOf` helpers are provided for when order across the content/tool boundary does not matter. An empty tool-input buffer is treated as a legitimate no-argument call (`{}`); a non-empty malformed buffer throws at finalize (naming the tool) so a corrupt or truncated stream is surfaced rather than masked.
- cdf515f: Add tool_use, server_tool_use, web_search_tool_result, and code-execution result (code_execution / bash_code_execution / text_editor_code_execution) content block types with full Anthropic adapter round-trip support, so server-tool results are preserved in history instead of being dropped. The streaming accumulator also handles these result blocks (their content is seeded at content_block_start). The adapter preserves true Anthropic block order: groupable blocks (text, thinking, images, server-tool blocks) within one message round-trip as a single ordered multi-part message rather than being fragmented, while role-bearing blocks (tool_use → tool-call, tool_result → tool-result) keep their position in the sequence.
- cdf515f: Protocol hardening and fixes for the new content-block surface:
  - **Streaming signature accumulation**: `BlockAccumulator.setSignature` is replaced by `appendSignatureDelta`, which concatenates `signature_delta` chunks instead of replacing — Anthropic may split a thinking block's signature across events, and the full value must survive byte-for-byte for extended-thinking replay.
  - **No client tool-use as content**: `ToolUseContent` is removed from `MultiModalContent`. A client tool call is a `tool-call` ROLE message (so a later `tool-result` can pair to it); allowing it as assistant content created an orphaned-tool-result hazard. The streaming accumulator already routes client `tool_use` to tool-call segments.
  - **Container uploads preserved**: add `ContainerUploadContent` (`container_upload`) so files uploaded into a code-execution container round-trip through the Anthropic adapter instead of being dropped.
  - **Structural payload redaction**: the PII-redaction plugin now redacts string leaves inside `server_tool_use` input and `web_search_tool_result` / code-execution result content blocks — previously only role-level tool results and text parts were scrubbed, so PII in these structural blocks could be exported/persisted despite redaction being enabled.

### Patch Changes

- cdf515f: Add regression tests for pluggable token estimator: custom (messages)=>number estimator drives truncation; default behavior unchanged when none supplied.
- cdf515f: Document and test the pattern for reconstructing a ConversationHistory from an append-only event log using the append and materializer helpers.

## 0.1.0

### Minor Changes

- 164f336: Allow context helpers to use custom conversation-level token estimators, including async provider tokenizers, while preserving the default heuristic estimator.

## 0.0.12

### Patch Changes

- 9f2420c: Integrate Weft 0.3.0 as the durable-execution substrate: durable recovery (#2/#3) and
  suspend/resume scheduling (#7b). Internal change with no public API surface impact.

## Unreleased

### Breaking

- Removed legacy deserialization/migration support; `deserializeConversation` now requires a full `Conversation` shape with `schemaVersion`, `ids`, and `messages` aligned.
- Removed `migrateConversation` export and compatibility shims around legacy schema formats.
- Removed legacy tool result alias fields (`toolCallId`, `toolName`, `result`, `error`); only `callId`, `outcome`, and `content` remain.
- `appendToolCall` and `appendToolResult` now use the canonical `ToolCallInput` / `ToolResult` shapes (`id`, `arguments`, `content`) so they align directly with `armorer`.
- Schema validation is now strict (unknown fields are rejected) and `jsonValueSchema` rejects non-plain objects and non-finite numbers.

### Added

- Tool-aware truncation and slicing with `preserveToolPairs` defaults.
- Integrity validation helpers: `validateConversationIntegrity` and `assertConversationIntegrity`.
- Tool interaction helpers: `appendToolCall`, `appendToolResult`, `getPendingToolCalls`, `getToolInteractions`.
- Unsafe escape hatches: `createConversationUnsafe`, `appendUnsafeMessage`.
- Tool helper input types: `ToolCallInput`, `ToolResultInput`.

### Changed

- Tool payload types are now strictly `JSONValue` for serialization safety.
- Redaction preserves tool linkage by default while redacting payloads.
- Public APIs now enforce integrity + JSON-safety at adapter, markdown, truncation, redaction, and history boundaries.
