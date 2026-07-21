# Changelog

## 0.5.0

### Minor Changes

- 937bf55: Add `buildMessage` and `prependMessages` builders. `buildMessage(input, options?, environment?)` mints a standalone, schema-valid `Message` without requiring a `ConversationHistory` — useful for simulating an inbound message (e.g. an adapter push handler) or handing a pre-built message to `appendMessages`/`prependMessages`. `prependMessages(conversation, ...inputs)` mirrors `appendMessages` for the front of the list, renumbering every existing message's `position` so it stays dense and ordered across the whole `ids` array, instead of requiring callers to hand-roll `Message` construction and renumbering for history pagination.

  Also fixes a pre-existing bug where `prependSystemMessage` and `collapseSystemMessages` dropped `goalCompleted` from assistant messages while renumbering their positions.

- a526d23: Add `resolveToolResult(conversation, callId, toolResult, options?, environment?)` to replace the tool-result message for a `callId` with a new result, in place — producing exactly one tool-result message for that call afterwards. This is the primitive a host needs to turn a pending `action_required` result (appended before a run parks on approval) into the resolved result from `toolbox.resumeApproval()`, without ending up with two tool-result messages for the same call — a malformed conversation most providers reject or mishandle on the next turn.

  The message is located purely by `toolResult.callId`, scanning `conversation.messages` — never by position or an undo/redo node graph — so it behaves identically on a freshly-built conversation and one rehydrated from a persisted `ConversationHistory`. The replacement keeps the original message's `id`, `createdAt`, and `position`, and runs `environment.plugins` (e.g. PII redaction) over the replacement content, same as a freshly appended tool result. Throws `error:not-found` if no tool-result message exists for the `callId`, `error:integrity` if more than one does, and `error:invalid-input` if the supplied `toolResult.callId` disagrees with the `callId` argument. The `Conversation` class gains a matching `resolveToolResult(callId, toolResult, options?)` method.

  `resolveToolResultAsync` is the streaming counterpart — same relationship `appendToolResultAsync` has to `appendToolResult` — for resuming an approval whose tool streams its output. `Conversation` gains a matching `resolveToolResultAsync(callId, toolResult, options?)` method.

  Also hardens `validateConversationHistoryIntegrity`/`assertConversationHistoryIntegrity` with a new `integrity:duplicate-tool-result` check, so appending a second tool-result for a `callId` that already has one (the malformed shape `resolveToolResult` exists to prevent) is now caught at the append boundary too, not just when a naive resume path re-derives it.

### Patch Changes

- aa8177e: Fix `ConversationHistory` blowing TypeScript's instantiation depth (`TS2589`) when run through Svelte 5's `$state.snapshot` mapped type. The underlying `JSONValue` type (shared with `interoperability` and inlined into this package's build) now expresses its recursive array and object branches as named interfaces (`JSONArray`, `JSONObject`) instead of anonymous mapped-type literals, so TypeScript can cache the recursive instantiations instead of re-expanding them. Svelte consumers no longer need `$state.snapshot(conversation as unknown) as ConversationHistory` — a plain `$state.snapshot(conversation)` now typechecks.
- de85444: Convert `web_search_tool_result` Anthropic server-tool blocks through `toAnthropicMessagesForSdk` instead of throwing, since the installed `@anthropic-ai/sdk` accepts it as a request content block. Block types that remain response-only in the installed SDK (`code_execution_tool_result`, `bash_code_execution_tool_result`, `text_editor_code_execution_tool_result`, `web_fetch_tool_result`, `container_upload`) still throw, now with an explanatory comment documenting the SDK boundary.
- 2b6debf: Raise the declared `engines.bun` floor to `>=1.3.13` to match the Bun engine requirement declared by `@lostgradient/weft`.

## 0.4.1

### Patch Changes

- cee1695: Make the Anthropic adapters interoperate directly with the official Anthropic SDK types.

## 0.4.0

### Minor Changes

- b38dc8b: `Conversation.compact()` and `compactConversation()` now accept a structured `preservePolicy` on `CompactionOptions` (`{ pinned?, decisions?, errors? }`, all defaulting to `true`). When set, compaction preserves — regardless of recency — messages pinned via `metadata.pinned === true`, decision annotations via `metadata.decision === true`, and errors via `toolResult.outcome === 'error'` or `metadata.error === true`. Preserved messages that are half of a tool-call/tool-result pair now pull in their partner in both directions (previously only a recent tool-result pulled in its tool-call). Because these flags default to `true`, plain `compact()` calls now preserve error tool-results and pinned/decision messages that were previously summarized away — this is an intentional behavior change; pass `preservePolicy: { pinned: false, decisions: false, errors: false }` to restore the old summarize-everything-outside-the-recent-window behavior.
- 0c0dc84: `TokenUsage` gains provider-neutral `cacheCreationTokens` and `cacheReadTokens` fields, both optional and never fabricated — a provider or response with no native cache-token concept leaves them `undefined` rather than `0`.
- 49745de: `toAnthropicMessages` accepts an optional second argument, `{ extendedCacheTtl?: boolean }`. When set, every `cache_control` breakpoint lowered from a `cacheBoundary` mark opts into Anthropic's extended one-hour cache TTL (`cache_control: { type: 'ephemeral', ttl: '1h' }`) instead of the default 5-minute one. `AnthropicCacheControl` gains the matching optional `ttl?: '5m' | '1h'` field. Backward compatible — omitting the option preserves the existing 5-minute-default behavior byte-for-byte.
- 2b56d5c: Add first-class prompt-cache checkpoint metadata and a structured prompt-assembly path, closing the last gaps in making conversationalist the runner's full conversation substrate.
  - `Message`/`MessageInput` gain `cacheBoundary?: boolean` — a message-level mark that everything up to and including it is a stable, cacheable prefix. It survives JSON serialization, markdown export/import, compaction, truncation, redaction, and streaming finalize. `toAnthropicMessages` lowers it to native `cache_control: { type: 'ephemeral' }` (on the message's last content block, or as an addressable `system` block for system messages); `fromAnthropicMessages` restores it on import. OpenAI and Gemini adapters treat it as a documented no-op (both cache automatically / out-of-band, with no per-message wire field to target).
  - `sectionsToMessageInputs(composer, options)` (new export from `conversationalist/composition`) renders an `InstructionComposer`'s sections into an ordered array of individually-addressable `system`-role `MessageInput`s instead of one joined string, so callers can express stable-prefix discipline (shared contract, guidelines, task context, diff, agent role, ...) natively in the conversation. `InstructionSection` gains an optional `cacheBoundary` that carries through to its rendered message. Rendering is pure and deterministic — two assemblies of the same composer and variables are byte-identical.

  No parallel annotated-message wrapper layer was introduced; the mark lives directly on `Message`/`MessageInput`.

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
