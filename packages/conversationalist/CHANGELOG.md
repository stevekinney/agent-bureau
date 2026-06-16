# Changelog

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
