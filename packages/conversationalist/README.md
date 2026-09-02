# Conversationalist

`conversationalist` manages immutable conversation state for large language model applications. It gives you a JSON-safe `ConversationHistory` data type, a mutable `Conversation` runtime for undo/redo and evented history, provider adapters for OpenAI, Anthropic, and Gemini, and serialization utilities for storage and testing.

## What It Does

- Represents conversation state as immutable, JSON-safe `ConversationHistory` values.
- Provides a mutable `Conversation` runtime for undo, redo, branching, events, and provider import/export.
- Materializes tool calls and tool results through the shared `interoperability` contracts.
- Converts conversations to and from OpenAI, Anthropic, and Gemini message formats.
- Supports streaming messages, compaction, redaction, Markdown export, templates, and deterministic test helpers.

## How It Works

Pure helper functions transform `ConversationHistory` values without side effects. The `Conversation` class wraps those helpers with evented runtime behavior for applications that need stateful history management. Provider adapters sit at the edges so the internal message model stays stable even when an external provider expects a different message shape.

Public conversation values are deeply frozen when they enter the runtime. `current`, `getSnapshot()`, history paths, events, forks, and serialized trees therefore expose the same cached object until a committed transition replaces it, without exposing a mutable alias. Validation, freezing, and snapshot serialization remain separate boundaries so callers can measure their costs independently.

`Conversation.snapshot()` returns snapshot format version 1: an integrity-protected envelope containing the conversation schema version, monotonic controller revision, tree and branch identities, strict current path, creation time, and fork/prune lineage. `Conversation.from()` accepts only this version, verifies its digest and every identity/path/revision invariant, and rejects unsupported or partial data with `error:serialization`. Version 1 is the migration floor, so there are no implicit historical snapshot migrations; a future format must add an explicit, version-pinned migration before its fixtures become supported.

## Project Role

`conversationalist` is the conversation state layer for Agent Bureau. `operative` uses it during the agent loop and to build provider payloads through its own provider adapters, `gateway` persists sessions around it, and `armorer` shares its tool-call model through `interoperability`.

## Installation

```bash
bun add conversationalist zod
```

This package is ESM-only. `zod` is a peer dependency.

## Host Support

The package manifest is the machine-readable support contract. Conversationalist supports Bun `>=1.4.0` and Node.js `^20.19.0 || ^22.12.0 || >=24`. The verified SvelteKit deployment target is `@sveltejs/adapter-vercel` on Vercel's `nodejs22.x` runtime. Controllers on servers are request-local and are not durable storage; client controllers are ephemeral projections that must reconcile with an authorized source.

| Public subpath                         | Bun | Node.js | Browser | SSR |
| -------------------------------------- | --- | ------- | ------- | --- |
| `conversationalist`                    | Yes | Yes     | Yes     | Yes |
| `conversationalist/conversation`       | Yes | Yes     | Yes     | Yes |
| `conversationalist/context`            | Yes | Yes     | Yes     | Yes |
| `conversationalist/streaming`          | Yes | Yes     | Yes     | Yes |
| `conversationalist/projection`         | Yes | Yes     | Yes     | Yes |
| `conversationalist/history`            | Yes | Yes     | Yes     | Yes |
| `conversationalist/message`            | Yes | Yes     | Yes     | Yes |
| `conversationalist/utilities`          | Yes | Yes     | Yes     | Yes |
| `conversationalist/test`               | Yes | Yes     | Yes     | Yes |
| `conversationalist/markdown`           | Yes | Yes     | No      | Yes |
| `conversationalist/export`             | Yes | Yes     | No      | Yes |
| `conversationalist/schemas`            | Yes | Yes     | Yes     | Yes |
| `conversationalist/adapters/openai`    | Yes | Yes     | Yes     | Yes |
| `conversationalist/adapters/anthropic` | Yes | Yes     | Yes     | Yes |
| `conversationalist/adapters/gemini`    | Yes | Yes     | Yes     | Yes |
| `conversationalist/redaction`          | Yes | Yes     | Yes     | Yes |
| `conversationalist/versioning`         | Yes | Yes     | Yes     | Yes |
| `conversationalist/sort`               | Yes | Yes     | Yes     | Yes |
| `conversationalist/composition`        | Yes | Yes     | Yes     | Yes |

The Markdown and export subpaths are server-only because their `gray-matter` parser needs Node-compatible Buffer behavior. The other 17 subpaths are built and executed from the exact package tarball with `process` and `Bun` absent. Provider adapters remain outside the root and conversation runtime and declaration closure until their explicit subpath is loaded; `@anthropic-ai/sdk` is an optional peer for its adapter declarations.

Use `createPublicConversationProjection()` before serializing a transcript into an SSR response or browser payload. It intentionally removes hidden messages, internal instruction roles, metadata, provider-private reasoning, tool input and results, token usage, citations, document and image references, container identifiers, and managed-asset grants. It retains only user and assistant text and always applies the package's default personal-data and credential redaction rules. Supply `redactText` to apply stricter domain-specific redaction after those defaults.

```typescript
import { createPublicConversationProjection } from 'conversationalist';

const browserHistory = createPublicConversationProjection(authoritativeConversation.current);
const serialized = JSON.stringify(browserHistory);
```

The packed consumer gate is `bun run scripts/verify-conversationalist-consumer.ts --mode local`. It verifies the manifest and tarball closure, strict TypeScript without optional provider peers, all browser-advertised exports, a full controller on Bun and Node.js, SvelteKit SSR and client build through the Vercel adapter, production preview rendering, concurrent tenant isolation, hydration primitives, and security projection exclusions.

## Quick Start

```typescript
import {
  Conversation,
  appendAssistantMessage,
  appendUserMessage,
  createConversationHistory,
} from 'conversationalist';

let history = createConversationHistory({
  title: 'Order Support',
  metadata: { orderId: 'ord_123' },
});

history = appendUserMessage(history, 'Where is my order?');
history = appendAssistantMessage(history, 'Let me look that up.');

const conversation = new Conversation(history);
const openAIRequest = await conversation.toProvider('openai');
```

## Core Model

- **`ConversationHistory`**: immutable, JSON-safe conversation data.
- **`Conversation`**: runtime history manager with undo, redo, branching, event emission, provider import/export helpers, and convenience wrappers around the immutable helpers.
- **`Message`**: ordered conversation entry with roles such as `user`, `assistant`, `system`, `developer`, `tool-call`, `tool-result`, and `snapshot`.
- **`ToolCall`** and **`ToolResult`**: canonical, JSON-safe tool interaction payloads shared with `armorer` through `interoperability`.

## Updating a Transcript

Use the immutable mutation helpers when a user edits a message, a row leaves the transcript, visibility changes, or a pending tool approval resolves. Each helper returns a validated `ConversationHistory`; the history and messages you pass in stay untouched.

```typescript
import {
  appendMessages,
  createConversationHistory,
  removeMessage,
  replaceToolResult,
  setMessageHidden,
  updateMessage,
} from 'conversationalist';

let history = appendMessages(
  createConversationHistory(),
  { role: 'user', content: 'Look up account acct_123.' },
  { role: 'assistant', content: 'I can do that.' },
  {
    role: 'tool-call',
    content: '',
    toolCall: { id: 'call-account', name: 'lookupAccount', arguments: { id: 'acct_123' } },
  },
  {
    role: 'tool-result',
    content: '',
    toolResult: { callId: 'call-account', outcome: 'action_required', content: null },
  },
);

const [userMessageId, assistantMessageId] = history.ids;

history = updateMessage(history, userMessageId!, {
  content: 'Look up account acct_456.',
  metadata: { edited: true },
});
history = setMessageHidden(history, assistantMessageId!, true);
history = replaceToolResult(history, 'call-account', {
  callId: 'call-account',
  outcome: 'success',
  content: { status: 'active' },
});
history = removeMessage(history, assistantMessageId!);
```

`updateMessage` preserves the message identifier, role, position, creation time, assistant completion state, and all tool identifiers; explicitly setting `tokenUsage` or `cacheBoundary` to `undefined` clears that optional field. `updateMessage`, `setMessageHidden`, and `replaceToolResult` run configured message plugins and apply the complete processed mutable payload. That preserves cross-field policies such as hiding newly blocked content or clearing sensitive tool data. Message plugins used by mutation helpers must be deterministic, side-effect-free, and idempotent. The helpers verify repeatable and idempotent output for both the stored and updated inputs, rejecting invalid plugins rather than reprocessing unchanged values. `removeMessage` closes the position gap left by the removed row. `replaceToolResult` targets the result paired with a tool-call identifier and rejects a caller or plugin result whose `callId` differs from that target. Plugin-processed tool calls and results must retain their existing identifiers. Passing an unknown message or tool-call identifier is a no-op, so event handlers can safely ignore stale work.

## Rebuilding From an Append-Only Event Log

If your worker stores durable transcript rows instead of a serialized `ConversationHistory`, replay those rows through the immutable append helpers after a restart. The helpers rebuild the ordered message list and validate that every tool result references an earlier tool call.

```typescript
import {
  appendAssistantMessage,
  appendToolCalls,
  appendToolResults,
  appendUserMessage,
  createConversationHistory,
  getToolInteractions,
  type AppendableToolCallInput,
  type AppendableToolResult,
  type ConversationHistory,
  type JSONValue,
} from 'conversationalist';

type TranscriptEventRow =
  | {
      sequence: number;
      messageId: string;
      createdAt: string;
      kind: 'user' | 'assistant';
      content: string;
      metadata?: Record<string, JSONValue>;
    }
  | {
      sequence: number;
      messageId: string;
      createdAt: string;
      kind: 'tool-call';
      toolCall: AppendableToolCallInput;
    }
  | {
      sequence: number;
      messageId: string;
      createdAt: string;
      kind: 'tool-result';
      toolResult: AppendableToolResult;
    };

function replayTranscriptRows(rows: readonly TranscriptEventRow[]): ConversationHistory {
  const seenSequences = new Set<number>();
  const orderedRows = [...rows].sort((left, right) => left.sequence - right.sequence);
  const firstRow = orderedRows[0];
  let conversation = createConversationHistory(
    {
      title: 'Durable activity transcript',
    },
    {
      now: () => firstRow?.createdAt ?? new Date(0).toISOString(),
      randomId: () => (firstRow ? `conversation-${firstRow.messageId}` : 'empty-transcript'),
    },
  );

  for (const row of orderedRows) {
    if (seenSequences.has(row.sequence)) {
      throw new Error(`Duplicate transcript sequence: ${row.sequence}`);
    }
    seenSequences.add(row.sequence);

    const environment = {
      now: () => row.createdAt,
      randomId: () => row.messageId,
    };

    switch (row.kind) {
      case 'user': {
        conversation = appendUserMessage(conversation, row.content, row.metadata, environment);
        break;
      }
      case 'assistant': {
        conversation = appendAssistantMessage(conversation, row.content, row.metadata, environment);
        break;
      }
      case 'tool-call': {
        conversation = appendToolCalls(conversation, [row.toolCall], environment);
        break;
      }
      case 'tool-result': {
        conversation = appendToolResults(conversation, [row.toolResult], environment);
        break;
      }
    }
  }

  return conversation;
}

const rows: TranscriptEventRow[] = [
  {
    sequence: 1,
    messageId: 'message-user-1',
    createdAt: '2026-06-24T12:00:00.000Z',
    kind: 'user',
    content: 'Find the account status.',
  },
  {
    sequence: 2,
    messageId: 'message-tool-call-1',
    createdAt: '2026-06-24T12:00:01.000Z',
    kind: 'tool-call',
    toolCall: {
      id: 'tool-call-account-1',
      name: 'lookupAccount',
      arguments: { accountId: 'acct_123' },
    },
  },
  {
    sequence: 3,
    messageId: 'message-tool-result-1',
    createdAt: '2026-06-24T12:00:02.000Z',
    kind: 'tool-result',
    toolResult: {
      callId: 'tool-call-account-1',
      outcome: 'success',
      content: { status: 'active' },
    },
  },
];

const conversation = replayTranscriptRows(rows);
const orderedMessages = conversation.ids.map((id) => conversation.messages[id]);
const interactions = getToolInteractions(conversation);

console.assert(
  orderedMessages.map((message) => message.id).join(',') ===
    rows.map((row) => row.messageId).join(','),
);
console.assert(interactions.length === 1);
console.assert(interactions.every(({ call, result }) => call.id === result?.callId));
```

The `sequence` column is the replay authority. The message identifier and timestamp hooks keep the rebuilt `ConversationHistory` aligned with the external event rows, while the tool-call identifier remains the durable key that pairs every tool result with its call across process restarts.

## Incremental Projection During Streaming

Use `createProjection` when a UI receives the complete event log on every SSE frame. The projection owns the processed-count cursor: prefix extensions reduce only the new tail, while reconnects, reloads, or session switches reset to the seed and refold the supplied log.

```typescript
import {
  appendUserMessage,
  createConversationHistory,
  createProjection,
  type ConversationHistory,
} from 'conversationalist';
import {
  appendUnsafeStreamingMessage,
  finalizeUnsafeStreamingMessage,
  updateUnsafeStreamingMessage,
} from 'conversationalist/streaming';

type StreamEvent =
  | { id: string; kind: 'user.message'; content: string }
  | { id: string; kind: 'assistant.delta'; delta: string }
  | { id: string; kind: 'assistant.done' };

type ProjectionState = {
  assistantMessageId?: string;
  assistantText: string;
};

const projection = createProjection<StreamEvent, ProjectionState>({
  seed: createConversationHistory({ title: 'Live transcript' }),
  initialState: () => ({ assistantText: '' }),
  identify: (event) => event.id,
  reduce({ conversation, event, state }) {
    switch (event.kind) {
      case 'user.message':
        return {
          conversation: appendUserMessage(conversation, event.content),
          state,
        };
      case 'assistant.delta': {
        let nextConversation: ConversationHistory = conversation;
        let messageId = state.assistantMessageId;
        if (!messageId) {
          const appended = appendUnsafeStreamingMessage(nextConversation, 'assistant');
          nextConversation = appended.conversation;
          messageId = appended.messageId;
        }

        const assistantText = state.assistantText + event.delta;
        return {
          conversation: updateUnsafeStreamingMessage(nextConversation, messageId, assistantText),
          state: { assistantMessageId: messageId, assistantText },
        };
      }
      case 'assistant.done':
        return state.assistantMessageId
          ? {
              conversation: finalizeUnsafeStreamingMessage(conversation, state.assistantMessageId),
              state: { assistantText: '' },
            }
          : { conversation, state };
    }
  },
});

for await (const events of streamTranscriptEvents()) {
  projection.apply(events);
  renderConversation(projection.snapshot());
}
```

`identify` must return a stable event identity such as a durable event id or sequence number. The projection compares those identities, not array references or event object references, so reactive proxies from frameworks such as Svelte or Vue can pass fresh proxied arrays without triggering unnecessary refolds.

Keep a pure full rebuild in tests and assert it deep-equals the incremental snapshots after each chunk. That equivalence check is the guardrail: if `projection.apply(eventsSoFar); projection.snapshot()` ever differs from rebuilding from an empty seed over `eventsSoFar`, the reducer or event identity contract is wrong.

## Package Structure

### `conversationalist` (root)

The primary runtime API. Imports the `Conversation` class, all immutable helpers, errors, guards, and types.

```typescript
import {
  Conversation,
  appendAssistantMessage,
  appendSystemMessage,
  appendToolCalls,
  appendToolResultsAsync,
  appendUserMessage,
  createConversationHistory,
  deserializeConversationHistory,
  getPendingToolCalls,
  hasSystemMessage,
  pipeConversationHistory,
  prependSystemMessage,
  removeMessage,
  replaceToolResult,
  setMessageHidden,
  updateMessage,
  validateConversationHistoryIntegrity,
  withConversationHistory,
} from 'conversationalist';
```

**Key exports:**

- `Conversation`—the runtime class with undo/redo/branching/events.
- `createConversationHistory(options?)`—creates an empty, valid `ConversationHistory`.
- `createConversationHistoryUnsafe(data)`—skips validation; use only when you control the input.
- `deserializeConversationHistory(raw)`—parses and validates a stored JSON blob.
- Append helpers: `appendMessages`, `appendUserMessage`, `appendAssistantMessage`, `appendSystemMessage`, `appendUnsafeMessage`.
- System-message helpers: `hasSystemMessage`, `getSystemMessages`, `getFirstSystemMessage`, `prependSystemMessage`, `replaceSystemMessage`, `collapseSystemMessages`.
- Query helpers: `getMessages`, `getMessageById`, `getMessageAtPosition`, `getMessageIds`, `getStatistics`, `searchConversationMessages`, `toChatMessages`.
- Tool helpers: `appendToolCall`, `appendToolCalls`, `appendToolResult`, `appendToolResultAsync`, `appendToolResults`, `appendToolResultsAsync`, `getPendingToolCalls`, `getToolInteractions`.
- Materializer helpers: `materializeToolCall`, `materializeToolCalls`, `materializeToolResult`, `materializeToolResultAsync`, `materializeToolResults`, `materializeToolResultsAsync`.
- Validation: `validateConversationHistoryIntegrity`, `assertConversationHistoryIntegrity`.
- Builder helpers: `withConversationHistory`, `pipeConversationHistory`.
- Projection helpers: `createProjection`, `isProjectionPrefixExtension`.
- Mutation helpers: `updateMessage`, `removeMessage`, `setMessageHidden`, `replaceToolResult`, `redactMessageAtPosition`.
- Guards: `isConversation`, `isConversationHistory`, `isMessage`, `isToolCall`, `isToolResult`, and more.
- Error constructors: `ConversationalistError`, `createNotFoundError`, `createValidationError`, and others.
- Composition exports: `createInstructionComposer`, `createInstructionTemplate`, `createConditionalInstructionComposer`, `whenStep`, `whenToolsAvailable`, `whenAnyToolAvailable`, `whenMetadata`, `whenMetadataPresent`.
- Event classes: `ConversationChangeEvent`, `ConversationPushEvent`, `MessagesAppendedEvent`, `StreamStartedEvent`, `StreamFinalizedEvent`, and others.

**AB-70 portable content and modality vocabulary (type-only):** `Modality`, `MimeFamily`, `MediaLimitScope`, `MediaLimits`, `ContentSource`, and `ModalityMatrix`, defined in `src/multi-modal.ts` and re-exported from the root. These are additive names for other packages (notably `@lostgradient/operative`'s `BackendDescriptor`) to cite, and do not replace `MultiModalContent`, `ImageContent`, `DocumentContent`, or `DocumentSource`, which stay as they are.

---

### `conversationalist/conversation`

Pure immutable conversation helpers with no `Conversation` class dependency. Use this subpath in libraries or server contexts where you want functional transforms over data.

```typescript
import {
  appendUserMessage,
  appendAssistantMessage,
  createConversationHistory,
  getPendingToolCalls,
  getSystemMessages,
  prependSystemMessage,
  removeMessage,
  replaceToolResult,
  searchConversationMessages,
  setMessageHidden,
  updateMessage,
  validateConversationHistoryIntegrity,
} from 'conversationalist/conversation';
```

**Key exports:** `createConversationHistory`, `createConversationHistoryUnsafe`, `appendMessages`, `appendUserMessage`, `appendAssistantMessage`, `appendSystemMessage`, `appendUnsafeMessage`, `updateMessage`, `removeMessage`, `setMessageHidden`, `replaceToolResult`, `getMessages`, `getMessageById`, `getMessageAtPosition`, `getMessageIds`, `getStatistics`, `searchConversationMessages`, `getSystemMessages`, `getFirstSystemMessage`, `hasSystemMessage`, `prependSystemMessage`, `replaceSystemMessage`, `collapseSystemMessages`, `redactMessageAtPosition`, `deserializeConversationHistory`, `validateConversationHistoryIntegrity`, `assertConversationHistoryIntegrity`, `toChatMessages`, `appendToolCall`, `appendToolCalls`, `appendToolResult`, `appendToolResultAsync`, `appendToolResults`, `appendToolResultsAsync`, `getPendingToolCalls`, `getToolInteractions`, `materializeToolCall`, `materializeToolCalls`, `materializeToolResult`, `materializeToolResultAsync`, `materializeToolResults`, `materializeToolResultsAsync`, `withEnvironment`.

---

### `conversationalist/history`

The `Conversation` runtime class and its event types.

```typescript
import { Conversation } from 'conversationalist/history';
import type {
  ConversationActionType,
  ConversationEvent,
  ConversationEventType,
} from 'conversationalist/history';

const conversation = new Conversation();
conversation.appendUserMessage('Hello');

const previous = conversation.undo(); // ConversationHistory | undefined
if (previous) {
  console.log('Undone');
}

conversation.on('change', ({ detail }) => {
  console.log('New history:', detail.current);
});
```

**Key exports:** `Conversation`, `ConversationActionType`, `ConversationEvent`, `ConversationEventDetail`, `ConversationEvents`, `ConversationEventType`.

---

### `conversationalist/context`

Context-window management helpers that estimate token counts and trim messages to fit within limits.

```typescript
import {
  estimateConversationTokens,
  getRecentMessages,
  rewindBeforeMessage,
  rewindBeforePosition,
  simpleTokenEstimator,
  truncateFromPosition,
  truncateToTokenLimit,
} from 'conversationalist/context';

// Estimate total tokens in a conversation
const tokens = estimateConversationTokens(history);

// Use a provider tokenizer when budget math must match the model.
const providerTokens = await estimateConversationTokens(history, {
  async estimateConversationTokens(messages) {
    return countWithProviderTokenizer(messages);
  },
});

// Trim to fit a 4096-token context window
const trimmed = truncateToTokenLimit(history, 4096, {
  preserveSystemMessages: true,
  preserveLastN: 4,
  preserveToolPairs: true,
});

const providerTrimmed = await truncateToTokenLimit(history, 4096, {
  async estimateConversationTokens(messages) {
    return countWithProviderTokenizer(messages);
  },
  preserveLastN: 4,
});

// Get the 10 most recent non-system messages
const recent = getRecentMessages(history, 10);

// Drop everything before position 20
const sliced = truncateFromPosition(history, 20);

// Rewind a branch: drop position 20 and everything after it. The mirror image
// of truncateFromPosition, which keeps that same tail.
const rewound = rewindBeforePosition(history, 20);

// Edit flows usually hold a message id rather than a position.
const beforeEdit = rewindBeforeMessage(history, editedMessageId);
```

The two directions are easy to confuse, so pick by what you are trying to do:

| Goal                                        | Helper                                        | Drops  |
| ------------------------------------------- | --------------------------------------------- | ------ |
| Fit a context window                        | `truncateToTokenLimit`, `getRecentMessages`   | Oldest |
| Keep only the tail from a point onwards     | `truncateFromPosition`                        | Oldest |
| Undo a branch (edit-and-resend, regenerate) | `rewindBeforePosition`, `rewindBeforeMessage` | Newest |

Both rewind helpers renumber positions from zero and keep `ids`/`messages`/`updatedAt` consistent, so edit flows never assemble a `ConversationHistory` by hand. A tool-call/tool-result pair straddling the boundary is dropped whole by default; pass `preserveToolPairs: false` to cut strictly at the boundary and leave the call pending. A boundary at or past the end returns the same conversation reference, so a no-op rewind adds no history entry.

**Key exports:** `estimateConversationTokens`, `truncateToTokenLimit`, `getRecentMessages`, `truncateFromPosition`, `rewindBeforePosition`, `rewindBeforeMessage`, `simpleTokenEstimator`. Also exports `EstimateConversationTokensOptions`, `AsyncEstimateConversationTokensOptions`, `TruncateOptions`, `AsyncTruncateOptions`, and `RewindOptions` types.

---

### `conversationalist/streaming`

Streaming-message helpers for building real-time assistant responses token by token.

```typescript
import {
  appendStreamingMessage,
  appendUnsafeStreamingMessage,
  cancelStreamingMessage,
  finalizeUnsafeStreamingMessage,
  finalizeStreamingMessage,
  getStreamingMessage,
  isStreamingMessage,
  updateUnsafeStreamingMessage,
  updateStreamingMessage,
} from 'conversationalist/streaming';

// Start a streaming placeholder
let { conversation, messageId } = appendStreamingMessage(history, 'assistant');

// Accumulate tokens as they arrive
for await (const chunk of stream) {
  conversation = updateStreamingMessage(conversation, messageId, accumulatedText);
}

// Mark complete with optional token usage
conversation = finalizeStreamingMessage(conversation, messageId, {
  tokenUsage: { prompt: 120, completion: 48, total: 168 },
});

// Or cancel on error
conversation = cancelStreamingMessage(conversation, messageId);
```

**Key exports:** `appendStreamingMessage`, `appendUnsafeStreamingMessage`, `updateStreamingMessage`, `updateUnsafeStreamingMessage`, `finalizeStreamingMessage`, `finalizeUnsafeStreamingMessage`, `cancelStreamingMessage`, `isStreamingMessage`, `getStreamingMessage`.

Streaming messages (those with `metadata.__streaming === true`) are automatically protected from compaction, truncation, and adapter export until finalized.
`updateStreamingMessage` only writes to a message that is still streaming: once the message has been finalized (or cancelled, which removes it outright), the call returns the conversation unchanged. That makes the late-token race — a chunk that lands after the user hits stop — a no-op instead of silently growing a message the UI already froze, so consumers no longer need their own guard. The `Conversation` method of the same name rejects those updates without recording history either: no undo entry is added and no `change` / `messages.updated` / `stream.updated` event fires, so a post-stop token flood cannot inflate the undo stack.
Use the unsafe variants only for render-side projections that may contain incomplete tool-call/tool-result pairs, such as partial transcript windows or approval placeholders. `updateUnsafeStreamingMessage` also skips the streaming-status check, so it stays the explicit escape hatch for reprojecting content onto an already-finalized message.

---

### `conversationalist/projection`

Incremental projection helpers for turning cumulative append-only event logs into render-ready conversation snapshots.

```typescript
import { createProjection, isProjectionPrefixExtension } from 'conversationalist/projection';
```

**Key exports:** `createProjection`, `isProjectionPrefixExtension`. Also exports `Projection`, `ProjectionEventIdentity`, `ProjectionOptions`, `ProjectionReducer`, `ProjectionReducerContext`, and `ProjectionReducerResult` types.

The prefix check compares stable event identities only. Use durable event ids or sequence numbers rather than object references so reactive framework proxies remain safe.

---

### `conversationalist/message`

Utility functions for inspecting and formatting individual `Message` objects.

```typescript
import {
  createMessage,
  isAssistantMessage,
  messageHasImages,
  messageParts,
  messageText,
  messageToString,
} from 'conversationalist/message';

const text = messageText(message);
const parts = messageParts(message); // ReadonlyArray<MultiModalContent>
const hasImages = messageHasImages(message);
```

**Key exports:** `createMessage`, `messageToJSON`, `messageParts`, `messageText`, `messageHasImages`, `messageToString`, `isAssistantMessage`.

---

### `conversationalist/utilities`

Lower-level helpers for content normalization, tool-call pairing, transient metadata, and type-safe object operations.

```typescript
import {
  normalizeContent,
  pairToolCallsWithResults,
  stripTransientMetadata,
  toMultiModalArray,
} from 'conversationalist/utilities';
```

**Key exports:** `normalizeContent`, `toMultiModalArray`, `pairToolCallsWithResults`, `stripTransientMetadata`, `isTransientKey`, `stripTransientFromRecord`, `hasOwnProperty`, `toReadonly`. Also re-exports materializer helpers and `MaterializeToolCallOptions` type.

---

### `conversationalist/markdown`

Round-trip Markdown serialization. Converts a conversation to Markdown for display or storage, and parses Markdown back into a `ConversationHistory`.

```typescript
import {
  conversationFromMarkdown,
  conversationToMarkdown,
  fromMarkdown,
  getRoleLabel,
  toMarkdown,
} from 'conversationalist/markdown';

// From a Conversation instance
const md = conversationToMarkdown(conversation);

// From raw ConversationHistory
const md2 = toMarkdown(history);

// Parse Markdown back into a Conversation
const restored = conversationFromMarkdown(md);

// Parse Markdown into raw ConversationHistory
const rawHistory = fromMarkdown(md2);
```

**Key exports:** `toMarkdown`, `fromMarkdown`, `conversationToMarkdown`, `conversationFromMarkdown`, `getRoleLabel`, `getRoleFromLabel`, `ROLE_LABELS`, `LABEL_TO_ROLE`, `MarkdownParseError`. Also exports `ToMarkdownOptions` type.

---

### `conversationalist/export`

Export helpers that normalize line endings for cross-platform file output.

```typescript
import { exportMarkdown, normalizeLineEndings } from 'conversationalist/export';

const file = exportMarkdown(history, { includeMetadata: true });
await Bun.write('transcript.md', file);
```

**Key exports:** `exportMarkdown`, `normalizeLineEndings`.

---

### `conversationalist/schemas`

Zod runtime validation schemas for all core types. Use these to validate external data before constructing `ConversationHistory` values.

```typescript
import {
  conversationSchema,
  messageSchema,
  toolCallSchema,
  toolResultSchema,
} from 'conversationalist/schemas';

const result = conversationSchema.safeParse(rawData);
if (!result.success) {
  console.error(result.error.flatten());
}
```

**Key exports:** `jsonValueSchema`, `multiModalContentSchema`, `messageRoleSchema`, `toolCallSchema`, `toolCallInputSchema`, `toolErrorCategorySchema`, `toolErrorSchema`, `toolActionSchema`, `toolResultSchema`, `tokenUsageSchema`, `messageInputSchema`, `messageSchema`, `conversationStatusSchema`, `conversationShape`, `conversationSchema`.

---

### `conversationalist/redaction`

PII redaction plugin. Scans assistant and user message text and replaces sensitive patterns with placeholder tokens.

```typescript
import {
  createPIIRedaction,
  createPIIRedactionPlugin,
  DEFAULT_PII_RULES,
  redactPii,
} from 'conversationalist/redaction';

// Use the pre-built default plugin (redacts emails, phone numbers, and API keys/secrets)
const conversation = new Conversation(history, {
  plugins: [redactPii],
});

// Or define custom rules
const customPlugin = createPIIRedactionPlugin({
  rules: [{ pattern: /\b\d{9}\b/g, replacement: '[ID_REDACTED]' }],
});

// Or use the lower-level redaction function directly
const redact = createPIIRedaction();
const clean = redact('Call me at 555-123-4567');
// 'Call me at [PHONE_REDACTED]'
```

**Key exports:** `createPIIRedaction`, `createPIIRedactionPlugin`, `redactPii`, `DEFAULT_PII_RULES`. Also exports `PIIRedactionRule` and `PIIRedactionOptions` types.

---

### `conversationalist/versioning`

Schema version constant for serialization compatibility checks.

```typescript
import { CURRENT_SCHEMA_VERSION } from 'conversationalist/versioning';

console.log(CURRENT_SCHEMA_VERSION); // e.g. 1
```

**Key exports:** `CURRENT_SCHEMA_VERSION`.

---

### `conversationalist/sort`

Deterministic sort helpers for consistent ordering and snapshot comparisons.

```typescript
import { sortMessagesByPosition, sortObjectKeys } from 'conversationalist/sort';

const ordered = sortMessagesByPosition([...messages]);
const stable = sortObjectKeys(obj); // alphabetically sorted copy
```

**Key exports:** `sortMessagesByPosition`, `sortObjectKeys`.

---

### `conversationalist/composition`

System-prompt composition helpers. Build rich, context-aware instruction strings from typed sections, templates, and conditional blocks.

```typescript
import {
  createConditionalInstructionComposer,
  createInstructionComposer,
  createInstructionTemplate,
  extractTemplateVariables,
  renderTemplate,
  whenAnyToolAvailable,
  whenMetadata,
  whenStep,
  whenToolsAvailable,
} from 'conversationalist/composition';

// Static instruction composer
const composer = createInstructionComposer([
  { heading: 'Role', content: 'You are a helpful assistant.' },
  { heading: 'Rules', content: 'Be concise.' },
]);

const systemPrompt = await composer.render({ step: 0, metadata: {} });

// Template with variable interpolation
const template = createInstructionTemplate('You are assisting {{userName}} on step {{step}}.');
const rendered = renderTemplate(template, { userName: 'Alice', step: '1' });

// Conditional sections—only included when their predicate passes
const conditionalComposer = createConditionalInstructionComposer([
  whenStep(0, { heading: 'Welcome', content: 'Welcome! Here is how I can help.' }),
  whenToolsAvailable(['search', 'read-file'], {
    heading: 'Available tools',
    content: 'You may search the web and read files.',
  }),
  whenAnyToolAvailable({ heading: 'Tools', content: 'You have tools available.' }),
  whenMetadata('mode', 'strict', { heading: 'Strict mode', content: 'Follow all rules exactly.' }),
]);
```

**Key exports:** `createInstructionComposer`, `createInstructionTemplate`, `createConditionalInstructionComposer`, `renderTemplate`, `extractTemplateVariables`, `whenStep`, `whenToolsAvailable`, `whenAnyToolAvailable`, `whenMetadata`, `whenMetadataPresent`. Also exports types `InstructionComposer`, `InstructionSection`, `InstructionComposerRenderOptions`, `InstructionTemplate`, `MissingVariableStrategy`, `TemplateOptions`, `ConditionalInstructionComposer`, `ConditionalInstructionSection`, `ConditionalInstructionComposerRenderOptions`, `InstructionContext`.

---

### `conversationalist/adapters/openai`

OpenAI Chat Completions message format adapter.

```typescript
import {
  appendOpenAIMessages,
  fromOpenAIMessages,
  openAIConversationAdapter,
  toOpenAIMessages,
  toOpenAIMessagesGrouped,
} from 'conversationalist/adapters/openai';
import type { OpenAIMessage } from 'conversationalist/adapters/openai';

// Export to OpenAI format
const messages = toOpenAIMessages(history);

// Group tool-call and tool-result pairs (preferred for most providers)
const grouped = toOpenAIMessagesGrouped(history);

// Import from OpenAI format
const imported = fromOpenAIMessages(openAIMessages);

// Append new OpenAI messages to an existing history
const updated = appendOpenAIMessages(history, newMessages);

// Use with Conversation.fromProvider / conversation.toProvider
const restored = await Conversation.fromProvider('openai', { messages: openAIMessages });
```

**Key exports:** `toOpenAIMessages`, `toOpenAIMessagesGrouped`, `fromOpenAIMessages`, `appendOpenAIMessages`, `openAIConversationAdapter`. Type exports: `OpenAIMessage`, `OpenAISystemMessage`, `OpenAIUserMessage`, `OpenAIAssistantMessage`, `OpenAIToolMessage`, `OpenAIToolCall`, `OpenAIContentPart`, `OpenAITextContentPart`, `OpenAIImageContentPart`, `OpenAIConversationExportOptions`.

---

### `conversationalist/adapters/anthropic`

Anthropic Messages API format adapter.

`@anthropic-ai/sdk` is an **optional** peer dependency — it is not installed
automatically, and only this entry point needs it. Install it alongside
conversationalist before importing the adapter (the SDK-typed exports such as
`AnthropicSdkConversation` resolve their types from it):

```bash
bun add @anthropic-ai/sdk
```

```typescript
import {
  appendAnthropicMessages,
  anthropicConversationAdapter,
  fromAnthropicMessages,
  toAnthropicMessages,
} from 'conversationalist/adapters/anthropic';
import type { AnthropicConversation } from 'conversationalist/adapters/anthropic';

const payload = toAnthropicMessages(history);
// payload.system: string, payload.messages: AnthropicMessage[]

const imported = fromAnthropicMessages(payload);
const updated = appendAnthropicMessages(history, payload);
```

**Key exports:** `toAnthropicMessages`, `fromAnthropicMessages`, `appendAnthropicMessages`, `anthropicConversationAdapter`. Type exports: `AnthropicConversation`, `AnthropicMessage`, `AnthropicContentBlock`, `AnthropicTextBlock`, `AnthropicToolUseBlock`, `AnthropicToolResultBlock`, `AnthropicImageBlock`, `AnthropicImageSource`, `AnthropicBase64ImageSource`, `AnthropicUrlImageSource`.

---

### `conversationalist/adapters/gemini`

Google Gemini API format adapter.

```typescript
import {
  appendGeminiMessages,
  fromGeminiMessages,
  geminiConversationAdapter,
  toGeminiMessages,
} from 'conversationalist/adapters/gemini';
import type { GeminiConversation } from 'conversationalist/adapters/gemini';

const payload = toGeminiMessages(history);
// payload.contents: GeminiContent[]

const imported = fromGeminiMessages(payload);
const updated = appendGeminiMessages(history, payload);
```

**Key exports:** `toGeminiMessages`, `fromGeminiMessages`, `appendGeminiMessages`, `geminiConversationAdapter`. Type exports: `GeminiConversation`, `GeminiContent`, `GeminiPart`, `GeminiTextPart`, `GeminiInlineDataPart`, `GeminiFileDataPart`, `GeminiFunctionCallPart`, `GeminiFunctionResponsePart`.

---

### `conversationalist/test`

Deterministic test environments with fixed clocks and IDs, prebuilt test conversations, and event recorders.

```typescript
import {
  createConversationRecorder,
  createTestConversation,
  createTestConversationEnvironment,
  createTestInstructionContext,
} from 'conversationalist/test';

// Deterministic clock + ID generator—no random values in snapshots.
// `now` returns an ISO string; `identifiers` supplies the deterministic id sequence.
const env = createTestConversationEnvironment({
  now: () => '2024-01-01T00:00:00.000Z',
  identifiers: ['id-1', 'id-2', 'id-3'],
});

// Test conversation in a deterministic environment. The first argument is an
// optional initial ConversationHistory; the second is the same options object.
const conversation = createTestConversation(undefined, {
  now: () => '2024-01-01T00:00:00.000Z',
});

// Collect all events emitted during a test
const recorder = createConversationRecorder(conversation);
conversation.appendUserMessage('Hello');
console.log(recorder.events); // [{ type: 'change', ... }, ...]
recorder.clear();

// Instruction rendering context for testing composition helpers
const context = createTestInstructionContext({ step: 0, metadata: { mode: 'strict' } });
```

**Key exports:** `createTestConversationEnvironment`, `createTestConversation`, `createConversationRecorder`. Types: `TestConversationEnvironmentOptions`, `TestConversationEnvironment`, `ConversationRecorder`.

Also exports `createTestInstructionContext`.

---

## Provider Conversion

### Generic provider helpers

```typescript
import { Conversation } from 'conversationalist';

const conversation = new Conversation();

const openAIPayload = await conversation.toProvider('openai');
const anthropicPayload = await conversation.toProvider('anthropic');

await conversation.appendProvider('openai', [{ role: 'user', content: 'Hello' }]);

const restored = await Conversation.fromProvider('gemini', {
  contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
});
```

### Provider-specific convenience methods

`Conversation` also exposes:

- `Conversation.fromOpenAIMessages(...)`
- `Conversation.fromAnthropicMessages(...)`
- `Conversation.fromGeminiMessages(...)`
- `conversation.toOpenAIMessages()`
- `conversation.toOpenAIMessagesGrouped()`
- `conversation.toAnthropicMessages()`
- `conversation.toGeminiMessages()`

## Tool Interoperability

`conversationalist` is designed to pair naturally with `armorer`.

```typescript
import { appendToolCalls, appendToolResultsAsync } from 'conversationalist';
import { createToolbox } from 'armorer';
import { parseOpenAIToolCalls, toOpenAITools } from 'armorer/adapters/openai';

const toolbox = createToolbox();
const tools = await toolbox.toProvider('openai');
const toolCalls = parseOpenAIToolCalls(response);

conversationHistory = appendToolCalls(conversationHistory, toolCalls);

const results = await toolbox.execute(toolCalls, { stream: true });
conversationHistory = await appendToolResultsAsync(conversationHistory, results);
```

Shared tool types and materializers are provided by `interoperability` and re-exported by both packages.

## Events

`Conversation` is both a framework-neutral external store and a typed event source. Store subscriptions never start work or invoke the listener during setup, so the standard read-subscribe-read pattern closes the setup race and React Strict Mode setup-cleanup-setup remains safe:

```typescript
const conversation = new Conversation(initialHistory);
const before = conversation.getSnapshot();
const unsubscribe = conversation.subscribe(() => {
  const next = conversation.getSnapshot();
  render(next.conversation, next.revision, next.lifecycle);
});
const after = conversation.getSnapshot();
if (after !== before) render(after.conversation, after.revision, after.lifecycle);

const serverSnapshot = conversation.getServerSnapshot();
JSON.stringify(serverSnapshot);

unsubscribe();
conversation.complete();
await conversation.dispose();
```

`getSnapshot()` and `getServerSnapshot()` return the same cached, immutable, serializable `{ conversation, revision, lifecycle }` value until a transition commits. `complete()` and `close()` idempotently close the controller: later writes throw a typed `ConversationalistError` with `error:conversation-closed`, while reads remain available. `dispose()` aborts owned work, awaits final quiescence, releases subscriptions, and changes the lifecycle to `disposed`. Synchronous `Symbol.dispose` starts that cleanup; `Symbol.asyncDispose` awaits it.

Expected-revision clients can use `applyMutation(...)`; external projections can use `reconcileExternalSnapshot(...)`. Both return frozen accepted or rejected results without hidden mutation. Stale external revisions and stale compaction results are discarded.

The typed event surface remains available independently:

- DOM-style `addEventListener(...)` and `removeEventListener(...)`
- `on(...)`
- `once(...)`
- `subscribe(type, ...)` for typed events, or `subscribe(onStoreChange)` for the external store
- `toObservable()`
- `events(type)`
- `close()`, `complete()`, `dispose()`, `lifecycle`, and `completed`
- `watch(...)` for current-state observation

Event types include:

- `change`
- `push`
- `undo`
- `redo`
- `switch`
- `messages.appended`
- `messages.updated`
- `messages.removed`
- `tool-calls.appended`
- `tool-results.appended`
- `stream.started`
- `stream.updated`
- `stream.finalized`
- `stream.cancelled`
- `compaction.started`
- `compaction.completed`
- `compaction.failed`
- `compaction.cancelled`
- `compaction.stale-discarded`
- `mutation.rejected`
- `snapshot.restored`
- `branch.pruned`
- `controller.closed`
- `controller.disposed`
- `plugin.activated`
- `plugin.failed`
- `session.forked`
- `session.renamed`
- `session.tagged`

Every mutation event carries the resulting controller `revision`, a monotonic event `sequence`, `correlationId`, `durability`, and `outcome`, plus an `actor` when supplied. Stream updates also carry a per-message monotonic `streamSequence`. Fork events identify the child conversation.

Message plugins remain transcript transformations only. Use `defineMessagePlugin({ id, revision }, transform)` to give a plugin stable identity. Duplicate identities are rejected, and activation or failure events include the plugin identity and fixed `transcript-transform` authority; plugins cannot register Bureau, Agent, run, or authorization hooks.

Streaming messages (those with `metadata.__streaming === true`) are automatically protected from compaction, truncation, and adapter export. They are preserved in `partitionMessages`, locked in `truncateToTokenLimit` and `truncateFromPosition`, and excluded from provider adapters so that incomplete content is never sent to an API.

## Compaction

Reclaim context window space by summarizing older messages. The summarization function is caller-provided—no large language model dependency in the library.

```typescript
import { Conversation } from 'conversationalist';

const conversation = new Conversation(existingHistory);

const result = await conversation.compact(
  async (messages) => {
    // Call your large language model to summarize
    const response = await llm.summarize(messages.map((m) => m.content).join('\n'));
    return response.text;
  },
  { preserveRecentCount: 6 },
);

if (result.compacted) {
  console.log(
    `Removed ${result.messagesRemoved} messages, created ${result.chunksProcessed} summaries`,
  );
}
```

## Documentation

- [API Reference](documentation/api-reference.md)

## Development

```bash
bun run validate
bun run build
bun test
```
