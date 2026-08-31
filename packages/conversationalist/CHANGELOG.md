# Changelog

## 1.1.0

### Minor Changes

- 5454047: Raise the declared Bun floor from `>=1.3.13` to `>=1.4.0`.

  The repository now pins Bun 1.4.0 everywhere it builds and tests: `packageManager`, both
  CI jobs, the release workflow, and the Dockerfile. Continuing to advertise `>=1.3.13`
  would leave a claim that no gate re-verifies on any pull request, which is the failure
  mode AB-169 exists to close. The declared floor now matches the only version actually
  tested.

  Released as a minor rather than a major because `engines` is advisory: npm and Bun warn
  rather than fail unless a consumer opts into strict engine checking. No runtime, type, or
  API surface changed in any of these packages.

  Consumers still on Bun 1.3.x should upgrade or pin an exact version. The full suite did
  pass under 1.3.13 at the time of this change, so the raised floor states what is
  supported going forward rather than a known incompatibility.

  The same floor was raised on the eight private workspace packages (`bureau`,
  `cloudflare`, `evaluation`, `gateway`, `interoperability`, `lifecycle`, `memory`,
  `skills`) for internal consistency. Those are unpublished, so they carry no changeset.

## 1.0.1

### Patch Changes

- 59f7642: Stop tool-result materialization from throwing on a self-referential array. `interoperability`'s non-JSON fallback called `String()` directly, which relies on `Array.prototype.join`'s cycle guard — an engine extension rather than a spec requirement. On Bun 1.3.13 that yields `'1,2,'`; on Bun 1.4.0 it recurses until the stack overflows and a `RangeError` escapes what is supposed to be a total normalization step. Cycles are now elided before coercion, so every supported runtime produces the documented result. Circular plain objects still render as `[object Object]`, unchanged. This ships to consumers because `interoperability` is inlined into these packages at build time.
- 3c45232: Correct the Gemini adapter JSDoc examples, which demonstrated `@google/generative-ai`'s removed `getGenerativeModel()` API. They now show `@google/genai`'s `client.models.generateContent({ model, contents, config })` form, matching the SDK these packages declare.

## 1.0.0

### Major Changes

- d229843: Make public conversation state deeply immutable at runtime and replace the permissive history snapshot shape with a versioned, revisioned, integrity-protected envelope that restores strictly.
- 8bddca2: Make controller close and disposal behavior truthful, add an immutable framework-neutral external-store snapshot contract, revision-aware commands and reconciliation, abortable compaction cleanup, sequenced mutation and lifecycle events, and identity-bound transcript plugins.

### Minor Changes

- d947aad: Declare and verify Conversationalist's Bun, Node.js, browser, SvelteKit SSR, and Vercel host matrix, and add a lossy redacted projection for authorized browser and hydration payloads.

### Patch Changes

- 22de20a: Fix the published root and `conversation` entry points so they no longer leak a `node:module`/`createRequire` shim into browser bundles or a required `@anthropic-ai/sdk` type reference into strict consumers that have not installed the optional peer dependency. `AnthropicConversation` and its constituent block types now live in a dependency-free `adapters/anthropic/types` module that `history.ts` imports directly, and `interoperability`'s Node-crypto fallback reads `node:crypto` via `process.getBuiltinModule` instead of a bare `require(...)` call. This narrows the synchronous hashing helpers used internally by `interoperability` (and by `armorer`, which now declares `"node": "^20.16.0 || >=22.3.0"`) to Bun or Node.js versions with `process.getBuiltinModule`; the async `sha256Hex` remains universal via Web Crypto.

## 0.7.0

### Minor Changes

- 6f5912e: Add immutable helpers for updating, removing, hiding, and replacing tool results in conversation transcripts.

## 0.6.1

### Patch Changes

- 537e5bc: Mark `@anthropic-ai/sdk` as an optional peer dependency via `peerDependenciesMeta`. The SDK is used only by the `conversationalist/adapters/anthropic` entry point, so consumers of the core transcript API were being asked to satisfy an SDK peer for an entry point they never import. Consumers that do use the Anthropic adapter must now install `@anthropic-ai/sdk` themselves (optional peers are not auto-installed) — the adapter's README section documents this — and the declared `^0.116.0` range check still applies when they do.

  `zod` stays a **required** peer: the root entry point reaches it at runtime (`index` → `guards` → `schemas`), so it is not confined to the `conversationalist/schemas` subpath.

## 0.6.0

### Minor Changes

- 48a3f10: Add `rewindBeforePosition(conversation, position, options?)` and `rewindBeforeMessage(conversation, messageId, options?)` to `conversationalist/context`, plus matching `Conversation` methods and `withConversation` draft builders.

  Both drop the message at the boundary **and everything after it** — the branch-rewind counterpart to `truncateFromPosition`, which keeps that same tail. Edit-and-resend flows previously had no helper for this direction and hand-rolled the immutable surgery over `ids`/`messages`/`updatedAt`, which is exactly the assembly the builder API exists to avoid. `rewindBeforeMessage` is the form edit flows usually want, since an adapter command hands you the id of the edited message rather than its position.

  Positions are renumbered from zero. A tool-call/tool-result pair straddling the boundary is dropped whole by default, so a rewind never strands a call whose answer was rewound away; `preserveToolPairs: false` cuts strictly at the boundary and leaves the call pending. A boundary at or past the end returns the same conversation reference, so a no-op rewind adds no history entry and fires no events. An unknown message id is likewise a no-op.

  Existing behavior is unchanged — this is purely additive.

- 408d49d: Guard `updateStreamingMessage` against writing to a message that is no longer streaming. Previously it cloned the target message by id and applied the new content unconditionally, so a token that arrived after `finalizeStreamingMessage` — the classic late-arriving-chunk race after a user hits stop — silently grew a message the UI had already presented as final. Every consumer had to hand-roll the guard; the post-cancel half of the same race already no-opped, because `cancelStreamingMessage` removes the message outright.

  `updateStreamingMessage` now returns the conversation unchanged when the target message is not flagged as streaming, matching how it already handles an unknown message id. It stays a no-op rather than a thrown error so both halves of the race behave identically and a stop-button race cannot crash a stream. The rejected update also no longer reads `environment.now()`, so a stateful or fallible injected clock is left untouched.

  `Conversation.updateStreamingMessage` (the stateful class wrapper) rejects the same updates without recording history: when the underlying call returns the conversation it was given, the wrapper skips the commit entirely. Previously each rejected chunk still pushed an undo node and emitted `change`, `messages.updated`, and `stream.updated`, so a post-stop token flood inflated the undo stack and — under `maxHistoryDepth` — could prune real ancestors to make room for states that never differed.

  Consumers relying on the old behavior — render-side projections that reproject content onto an already-finalized message — should call `updateUnsafeStreamingMessage`, which keeps applying content regardless of streaming status and is now the documented escape hatch. Consumers with their own `shouldStop()`-style guard around `updateStreamingMessage` can drop it; the guard is now enforced at the library boundary.

- af3bb6d: Re-export `JSONValue` and `JSONPrimitive` from `interoperability` directly instead of aliasing them. The alias made the bundler emit two distinct symbols in the published declarations — the inlined original plus the alias — and only the alias was exported. Any consumer whose inferred type reached the original could not name it, which TypeScript 6 reports as TS2883. Downstream packages building against `conversationalist/schemas` were the visible casualty.

  `toJSONValue` now narrows `bigint`, `symbol`, and function inputs explicitly so each uses its own `toString` rather than falling through to a generic coercion. Output is unchanged for every input.

  Also raises the `@anthropic-ai/sdk` peer range to `^0.116.0` and `zod` to `^4.4.3`. The Anthropic bump is consumer-visible: `ToolUseBlock` gained a required `caller` field in 0.116, so code constructing those blocks by hand needs updating.

### Patch Changes

- 4141caa: `rewindBeforePosition` and `rewindBeforeMessage` now decide what survives a rewind by transcript order (`ids` order) rather than by comparing stored `message.position` values. Schema-valid histories can carry stale or sparse positions that disagree with the id order; the old position-based filter could retain messages that sit _after_ the boundary in the transcript, and tool-block preservation could keep a straddling pair alive on the strength of a stale position comparison. The boundary itself is still identified by stored position for `rewindBeforePosition` (the value a caller read off a message) and by id for `rewindBeforeMessage`; only prefix membership and tool-block extents now come from the ordered transcript. Well-formed histories — positions matching id order — behave exactly as before.

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
