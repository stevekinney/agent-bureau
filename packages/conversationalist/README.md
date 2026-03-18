# Conversationalist

A TypeScript-first library for managing LLM conversation state with **immutable updates**, **type-safe APIs**, and **provider-agnostic adapters**.

[![CI](https://github.com/stevekinney/conversationalist/actions/workflows/ci.yml/badge.svg)](https://github.com/stevekinney/conversationalist/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## What is Conversationalist?

**Conversationalist** is a state engine for LLM-driven applications. While most libraries focus on making the API calls themselves, Conversationalist focuses on the **state** that lives between those calls. It provides a unified, model-agnostic representation of a conversation that can be easily stored, serialized, and adapted for any major LLM provider (OpenAI, Anthropic, Gemini).

In a modern AI application, a conversation is more than just a list of strings. It involves:

- **Tool Call**: Pairing function calls with their results and ensuring they stay in sync.
- **Hidden Logic**: Internal "thought" messages or snapshots that should be saved but never sent to the provider.
- **Metadata**: Tracking custom IDs and tokens across different steps.
- **Streaming**: Gracefully handling partial messages in a UI without messy state transitions.

Conversationalist handles these complexities through a robust, type-safe API that treats your conversation as the "Single Source of Truth."

## Why Use It?

Managing LLM conversations manually often leads to "provider lock-in" or fragile glue code. Conversationalist solves this by:

- **Decoupling Logic from Providers**: Write your business logic once using Conversationalist's message model, and use adapters to talk to OpenAI, Anthropic, or Gemini.
- **Built-in Context Management**: Automatically handle context window limits by truncating history while preserving critical system instructions or recent messages.
- **Type Safety Out-of-the-Box**: Built with Zod and TypeScript, ensuring that your conversation data is valid at runtime and compile-time.
- **Unified Serialization**: One standard format (`ConversationHistory`) for your database, your frontend, and your backend.

## The Immutable Advantage

At its core, Conversationalist is **strictly immutable**. Every change to a conversation history, whether appending a message, updating a stream, or redacting sensitive data, returns a new `ConversationHistory` value.

This approach offers several critical advantages for modern application development:

1.  **React/Redux Friendly**: Because updates return new references, they trigger re-renders naturally and work seamlessly with state management libraries.
2.  **Concurrency Safe**: You can safely pass a conversation to multiple functions or async tasks without worrying about one part of your app mutating it out from under another.
3.  **Easy Branching & Replay**: Want to let a user "undo" an AI response or branch a conversation into two different paths? Simply keep a reference to the previous immutable state. No complex cloning required.
4.  **Auditability**: Timestamps and message positions are automatically managed and preserved, making it easy to reconstruct the exact state of a chat at any point in time.

## Real-World Use Cases

- **Multi-Model Chatbots**: Build a UI where users can switch between GPT-4o and Claude 3.5 Sonnet mid-conversation without losing history.
- **Chain-of-Thought Workflows**: Use `hidden` messages to store internal reasoning or intermediate steps that the AI uses to reach a final answer, without cluttering the user's view.
- **Agentic Workflows**: Track complex tool-call loops where multiple functions are called in sequence, ensuring every result is correctly paired with its corresponding call ID.
- **Token Budgeting**: Automatically trim old messages when a conversation gets too long, ensuring your API costs stay predictable and you never hit provider limits.
- **Deterministic Testing**: Use the custom `environment` parameter to mock IDs and timestamps, allowing you to write 100% deterministic tests for your chat logic.

---

## Installation

```bash
bun add conversationalist zod
npm add conversationalist zod
pnpm add conversationalist zod
```

This package is ESM-only. Use `import` syntax. Zod is a peer dependency and must be installed by your application.

## Quick Start

```ts
import {
  Conversation,
  appendAssistantMessage,
  appendUserMessage,
  createConversationHistory,
} from 'conversationalist';

// 1. Create immutable conversation history
let conversationHistory = createConversationHistory({
  title: 'Order Support',
  metadata: { userId: 'user_123' },
});

// 2. Add messages (returns a new immutable value)
conversationHistory = appendUserMessage(conversationHistory, 'Where is my order?');
conversationHistory = appendAssistantMessage(
  conversationHistory,
  'Let me check that for you.',
);

// 3. Use the lazy Conversation class when you want provider conversion
const conversation = new Conversation(conversationHistory);
const openAIMessages = await conversation.toOpenAIMessages();
// [{ role: 'user', content: 'Where is my order?' }, ...]
```

## Public Surface

The package now has one consistent import model:

- `conversationalist`: convenience exports for conversation creation, core appenders, guards, errors, and history.
- `conversationalist/conversation`: canonical conversation-state helpers, including tool-call appenders.
- `conversationalist/context`: token estimation and truncation helpers.
- `conversationalist/streaming`: streaming-message helpers.
- `conversationalist/history`, `conversationalist/message`, `conversationalist/utilities`, `conversationalist/test`: focused subpaths for those domains.
- `conversationalist/adapters/openai`, `conversationalist/adapters/anthropic`, `conversationalist/adapters/gemini`: provider message adapters.

When you are combining this package with `armorer`, the split is:

- `armorer`: tool schemas, provider tool definitions, provider tool-call parsing, and tool execution.
- `conversationalist`: conversation state, persistence, and provider message history.

## Core Concepts

### Conversations

A `ConversationHistory` is an immutable record with metadata, timestamps, a `messages` record keyed
by message ID, and an `ids` array that preserves order.

```ts
import { createConversationHistory } from 'conversationalist';

const conversationHistory = createConversationHistory({
  title: 'My Chat',
  status: 'active',
  metadata: { customerId: 'cus_123' },
});
```

A `Conversation` is the runtime class for undo/redo, branching, subscriptions, and lazy provider conversion.

Conversation histories track message order via `conversationHistory.ids`. Every mutation keeps `ids` in sync
with `messages`. Use `getMessages(conversationHistory)` for ordered arrays, or
`getMessageIds()` if you just need the IDs.

### Messages

Messages have roles and can contain text or multi-modal content. Optional fields include `metadata`, `hidden`, `tokenUsage`, `toolCall`, and `toolResult`. Assistant messages can also include `goalCompleted` (see `AssistantMessage`). Use `isAssistantMessage` to narrow when you need `goalCompleted`. Metadata and tool payloads are typed as `JSONValue` so conversations remain JSON-serializable.

**Roles**: `user`, `assistant`, `system`, `developer`, `tool-call`, `tool-result`, `snapshot`. The `snapshot` role is for internal state and is skipped by adapters.

```ts
import { appendMessages } from 'conversationalist';

conversation = appendMessages(conversation, {
  role: 'user',
  content: [
    { type: 'text', text: 'Describe this:' },
    { type: 'image', url: 'https://example.com/image.png' },
  ],
});
```

**Hidden messages** remain in history but are skipped by default when querying or adapting to providers. This is perfect for internal logging or "thinking" steps.

### Tool Calls

Tool calls are represented as paired `tool-call` and `tool-result` messages. Tool results are validated to ensure the referenced call exists.

```ts
conversation = appendMessages(
  conversation,
  {
    role: 'tool-call',
    content: '',
    toolCall: { id: 'call_123', name: 'getWeather', arguments: { city: 'NYC' } },
  },
  {
    role: 'tool-result',
    content: '',
    toolResult: {
      callId: 'call_123',
      outcome: 'success',
      content: { tempF: 72, condition: 'sunny' },
    },
  },
);
```

Tool payloads are typed as `JSONValue` to keep conversations JSON-serializable.

You can also use tool-specific helpers to reduce agent-loop glue code:

```ts
import {
  appendToolResult,
  appendToolCall,
  getPendingToolCalls,
  getToolInteractions,
} from 'conversationalist';

conversation = appendToolCall(conversation, {
  name: 'getWeather',
  id: 'call_123',
  arguments: { city: 'NYC' },
});

conversation = appendToolResult(conversation, {
  callId: 'call_123',
  outcome: 'success',
  content: { tempF: 72, condition: 'sunny' },
});

const pending = getPendingToolCalls(conversation);
const interactions = getToolInteractions(conversation);
```

If you are appending `armorer` execution results, use `appendToolResultsAsync(...)` when any tool result may still expose a live async stream.

### Correctness Guarantees

Conversationalist treats integrity and JSON-safety as first-class invariants:

- `conversation.ids` and `conversation.messages` stay in sync.
- Every `tool-result` references an earlier `tool-call`.
- `toolCall.id` values are unique per conversation.
- Conversation payloads are JSON-serializable (`JSONValue` everywhere).

`validateConversationHistoryIntegrity`/`assertConversationHistoryIntegrity` are the canonical integrity
checks and are used internally at public boundaries (adapters, markdown import,
deserialization, truncation, redaction).

Safe APIs (default) validate schema + integrity and throw on failure. Unsafe escape hatches
skip validation and require manual checks:

- `createConversationHistoryUnsafe`
- `appendUnsafeMessage`

Schema validation is strict; unknown fields are rejected. Use `metadata` for extensions.

For custom transforms, validate the shape and then re-assert integrity:

```ts
import {
  assertConversationHistoryIntegrity,
  validateConversationHistoryIntegrity,
  conversationSchema,
} from 'conversationalist';

const issues = validateConversationHistoryIntegrity(conversation);
// issues: IntegrityIssue[]

assertConversationHistoryIntegrity(conversation);

conversationSchema.parse(conversation);
```

### Streaming

Streaming helpers let you append a placeholder, update it as chunks arrive, and finalize
when done.

```ts
import {
  appendStreamingMessage,
  finalizeStreamingMessage,
  updateStreamingMessage,
} from 'conversationalist';

let { conversation, messageId } = appendStreamingMessage(conversation, 'assistant');
let content = '';

for await (const chunk of stream) {
  content += chunk;
  conversation = updateStreamingMessage(conversation, messageId, content);
}

conversation = finalizeStreamingMessage(conversation, messageId, {
  tokenUsage: { prompt: 100, completion: 50, total: 150 },
});
```

### Context Window Management

Automatically trim history to fit token budgets or to keep only recent messages.

```ts
import { simpleTokenEstimator, truncateToTokenLimit } from 'conversationalist';

conversation = truncateToTokenLimit(conversation, 4000, {
  preserveSystemMessages: true,
  preserveLastN: 2,
  preserveToolPairs: true, // default
});
```

By default, truncation and recent-message helpers treat a `tool-call` + `tool-result`
as an atomic block (`preserveToolPairs: true`) so tool results are never stranded.
If a tool block doesn't fit inside the budget, both messages are dropped. Set
`preserveToolPairs: false` to revert to message-level truncation. When disabled,
truncation can strand tool results; Conversationalist throws an integrity error
instead of returning invalid history. For agent loops, keep
`preserveToolPairs: true` to preserve tool interactions.

#### Custom Token Counters

You can provide a custom token estimator (e.g. using `tiktoken` or `anthropic-tokenizer`) by passing it in the options or by binding it to your environment.

```ts
import { truncateToTokenLimit } from 'conversationalist';
// import { get_encoding } from 'tiktoken';

const tiktokenEstimator = (message) => {
  // Your logic here...
  return 100;
};

// 1. Pass directly in options
conversation = truncateToTokenLimit(conversation, 4000, {
  estimateTokens: tiktokenEstimator,
});

// 2. Or bind to a history instance/environment
const conversationState = new Conversation(conversation, {
  estimateTokens: tiktokenEstimator,
});

const boundTruncate = conversationState.bind(truncateToTokenLimit);
boundTruncate(4000); // Uses tiktokenEstimator automatically
```

### Markdown Conversion

Convert conversations to human-readable Markdown format, or parse Markdown back into a `ConversationHistory`. These helpers live in `conversationalist/markdown`.

#### Basic Usage (Clean Markdown)

By default, `toMarkdown` produces clean, readable Markdown without metadata:

```ts
import { appendMessages, createConversationHistory } from 'conversationalist';
import { fromMarkdown, toMarkdown } from 'conversationalist/markdown';

let conversation = createConversationHistory({ id: 'conv-1' });
conversation = appendMessages(
  conversation,
  { role: 'user', content: 'What is 2 + 2?' },
  { role: 'assistant', content: 'The answer is 4.' },
);

const markdown = toMarkdown(conversation);
// Output:
// ### User
//
// What is 2 + 2?
//
// ### Assistant
//
// The answer is 4.
```

When parsing simple Markdown without metadata, `fromMarkdown` generates new IDs and uses sensible defaults:

```ts
const parsed = fromMarkdown(markdown);
// parsed.id is a new generated ID
// parsed.status is 'active'
// Message IDs are generated, positions are assigned sequentially
```

#### Lossless Round-Trip (with Metadata)

For archiving or backup scenarios where you need to preserve all data, use `{ includeMetadata: true }`:

```ts
const markdown = toMarkdown(conversation, { includeMetadata: true });
// Output includes YAML frontmatter with all metadata keyed by message ID:
// ---
// id: conv-1
// status: active
// metadata: {}
// createdAt: '2024-01-15T10:00:00.000Z'
// updatedAt: '2024-01-15T10:01:00.000Z'
// messages:
//   msg-1:
//     position: 0
//     createdAt: '2024-01-15T10:00:00.000Z'
//     metadata: {}
//     hidden: false
//   msg-2:
//     position: 1
//     createdAt: '2024-01-15T10:01:00.000Z'
//     metadata: {}
//     hidden: false
// ---
// ### User (msg-1)
//
// What is 2 + 2?
//
// ### Assistant (msg-2)
//
// The answer is 4.

// Parse back with all metadata preserved
const restored = fromMarkdown(markdown);
// restored.id === 'conv-1'
// restored.ids[0] === 'msg-1'
```

#### Multi-Modal Content

Both functions handle multi-modal content. Images render as Markdown images, and with metadata enabled, additional properties like `mimeType` are preserved in the YAML frontmatter:

```ts
conversation = appendMessages(conversation, {
  role: 'user',
  content: [
    { type: 'text', text: 'Describe this:' },
    { type: 'image', url: 'https://example.com/photo.png', mimeType: 'image/png' },
  ],
});

const md = toMarkdown(conversation);
// Describe this:
//
// ![image](https://example.com/photo.png)
```

## Plugins

**Conversationalist** supports a plugin system that allows you to transform messages as they are appended to a conversation. Plugins are functions that take a `MessageInput` and return a modified `MessageInput`.

### PII Redaction Plugin

The library includes a built-in `redactPii` plugin that can automatically redact emails, phone numbers, and common API key patterns.

```ts
import {
  appendUserMessage,
  createConversationHistory,
  getMessages,
} from 'conversationalist';
import { redactPii } from 'conversationalist/redaction';

// 1. Enable by adding to your environment
const env = {
  plugins: [redactPii],
};

// 2. Use the environment when appending messages
let conversation = createConversationHistory({}, env);
conversation = appendUserMessage(
  conversation,
  'Contact me at test@example.com',
  undefined,
  env,
);

console.log(getMessages(conversation)[0]?.content);
// "Contact me at [EMAIL_REDACTED]"
```

When using `Conversation`, you only need to provide the plugin once during initialization:

```ts
const conversation = new Conversation(createConversationHistory(), {
  plugins: [redactPii],
});

const appendUser = conversation.bind(appendUserMessage);
appendUser('My key is sk-12345...'); // Automatically redacted
```

## Provider Adapters

Convert the same conversation history into provider-specific formats, or convert those provider payloads back into a `ConversationHistory`. The `Conversation` class exposes lazy async helpers so provider adapters are only imported when needed.

```ts
import {
  fromOpenAIMessages,
  toOpenAIMessages,
} from 'conversationalist/adapters/openai';
import { Conversation } from 'conversationalist';
```

- Adapter outputs are SDK-compatible, and the reverse adapters accept the same SDK-facing message payloads.
- **OpenAI**: Supports `toOpenAIMessages` and `toOpenAIMessagesGrouped` (which groups consecutive tool calls).
- **Anthropic**: Supports `toAnthropicMessages` and `fromAnthropicMessages`.
- **Gemini**: Supports `toGeminiMessages` and `fromGeminiMessages`.

```ts
const history = fromOpenAIMessages(openAIMessages);
const conversation = await Conversation.fromOpenAIMessages(openAIMessages);

const openAIAgain = await conversation.toOpenAIMessages();
const groupedOpenAI = await conversation.toOpenAIMessagesGrouped();
```

### Provider-Specific Examples

### Using with `armorer`

The canonical shared loop is:

1. `to<Provider>Messages(conversation)` from `conversationalist/adapters/*`
2. `to<Provider>Tools(toolbox)` from `armorer/adapters/*`
3. provider API call
4. `parse<Provider>ToolCalls(response)` from `armorer/adapters/*`
5. `appendToolCalls(conversation, calls)` from `conversationalist/conversation`
6. `toolbox.execute(calls)`
7. `appendToolResults(...)` or `appendToolResultsAsync(...)`
8. repeat until the model stops calling tools

#### OpenAI

```ts
import { appendToolCalls, appendToolResultsAsync } from 'conversationalist/conversation';
import { toOpenAIMessagesGrouped } from 'conversationalist/adapters/openai';
import { parseOpenAIToolCalls, toOpenAITools } from 'armorer/adapters/openai';

const completion = await openai.chat.completions.create({
  model: 'gpt-4o',
  messages: toOpenAIMessagesGrouped(conversation),
  tools: toOpenAITools(toolbox),
});

const toolCalls = parseOpenAIToolCalls(completion.choices[0]?.message?.tool_calls);
conversation = appendToolCalls(conversation, toolCalls);

const results = await toolbox.execute(toolCalls, { stream: true });
conversation = await appendToolResultsAsync(conversation, results);
```

#### Anthropic

```ts
import { appendToolCalls, appendToolResults } from 'conversationalist/conversation';
import { toAnthropicMessages } from 'conversationalist/adapters/anthropic';
import { parseAnthropicToolCalls, toAnthropicTools } from 'armorer/adapters/anthropic';

const { system, messages } = toAnthropicMessages(conversation);
const response = await anthropic.messages.create({
  model: 'claude-sonnet-4-20250514',
  system,
  messages,
  tools: toAnthropicTools(toolbox),
});

const toolCalls = parseAnthropicToolCalls(response.content);
conversation = appendToolCalls(conversation, toolCalls);

const results = await toolbox.execute(toolCalls);
conversation = appendToolResults(conversation, results);
```

#### Gemini

```ts
import { appendToolCalls, appendToolResultsAsync } from 'conversationalist/conversation';
import { toGeminiMessages } from 'conversationalist/adapters/gemini';
import { parseGeminiToolCalls, toGeminiTools } from 'armorer/adapters/gemini';

const { systemInstruction, contents } = toGeminiMessages(conversation);
const response = await model.generateContent({
  systemInstruction,
  contents,
  tools: toGeminiTools(toolbox),
});

const parsedCalls = parseGeminiToolCalls(
  response.response.candidates?.[0]?.content?.parts ?? [],
);
const toolCalls = parsedCalls.map((toolCall, index) => ({
  ...toolCall,
  id: `call-gemini-${index + 1}`,
}));

conversation = appendToolCalls(conversation, toolCalls);

const results = await toolbox.execute(toolCalls, { stream: true });
conversation = await appendToolResultsAsync(conversation, results);
```

## Builder Pattern (Fluent API)

If you prefer a more fluent style, use `withConversationHistory` or `pipeConversationHistory`. These allow you to "mutate" a draft within a scope while still resulting in an immutable object.

```ts
import { withConversationHistory, createConversationHistory } from 'conversationalist';

const conversationHistory = withConversationHistory(createConversationHistory(), (draft) => {
  draft
    .appendSystemMessage('You are a helpful assistant.')
    .appendUserMessage('Hello!')
    .appendAssistantMessage('Hi there!');
});
```

`pipeConversationHistory` allows you to chain multiple transformation functions together:

```ts
import {
  createConversationHistory,
  pipeConversationHistory,
  appendSystemMessage,
  appendUserMessage,
} from 'conversationalist';

const conversationHistory = pipeConversationHistory(
  createConversationHistory(),
  (c) => appendSystemMessage(c, 'You are a helpful assistant.'),
  (c) => appendUserMessage(c, 'Hello!'),
  (c) => appendAssistantMessage(c, 'Hi there!'),
);
```

## Conversation Class (Undo/Redo)

Use the `Conversation` class to manage a stack of conversation states. Because every change returns a new immutable `ConversationHistory` object, supporting undo/redo is built into the architecture.

```ts
import { Conversation } from 'conversationalist';

// Create a new history (defaults to an empty conversation)
const conversation = new Conversation();

// You can use convenience methods that automatically track state
conversation.appendUserMessage('Hello!');
conversation.appendAssistantMessage('How are you?');

conversation.undo(); // State reverts to just "Hello!"
conversation.redo(); // State advances back to "How are you?"

// Convenience methods for all library utilities are built-in
conversation.appendUserMessage('Another message');
conversation.redactMessageAtPosition(0);
conversation.truncateToTokenLimit(4000);

// Query methods work on the current state
const messages = conversation.getMessages();
const stats = conversation.getStatistics();
const tokens = conversation.estimateTokens();
const ids = conversation.ids;
const firstMessage = conversation.get(ids[0]!);
```

### Event Subscription

`Conversation` implements `EventTarget` (and follows the Svelte store contract). You can listen for changes using standard DOM events or the `subscribe` method.

#### Using DOM Events

```ts
const conversation = new Conversation();

// addEventListener returns a convenient unsubscribe function
const unsubscribe = conversation.addEventListener('change', (event) => {
  const { type, conversation } = event.detail;
  console.log(`Conversation updated via ${type}`);
});

conversation.appendUserMessage('Hello!'); // Fires 'push' and 'change' events

unsubscribe(); // Clean up when done
```

#### Using the Store Contract

```ts
// Subscribe returns an unsubscribe function and calls the callback immediately
const unsubscribe = conversation.subscribe((conversation) => {
  console.log('Current conversation state:', conversation);
});
```

You can also use an `AbortSignal` for automatic cleanup:

```ts
const controller = new AbortController();
conversation.addEventListener('change', (e) => { ... }, { signal: controller.signal });

// Later...
controller.abort();
```

### Conversation Branching

The `Conversation` class supports branching. When you undo to a previous state and push a new update, it creates an alternate path instead of deleting the old history.

```ts
const conversation = new Conversation();

conversation.appendUserMessage('Path A');
conversation.undo();

conversation.appendUserMessage('Path B');

console.log(conversation.branchCount); // 2
console.log(conversation.getMessages()[0]?.content); // "Path B"

conversation.switchToBranch(0);
console.log(conversation.getMessages()[0]?.content); // "Path A"
```

### Serialization

You can serialize the entire conversation tree, including all branches, to JSON and reconstruct it later.

```ts
// 1. Capture a snapshot
const snapshot = conversation.snapshot();
// localStorage.setItem('chat_history', JSON.stringify(snapshot));

// 2. Restore from a snapshot
const restored = Conversation.from(snapshot);

// You can also provide a new environment (e.g. with fresh token counters)
const restoredWithEnv = Conversation.from(snapshot, {
  estimateTokens: myNewEstimator,
});
```

## Advanced Serialization

### Schema Versioning

Conversations include a `schemaVersion` field for forward compatibility. `deserializeConversationHistory(...)` migrates legacy `tool-use` roles and legacy `args` / `result` tool payload fields where possible before validation.

```ts
import { deserializeConversationHistory } from 'conversationalist';
import { CURRENT_SCHEMA_VERSION } from 'conversationalist/versioning';

const conversation = deserializeConversationHistory(JSON.parse(storage));
```

Conversations are already JSON-serializable; persist them directly and apply utilities
like `stripTransientMetadata` or `redactMessageAtPosition` when you need to sanitize data.

`redactMessageAtPosition` preserves tool linkage by default (call IDs and outcomes stay intact),
and supports `redactToolArguments`, `redactToolResults`, or `clearToolMetadata` for stricter
scrubbing.

### Transient Metadata Convention

Keys prefixed with `_` are considered transient—temporary UI state that shouldn't be persisted:

```ts
import {
  isTransientKey,
  stripTransientFromRecord,
  stripTransientMetadata,
} from 'conversationalist';

// Check if a key is transient
isTransientKey('_tempId'); // true
isTransientKey('source'); // false

// Strip transient keys from a metadata object
stripTransientFromRecord({ _loading: true, source: 'web' });
// { source: 'web' }

// Strip transient metadata from an entire conversation
const cleaned = stripTransientMetadata(conversation);
```

### Sort Utilities

For reproducible snapshots or tests, use the sort utilities:

```ts
import { sortObjectKeys, sortMessagesByPosition } from 'conversationalist/sort';

// Sort object keys alphabetically (recursive)
const sorted = sortObjectKeys({ z: 1, a: 2, nested: { b: 3, a: 4 } });
// { a: 2, nested: { a: 4, b: 3 }, z: 1 }

// Sort messages by position, createdAt, then id
const orderedMessages = sortMessagesByPosition(messages);
```

### Role Labels

Export human-readable labels for message roles:

```ts
import {
  ROLE_LABELS,
  LABEL_TO_ROLE,
  getRoleLabel,
  getRoleFromLabel,
} from 'conversationalist/markdown';

// Get display label for a role
getRoleLabel('tool-call'); // 'Tool Call'
getRoleLabel('assistant'); // 'Assistant'

// Get role from a label
getRoleFromLabel('Tool Result'); // 'tool-result'
getRoleFromLabel('Unknown'); // undefined

// Access the mappings directly
ROLE_LABELS['developer']; // 'Developer'
LABEL_TO_ROLE['System']; // 'system'
```

### Markdown Serialization

You can also convert a conversation to Markdown format for human-readable storage or export, and restore it later.

```ts
import { Conversation } from 'conversationalist';
import {
  conversationFromMarkdown,
  conversationToMarkdown,
} from 'conversationalist/markdown';

const conversation = new Conversation();

// Export to clean, readable Markdown
const markdown = conversationToMarkdown(conversation);
// ### User
//
// Hello!
//
// ### Assistant
//
// Hi there!

// Export with full metadata (lossless round-trip)
const markdownWithMetadata = conversationToMarkdown(conversation, {
  includeMetadata: true,
});

// Export with additional controls (redaction, transient stripping, hidden handling)
const markdownSafe = conversationToMarkdown(conversation, {
  includeMetadata: true,
  stripTransient: true,
  redactToolArguments: true,
  redactToolResults: true,
  includeHidden: false,
});

// Restore from Markdown
const restored = conversationFromMarkdown(markdownWithMetadata);
```

### Export Helpers

For markdown export workflows, use the built-in helpers:

```ts
import { exportMarkdown, normalizeLineEndings } from 'conversationalist/export';

const normalizedMarkdown = exportMarkdown(conversation, { includeMetadata: true });
const normalized = normalizeLineEndings('line1\r\nline2');
```

## Integration

### Using with React

Because **Conversationalist** is immutable, it works perfectly with React's `useState` or `useReducer`. Every update returns a new reference, which automatically triggers a re-render.

```tsx
import { useState } from 'react';
import {
  appendUserMessage,
  createConversationHistory,
  getMessages,
} from 'conversationalist';

export function ChatApp() {
  const [conversation, setConversation] = useState(() => createConversationHistory());

  const handleSend = (text: string) => {
    // The new ConversationHistory value is set into state
    setConversation((prev) => appendUserMessage(prev, text));
  };

  return (
    <div>
      {getMessages(conversation).map((m) => (
        <div key={m.id}>{String(m.content)}</div>
      ))}
      <button onClick={() => handleSend('Hello!')}>Send</button>
    </div>
  );
}
```

#### Custom React Hook Example

For more complex applications, you can wrap the logic into a custom hook. This example uses `addEventListener` to sync the history with local React state and returns the unsubscribe function for easy cleanup in `useEffect`.

```tsx
import { useState, useCallback, useEffect } from 'react';
import { Conversation, getMessages } from 'conversationalist';

export function useChat() {
  // 1. Initialize history (this could also come from context or props)
  const [conversation] = useState(() => new Conversation());

  // 2. Sync history with local state for reactivity
  const [historyState, setHistoryState] = useState(conversation.current);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    // addEventListener returns a cleanup function!
    return conversation.addEventListener('change', (e) => {
      setHistoryState(e.detail.conversation);
    });
  }, [conversation]);

  const sendMessage = useCallback(
    async (text: string) => {
      conversation.appendUserMessage(text);
      setLoading(true);

      try {
        const response = await fetch('/api/chat', {
          method: 'POST',
          body: JSON.stringify({
            messages: conversation.toChatMessages(),
          }),
        });
        const data = await response.json();
        conversation.appendAssistantMessage(data.answer);
      } finally {
        setLoading(false);
      }
    },
    [conversation],
  );

  return {
    conversation: historyState,
    messages: getMessages(historyState),
    loading,
    sendMessage,
    undo: () => conversation.undo(),
    redo: () => conversation.redo(),
  };
}
```

> **Note**: `Conversation.addEventListener()` returns an unsubscribe function, which is ideal for cleaning up effects in React (`useEffect`) or Svelte.

### Using with Redux

Redux requires immutable state updates, making **Conversationalist** an ideal companion. You can store the `ConversationHistory` value directly in your store.

```ts
import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import {
  ConversationHistory,
  appendUserMessage,
  createConversationHistory,
} from 'conversationalist';

interface ChatState {
  conversation: ConversationHistory;
}

const chatSlice = createSlice({
  name: 'chat',
  initialState: {
    conversation: createConversationHistory(),
  } as ChatState,
  reducers: {
    userMessageReceived: (state, action: PayloadAction<string>) => {
      // Redux Toolkit's createSlice uses Immer, but since appendUserMessage
      // returns a new object, we can just replace the property.
      state.conversation = appendUserMessage(state.conversation, action.payload);
    },
  },
});
```

### Using with Svelte (Runes)

In Svelte 5, you can manage conversation state using the `$state` rune. Since **Conversationalist** is immutable, you update the state by re-assigning the variable with a new `ConversationHistory` value.

```svelte
<script lang="ts">
  import {
    appendUserMessage,
    createConversationHistory,
    getMessages,
  } from 'conversationalist';

  let conversation = $state(createConversationHistory());

  function handleSend(text: string) {
    conversation = appendUserMessage(conversation, text);
  }
</script>

<div>
  {#each getMessages(conversation) as m (m.id)}
    <div>{String(m.content)}</div>
  {/each}
  <button onclick={() => handleSend('Hello!')}>Send</button>
</div>
```

#### Custom Svelte Rune Example

Svelte 5's runes pair perfectly with **Conversationalist**. You can use the `Conversation` class directly as a store, or wrap it in a class with runes.

```svelte
<script lang="ts">
  import { Conversation, getMessages } from 'conversationalist';

  // conversation implements the Svelte store contract
  const conversation = new Conversation();
</script>

<div>
  {#each getMessages($conversation) as m (m.id)}
    <div>{String(m.content)}</div>
  {/each}
  <button onclick={() => conversation.appendUserMessage('Hello!')}>
    Send
  </button>
</div>
```

> **Note**: `Conversation.addEventListener()` returns an unsubscribe function, which is ideal for cleaning up reactive effects in Svelte 5 or React hooks.

## API Overview

| Category         | Key Functions                                                                                                                                                                                                               |
| :--------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Creation**     | `createConversationHistory`, `deserializeConversationHistory`                                                                                                                                                               |
| **Appending**    | `appendUserMessage`, `appendAssistantMessage`, `appendSystemMessage`, `appendToolCall`, `appendToolResult`, `appendMessages`                                                                                                 |
| **Unsafe**       | `createConversationHistoryUnsafe`, `appendUnsafeMessage`                                                                                                                                                                    |
| **Streaming**    | `appendStreamingMessage`, `updateStreamingMessage`, `finalizeStreamingMessage`, `cancelStreamingMessage`                                                                                                                    |
| **Modification** | `redactMessageAtPosition`, `replaceSystemMessage`, `collapseSystemMessages`                                                                                                                                                 |
| **Context**      | `truncateToTokenLimit`, `truncateFromPosition`, `getRecentMessages`, `estimateConversationTokens`                                                                                                                           |
| **Querying**     | `getMessages`, `getMessageIds`, `getMessageById`, `getStatistics`                                                                                                                                                           |
| **Conversion**   | `toChatMessages`                                                                                                                                                                                                            |
| **Tooling**      | `getPendingToolCalls`, `getToolInteractions`, `appendToolCall`, `appendToolResult`, `appendToolResultsAsync`                                                                                                               |
| **Integrity**    | `validateConversationHistoryIntegrity`, `assertConversationHistoryIntegrity`                                                                                                                                                |
| **Markdown**     | `toMarkdown`, `fromMarkdown`, `conversationToMarkdown`, `conversationFromMarkdown` (from `conversationalist/markdown`)                                                                                                      |
| **Export**       | `exportMarkdown`, `normalizeLineEndings` (from `conversationalist/export`)                                                                                                                                                  |
| **Schemas**      | `conversationSchema`, `messageSchema`, `messageInputSchema`, `messageRoleSchema`, `multiModalContentSchema`, `jsonValueSchema`, `toolCallSchema`, `toolResultSchema`, `tokenUsageSchema` (from `conversationalist/schemas`) |
| **Type Guards**  | `isConversationHistory`, `isMessage`, `isMessageInput`, `isToolCall`, `isToolResult`, `isMessageRole`, `isConversationStatus`, `isJSONValue`, `isTokenUsage`, `isMultiModalContent`                                        |
| **Role Labels**  | `ROLE_LABELS`, `LABEL_TO_ROLE`, `getRoleLabel`, `getRoleFromLabel` (from `conversationalist/markdown`)                                                                                                                      |
| **Transient**    | `isTransientKey`, `stripTransientFromRecord`, `stripTransientMetadata`                                                                                                                                                      |
| **Redaction**    | `redactPii`, `createPIIRedactionPlugin`, `createPIIRedaction`, `DEFAULT_PII_RULES` (from `conversationalist/redaction`)                                                                                                     |
| **Versioning**   | `CURRENT_SCHEMA_VERSION` (from `conversationalist/versioning`)                                                                                                                                                              |
| **Sort**         | `sortObjectKeys`, `sortMessagesByPosition` (from `conversationalist/sort`)                                                                                                                                                  |
| **Conversation** | `Conversation`                                                                                                                                                                                                               |

## Type Guards

Use the built-in type guards to validate unknown values before operating on them:

```ts
import { isConversationHistory, isMessage } from 'conversationalist';

if (isConversationHistory(data)) {
  console.log(data.id);
}

if (isMessage(value)) {
  console.log(value.role);
}
```

## Conversation Events

`Conversation` emits typed events for every mutation. Listen to `change` for any mutation,
or to specific action events if you only care about a subset.

Events and payloads:

- `change`: fired after any mutation; `detail.type` is the specific action (`push`, `undo`, `redo`, `switch`)
- `push`: fired after a new conversation state is pushed
- `undo`: fired after undoing to the previous state
- `redo`: fired after redoing to a child state
- `switch`: fired after switching branches

```ts
import { Conversation, createConversationHistory } from 'conversationalist';

const conversation = new Conversation(createConversationHistory());

conversation.addEventListener('change', (event) => {
  console.log(event.detail.type, event.detail.conversation.id);
});

conversation.addEventListener('push', (event) => {
  console.log('pushed', event.detail.conversation.ids.length);
});
```

## Standard Schema Compliance

All exported Zod schemas implement the [Standard Schema](https://standardschema.dev/) specification via Zod's built-in support. This means they can be used with any Standard Schema-compatible tool without library-specific adapters.

### Exported Schemas

| Schema                    | Purpose                             |
| :------------------------ | :---------------------------------- |
| `conversationSchema`      | Complete conversation with metadata |
| `jsonValueSchema`         | JSON-serializable values            |
| `messageSchema`           | Serialized message format           |
| `messageInputSchema`      | Input for creating messages         |
| `messageRoleSchema`       | Valid message roles enum            |
| `multiModalContentSchema` | Text or image content               |
| `toolCallSchema`          | Tool function calls                 |
| `toolResultSchema`        | Tool execution results              |
| `tokenUsageSchema`        | Token usage statistics              |

### Usage with Standard Schema Consumers

```ts
import { conversationSchema } from 'conversationalist/schemas';

// Access the Standard Schema interface
const standardSchema = conversationSchema['~standard'];

// Use with any Standard Schema consumer
const result = standardSchema.validate(unknownData);
if (result.issues) {
  console.error('Validation failed:', result.issues);
} else {
  console.log('Valid conversation:', result.value);
}
```

### Type Inference

Standard Schema preserves type information:

```ts
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { conversationSchema } from 'conversationalist/schemas';

// Type is inferred correctly
type ConversationInput = StandardSchemaV1.InferInput<typeof conversationSchema>;
type ConversationOutput = StandardSchemaV1.InferOutput<typeof conversationSchema>;
```

## Deterministic Environments (Testing)

Pass a custom environment to control timestamps and IDs, making your tests 100% predictable.

```ts
const testEnv = {
  now: () => '2024-01-01T00:00:00.000Z',
  randomId: () => 'fixed-id',
};

let conversation = createConversationHistory({ title: 'Test' }, testEnv);
```

## Development

```bash
bun install
bun test
bun run build
```
