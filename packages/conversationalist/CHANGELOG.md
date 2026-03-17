# Changelog

## Unreleased

### Breaking

- Removed legacy deserialization/migration support; `deserializeConversation` now requires a full `Conversation` shape with `schemaVersion`, `ids`, and `messages` aligned.
- Removed `migrateConversation` export and compatibility shims around legacy schema formats.
- Removed legacy tool result alias fields (`toolCallId`, `toolName`, `result`, `error`); only `callId`, `outcome`, and `content` remain.
- `appendToolUse` and `appendToolResult` now accept `toolId`/`args` and `result` payloads instead of raw `ToolCall`/`ToolResult` objects.
- Schema validation is now strict (unknown fields are rejected) and `jsonValueSchema` rejects non-plain objects and non-finite numbers.

### Added

- Tool-aware truncation and slicing with `preserveToolPairs` defaults.
- Integrity validation helpers: `validateConversationIntegrity` and `assertConversationIntegrity`.
- Tool interaction helpers: `appendToolUse`, `appendToolResult`, `getPendingToolCalls`, `getToolInteractions`.
- Unsafe escape hatches: `createConversationUnsafe`, `appendUnsafeMessage`.
- Tool helper input types: `ToolUseInput`, `ToolResultInput`.

### Changed

- Tool payload types are now strictly `JSONValue` for serialization safety.
- Redaction preserves tool linkage by default while redacting payloads.
- Public APIs now enforce integrity + JSON-safety at adapter, markdown, truncation, redaction, and history boundaries.
