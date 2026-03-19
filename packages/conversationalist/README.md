# Conversationalist

`conversationalist` manages immutable conversation state for LLM applications. It gives you a JSON-safe `ConversationHistory` data type, a mutable `Conversation` runtime for undo/redo and evented history, provider adapters for OpenAI, Anthropic, and Gemini, and serialization utilities for storage and testing.

## Installation

```bash
bun add conversationalist zod
```

This package is ESM-only. `zod` is a peer dependency.

## Quick Start

```ts
import {
  Conversation,
  appendAssistantMessage,
  appendUserMessage,
  createConversationHistory,
} from 'conversationalist';

let conversationHistory = createConversationHistory({
  title: 'Order Support',
  metadata: { orderId: 'ord_123' },
});

conversationHistory = appendUserMessage(conversationHistory, 'Where is my order?');
conversationHistory = appendAssistantMessage(conversationHistory, 'Let me look that up.');

const conversation = new Conversation(conversationHistory);
const openAIRequest = await conversation.toProvider('openai');
```

## Core Model

- `ConversationHistory`: immutable, JSON-safe conversation data.
- `Conversation`: runtime history manager with undo, redo, branching, event emission, provider import/export helpers, and convenience wrappers around the immutable helpers.
- `Message`: ordered conversation entry with roles such as `user`, `assistant`, `system`, `developer`, `tool-call`, `tool-result`, and `snapshot`.
- `ToolCall` and `ToolResult`: canonical, JSON-safe tool interaction payloads shared with `armorer` through `interoperability`.

## Main Entry Points

### `conversationalist`

Use the root entry point for the common runtime API:

- `Conversation`
- `createConversationHistory`
- `createConversationHistoryUnsafe`
- `deserializeConversationHistory`
- append helpers such as `appendMessages`, `appendUserMessage`, `appendAssistantMessage`, `appendSystemMessage`
- system-message helpers such as `hasSystemMessage`, `getSystemMessages`, `prependSystemMessage`, `replaceSystemMessage`, `collapseSystemMessages`
- tool helpers such as `appendToolCall`, `appendToolCalls`, `appendToolResult`, `appendToolResultAsync`, `appendToolResults`, `appendToolResultsAsync`, `getPendingToolCalls`, `getToolInteractions`
- tool materializers such as `materializeToolCall`, `materializeToolCalls`, `materializeToolResult`, `materializeToolResultAsync`, `materializeToolResults`, `materializeToolResultsAsync`
- validation helpers such as `validateConversationHistoryIntegrity`, `assertConversationHistoryIntegrity`
- builder helpers such as `withConversationHistory` and `pipeConversationHistory`
- runtime errors, guards, and core types

### `conversationalist/conversation`

Pure immutable conversation helpers. Use this subpath when you want persistent data transforms without the runtime `Conversation` class.

### `conversationalist/history`

The `Conversation` class and event types.

### `conversationalist/context`

Context-window helpers such as `estimateConversationTokens`, `truncateToTokenLimit`, `getRecentMessages`, `truncateFromPosition`, and `simpleTokenEstimator`.

### `conversationalist/streaming`

Streaming-message helpers such as `appendStreamingMessage`, `updateStreamingMessage`, `finalizeStreamingMessage`, `cancelStreamingMessage`, `isStreamingMessage`, and `getStreamingMessage`.

### `conversationalist/adapters/*`

Provider message adapters:

- `conversationalist/adapters/openai`
- `conversationalist/adapters/anthropic`
- `conversationalist/adapters/gemini`

Each adapter exports:

- provider payload types
- `to...Messages(...)` export helpers
- `from...Messages(...)` import helpers
- `append...Messages(...)` append helpers for existing histories
- an adapter object used by `Conversation.fromProvider(...)`, `conversation.toProvider(...)`, and `conversation.appendProvider(...)`

### Other public subpaths

- `conversationalist/message`: message formatting and narrowing helpers
- `conversationalist/utilities`: message, transient-metadata, and content utilities
- `conversationalist/markdown`: markdown serialization and role-label helpers
- `conversationalist/export`: export helpers such as `exportMarkdown`
- `conversationalist/schemas`: runtime validation schemas
- `conversationalist/redaction`: PII redaction helpers
- `conversationalist/versioning`: schema version constant
- `conversationalist/sort`: deterministic sort helpers
- `conversationalist/test`: deterministic test environments, test conversations, and event recorders

## Provider Conversion

### Generic provider helpers

```ts
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

```ts
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

`Conversation` uses the same event-emission model as `armorer` tools and toolboxes:

- DOM-style `addEventListener(...)` and `removeEventListener(...)`
- `on(...)`
- `once(...)`
- `subscribe(type, ...)`
- `toObservable()`
- `events(type)`
- `complete()` and `completed`
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

Streaming messages (those with `metadata.__streaming === true`) are automatically protected from compaction, truncation, and adapter export. They are preserved in `partitionMessages`, locked in `truncateToTokenLimit` and `truncateFromPosition`, and excluded from provider adapters so that incomplete content is never sent to an API.
- `compaction.completed`

## Compaction

Reclaim context window space by summarizing older messages. The summarization function is caller-provided -- no LLM dependency in the library.

```ts
import { Conversation } from 'conversationalist';

const conversation = new Conversation(existingHistory);

const result = await conversation.compact(
  async (messages) => {
    // Call your LLM to summarize
    const response = await llm.summarize(messages.map(m => m.content).join('\n'));
    return response.text;
  },
  { preserveRecentCount: 6 },
);

if (result.compacted) {
  console.log(`Removed ${result.messagesRemoved} messages, created ${result.chunksProcessed} summaries`);
}
```

## Documentation

- [API Reference](/Users/stevekinney/Developer/agent-bureau/packages/conversationalist/documentation/api-reference.md)

## Development

```bash
bun run validate
bun run build
bun test
```
