# Conversationalist

A TypeScript-first library for managing LLM conversation state with **immutable updates**, **type-safe APIs**, and **provider-agnostic adapters**.

[![CI](https://github.com/stevekinney/conversationalist/actions/workflows/ci.yml/badge.svg)](https://github.com/stevekinney/conversationalist/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## What is Conversationalist?

**Conversationalist** is a state engine for LLM-driven applications. While most libraries focus on making the API calls themselves, Conversationalist focuses on the **state** that lives between those calls. It provides a unified, model-agnostic representation of a conversation that can be easily stored, serialized, and adapted for any major LLM provider (OpenAI, Anthropic, Gemini).

In a modern AI application, a conversation is more than just a list of strings. It involves:

- **Tool Use**: Pairing function calls with their results and ensuring they stay in sync.
- **Hidden Logic**: Internal "thought" messages or snapshots that should be saved but never sent to the provider.
- **Metadata**: Tracking custom IDs and tokens across different steps.
- **Streaming**: Gracefully handling partial messages in a UI without messy state transitions.

Conversationalist handles these complexities through a robust, type-safe API that treats your conversation as the "Single Source of Truth."

## Why Use It?

Managing LLM conversations manually often leads to "provider lock-in" or fragile glue code. Conversationalist solves this by:

- **Decoupling Logic from Providers**: Write your business logic once using Conversationalist's message model, and use adapters to talk to OpenAI, Anthropic, or Gemini.
- **Built-in Context Management**: Automatically handle context window limits by truncating history while preserving critical system instructions or recent messages.
- **Type Safety Out-of-the-Box**: Built with Zod and TypeScript, ensuring that your conversation data is valid at runtime and compile-time.
- **Unified Serialization**: One standard format (`Conversation`) for your database, your frontend, and your backend.

## The Immutable Advantage

At its core, Conversationalist is **strictly immutable**. Every change to a conversation—whether appending a message, updating a stream, or redacting sensitive data—returns a _new_ conversation object.

This approach offers several critical advantages for modern application development:

1.  **React/Redux Friendly**: Because updates return new references, they trigger re-renders naturally and work seamlessly with state management libraries.
2.  **Concurrency Safe**: You can safely pass a conversation to multiple functions or async tasks without worrying about one part of your app mutating it out from under another.
3.  **Easy Branching & Replay**: Want to let a user "undo" an AI response or branch a conversation into two different paths? Simply keep a reference to the previous immutable state. No complex cloning required.
4.  **Auditability**: Timestamps and message positions are automatically managed and preserved, making it easy to reconstruct the exact state of a chat at any point in time.

## Real-World Use Cases

- **Multi-Model Chatbots**: Build a UI where users can switch between GPT-4o and Claude 3.5 Sonnet mid-conversation without losing history.
- **Chain-of-Thought Workflows**: Use `hidden` messages to store internal reasoning or intermediate steps that the AI uses to reach a final answer, without cluttering the user's view.
- **Agentic Workflows**: Track complex tool-use loops where multiple functions are called in sequence, ensuring every result is correctly paired with its corresponding call ID.
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
  appendAssistantMessage,
  appendUserMessage,
  createConversation,
} from 'conversationalist';
import { toOpenAIMessages } from 'conversationalist/openai';

// 1. Create a conversation
let conversation = createConversation({
  title: 'Order Support',
  metadata: { userId: 'user_123' },
});

// 2. Add messages (returns a new conversation object)
conversation = appendUserMessage(conversation, 'Where is my order?');
conversation = appendAssistantMessage(conversation, 'Let me check that for you.');

// 3. Adapt for a provider
const openAIMessages = toOpenAIMessages(conversation);
// [{ role: 'user', content: 'Where is my order?' }, ...]
```

## Core Concepts

### Conversations

A conversation is an immutable record with metadata, timestamps, a `messages` record keyed
by message ID, and an `ids` array that preserves order.

```ts
import { createConversation } from 'conversationalist';

const conversation = createConversation({
  title: 'My Chat',
  status: 'active',
  metadata: { customerId: 'cus_123' },
});
```

Conversations track message order via `conversation.ids`. Every mutation keeps `ids` in sync
with `messages`. Use `getMessages(conversation)` for ordered arrays, or
`getMessageIds()` if you just need the IDs.

### Messages

Messages have roles and can contain text or multi-modal content. Optional fields include `metadata`, `hidden`, `tokenUsage`, `toolCall`, and `toolResult`. Assistant messages can also include `goalCompleted` (see `AssistantMessage`). Use `isAssistantMessage` to narrow when you need `goalCompleted`. Metadata and tool payloads are typed as `JSONValue` so conversations remain JSON-serializable.

**Roles**: `user`, `assistant`, `system`, `developer`, `tool-use`, `tool-result`, `snapshot`. The `snapshot` role is for internal state and is skipped by adapters.

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

Tool calls are represented as paired `tool-use` and `tool-result` messages. Tool results are validated to ensure the referenced call exists.

```ts
conversation = appendMessages(
  conversation,
  {
    role: 'tool-use',
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
  appendToolUse,
  getPendingToolCalls,
  getToolInteractions,
} from 'conversationalist';

conversation = appendToolUse(conversation, {
  toolId: 'getWeather',
  callId: 'call_123',
  args: { city: 'NYC' },
});

conversation = appendToolResult(conversation, {
  callId: 'call_123',
  outcome: 'success',
  result: { tempF: 72, condition: 'sunny' },
});

const pending = getPendingToolCalls(conversation);
const interactions = getToolInteractions(conversation);
```

### Correctness Guarantees

Conversationalist treats integrity and JSON-safety as first-class invariants:

- `conversation.ids` and `conversation.messages` stay in sync.
- Every `tool-result` references an earlier `tool-use`.
- `toolCall.id` values are unique per conversation.
- Conversation payloads are JSON-serializable (`JSONValue` everywhere).

`validateConversationIntegrity`/`assertConversationIntegrity` are the canonical integrity
checks and are used internally at public boundaries (adapters, markdown import,
deserialization, truncation, redaction).

Safe APIs (default) validate schema + integrity and throw on failure. Unsafe escape hatches
skip validation and require manual checks:

- `createConversationUnsafe`
- `appendUnsafeMessage`

Schema validation is strict; unknown fields are rejected. Use `metadata` for extensions.

For custom transforms, validate the shape and then re-assert integrity:

```ts
import {
  assertConversationIntegrity,
  validateConversationIntegrity,
  conversationSchema,
} from 'conversationalist';

const issues = validateConversationIntegrity(conversation);
// issues: IntegrityIssue[]

assertConversationIntegrity(conversation);

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

By default, truncation and recent-message helpers treat a `tool-use` + `tool-result`
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
const history = new ConversationHistory(conversation, {
  estimateTokens: tiktokenEstimator,
});

const boundTruncate = history.bind(truncateToTokenLimit);
boundTruncate(4000); // Uses tiktokenEstimator automatically
```

### Markdown Conversion

Convert conversations to human-readable Markdown format, or parse Markdown back into a conversation object. These helpers live in `conversationalist/markdown`.

#### Basic Usage (Clean Markdown)

By default, `toMarkdown` produces clean, readable Markdown without metadata:

```ts
import { appendMessages, createConversation } from 'conversationalist';
import { fromMarkdown, toMarkdown } from 'conversationalist/markdown';

let conversation = createConversation({ id: 'conv-1' });
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
import { appendUserMessage, createConversation, getMessages } from 'conversationalist';
import { redactPii } from 'conversationalist/redaction';

// 1. Enable by adding to your environment
const env = {
  plugins: [redactPii],
};

// 2. Use the environment when appending messages
let conversation = createConversation({}, env);
conversation = appendUserMessage(
  conversation,
  'Contact me at test@example.com',
  undefined,
  env,
);

console.log(getMessages(conversation)[0]?.content);
// "Contact me at [EMAIL_REDACTED]"
```

When using `ConversationHistory`, you only need to provide the plugin once during initialization:

```ts
const history = new ConversationHistory(createConversation(), {
  plugins: [redactPii],
});

const appendUser = history.bind(appendUserMessage);
appendUser('My key is sk-12345...'); // Automatically redacted
```

## Provider Adapters

Convert the same conversation into provider-specific formats. Adapters automatically skip hidden/snapshot messages and map roles correctly.

```ts
import { toOpenAIMessages } from 'conversationalist/openai';
import { toAnthropicMessages } from 'conversationalist/anthropic';
import { toGeminiMessages } from 'conversationalist/gemini';
```

- Adapter outputs are SDK-compatible (OpenAI `ChatCompletionMessageParam[]`, Anthropic `MessageParam[]`, Gemini `Content[]`).
- **OpenAI**: Supports `toOpenAIMessages` and `toOpenAIMessagesGrouped` (which groups consecutive tool calls).
- **Anthropic**: Maps system messages and tool blocks to Anthropic's specific format.
- **Gemini**: Handles Gemini's unique content/part structure.

### Provider-Specific Examples

#### OpenAI (with Tool Calls)

```ts
import { appendAssistantMessage, appendMessages } from 'conversationalist';
import { toOpenAIMessages } from 'conversationalist/openai';

const response = await openai.chat.completions.create({
  model: 'gpt-4o',
  messages: toOpenAIMessages(conversation),
  tools: [{ type: 'function', function: { name: 'getWeather', ... } }],
});

const toolCalls = response.choices[0]?.message?.tool_calls ?? [];
for (const call of toolCalls) {
  conversation = appendMessages(conversation, {
    role: 'tool-use',
    content: '',
    toolCall: { id: call.id, name: call.function.name, arguments: call.function.arguments },
  });

  const result = await getWeather(JSON.parse(call.function.arguments));
  conversation = appendMessages(conversation, {
    role: 'tool-result',
    content: '',
    toolResult: { callId: call.id, outcome: 'success', content: result },
  });
}
```

#### Anthropic (with Tool Calls)

```ts
import { appendAssistantMessage, appendMessages } from 'conversationalist';
import { toAnthropicMessages } from 'conversationalist/anthropic';

const { system, messages } = toAnthropicMessages(conversation);
const response = await anthropic.messages.create({
  model: 'claude-3-5-sonnet-20240620',
  system,
  messages,
  tools: [{ name: 'getWeather', ... }],
});

for (const block of response.content) {
  if (block.type !== 'tool_use') continue;
  conversation = appendMessages(conversation, {
    role: 'tool-use',
    content: '',
    toolCall: { id: block.id, name: block.name, arguments: block.input },
  });

  const result = await getWeather(block.input);
  conversation = appendMessages(conversation, {
    role: 'tool-result',
    content: '',
    toolResult: { callId: block.id, outcome: 'success', content: result },
  });
}
```

#### Gemini (with Tool Calls)

```ts
import { appendMessages } from 'conversationalist';
import { toGeminiMessages } from 'conversationalist/gemini';

const { systemInstruction, contents } = toGeminiMessages(conversation);
const response = await model.generateContent({
  systemInstruction,
  contents,
  tools: [{ functionDeclarations: [{ name: 'getWeather', ... }] }],
});

const parts = response.response.candidates?.[0]?.content?.parts ?? [];
for (const part of parts) {
  if (!('functionCall' in part)) continue;
  const callId = crypto.randomUUID(); // Gemini doesn't provide IDs, so we generate one
  const args = part.functionCall.args;

  conversation = appendMessages(conversation, {
    role: 'tool-use',
    content: '',
    toolCall: { id: callId, name: part.functionCall.name, arguments: args },
  });

  const result = await getWeather(args);
  conversation = appendMessages(conversation, {
    role: 'tool-result',
    content: '',
    toolResult: { callId, outcome: 'success', content: result },
  });
}
```

## Builder Pattern (Fluent API)

If you prefer a more fluent style, use `withConversation` or `pipeConversation`. These allow you to "mutate" a draft within a scope while still resulting in an immutable object.

```ts
import { withConversation, createConversation } from 'conversationalist';

const conversation = withConversation(createConversation(), (draft) => {
  draft
    .appendSystemMessage('You are a helpful assistant.')
    .appendUserMessage('Hello!')
    .appendAssistantMessage('Hi there!');
});
```

`pipeConversation` allows you to chain multiple transformation functions together:

```ts
import {
  createConversation,
  pipeConversation,
  appendSystemMessage,
  appendUserMessage,
} from 'conversationalist';

const conversation = pipeConversation(
  createConversation(),
  (c) => appendSystemMessage(c, 'You are a helpful assistant.'),
  (c) => appendUserMessage(c, 'Hello!'),
  (c) => appendAssistantMessage(c, 'Hi there!'),
);
```

## Conversation History (Undo/Redo)

Use the `ConversationHistory` class to manage a stack of conversation states. Because every change returns a new immutable object, supporting undo/redo is built into the architecture.

```ts
import { ConversationHistory } from 'conversationalist';

// Create a new history (defaults to an empty conversation)
const history = new ConversationHistory();

// You can use convenience methods that automatically track state
history.appendUserMessage('Hello!');
history.appendAssistantMessage('How are you?');

history.undo(); // State reverts to just "Hello!"
history.redo(); // State advances back to "How are you?"

// Convenience methods for all library utilities are built-in
history.appendUserMessage('Another message');
history.redactMessageAtPosition(0);
history.truncateToTokenLimit(4000);

// Query methods work on the current state
const messages = history.getMessages();
const stats = history.getStatistics();
const tokens = history.estimateTokens();
const ids = history.ids;
const firstMessage = history.get(ids[0]!);
```

### Event Subscription

`ConversationHistory` implements `EventTarget` (and follows the Svelte store contract). You can listen for changes using standard DOM events or the `subscribe` method.

#### Using DOM Events

```ts
const history = new ConversationHistory();

// addEventListener returns a convenient unsubscribe function
const unsubscribe = history.addEventListener('change', (event) => {
  const { type, conversation } = event.detail;
  console.log(`History updated via ${type}`);
});

history.appendUserMessage('Hello!'); // Fires 'push' and 'change' events

unsubscribe(); // Clean up when done
```

#### Using the Store Contract

```ts
// Subscribe returns an unsubscribe function and calls the callback immediately
const unsubscribe = history.subscribe((conversation) => {
  console.log('Current conversation state:', conversation);
});
```

You can also use an `AbortSignal` for automatic cleanup:

```ts
const controller = new AbortController();
history.addEventListener('change', (e) => { ... }, { signal: controller.signal });

// Later...
controller.abort();
```

### Conversation Branching

The `ConversationHistory` class supports branching. When you undo to a previous state and push a new update, it creates an alternate path instead of deleting the old history.

```ts
const history = new ConversationHistory();

history.appendUserMessage('Path A');
history.undo();

history.appendUserMessage('Path B');

console.log(history.branchCount); // 2
console.log(history.getMessages()[0]?.content); // "Path B"

history.switchToBranch(0);
console.log(history.getMessages()[0]?.content); // "Path A"
```

### Serialization

You can serialize the entire history tree (including all branches) to JSON and reconstruct it later.

```ts
// 1. Capture a snapshot
const snapshot = history.snapshot();
// localStorage.setItem('chat_history', JSON.stringify(snapshot));

// 2. Restore from a snapshot
const restored = ConversationHistory.from(snapshot);

// You can also provide a new environment (e.g. with fresh token counters)
const restoredWithEnv = ConversationHistory.from(snapshot, {
  estimateTokens: myNewEstimator,
});
```

## Advanced Serialization

### Schema Versioning

Conversations include a `schemaVersion` field for forward compatibility. Deserialization expects the current schema version; migrate legacy data before calling `deserializeConversation`.

```ts
import { deserializeConversation } from 'conversationalist';
import { CURRENT_SCHEMA_VERSION } from 'conversationalist/versioning';

const conversation = deserializeConversation(JSON.parse(storage));
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
getRoleLabel('tool-use'); // 'Tool Use'
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
import { ConversationHistory } from 'conversationalist';
import {
  conversationHistoryFromMarkdown,
  conversationHistoryToMarkdown,
} from 'conversationalist/markdown';

const history = new ConversationHistory();

// Export to clean, readable Markdown
const markdown = conversationHistoryToMarkdown(history);
// ### User
//
// Hello!
//
// ### Assistant
//
// Hi there!

// Export with full metadata (lossless round-trip)
const markdownWithMetadata = conversationHistoryToMarkdown(history, {
  includeMetadata: true,
});

// Export with additional controls (redaction, transient stripping, hidden handling)
const markdownSafe = conversationHistoryToMarkdown(history, {
  includeMetadata: true,
  stripTransient: true,
  redactToolArguments: true,
  redactToolResults: true,
  includeHidden: false,
});

// Restore from Markdown
const restored = conversationHistoryFromMarkdown(markdownWithMetadata);
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
import { appendUserMessage, createConversation, getMessages } from 'conversationalist';

export function ChatApp() {
  const [conversation, setConversation] = useState(() => createConversation());

  const handleSend = (text: string) => {
    // The new conversation object is set into state
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
import { ConversationHistory, createConversation, getMessages } from 'conversationalist';

export function useChat() {
  // 1. Initialize history (this could also come from context or props)
  const [history] = useState(() => new ConversationHistory());

  // 2. Sync history with local state for reactivity
  const [conversation, setConversation] = useState(history.current);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    // addEventListener returns a cleanup function!
    return history.addEventListener('change', (e) => {
      setConversation(e.detail.conversation);
    });
  }, [history]);

  const sendMessage = useCallback(
    async (text: string) => {
      history.appendUserMessage(text);
      setLoading(true);

      try {
        const response = await fetch('/api/chat', {
          method: 'POST',
          body: JSON.stringify({
            messages: history.toChatMessages(),
          }),
        });
        const data = await response.json();
        history.appendAssistantMessage(data.answer);
      } finally {
        setLoading(false);
      }
    },
    [history],
  );

  return {
    conversation,
    messages: getMessages(conversation),
    loading,
    sendMessage,
    undo: () => history.undo(),
    redo: () => history.redo(),
  };
}
```

> **Note**: `ConversationHistory.addEventListener()` returns an unsubscribe function, which is ideal for cleaning up effects in React (`useEffect`) or Svelte.

### Using with Redux

Redux requires immutable state updates, making **Conversationalist** an ideal companion. You can store the conversation object directly in your store.

```ts
import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import { createConversation, appendUserMessage, Conversation } from 'conversationalist';

interface ChatState {
  conversation: Conversation;
}

const chatSlice = createSlice({
  name: 'chat',
  initialState: {
    conversation: createConversation(),
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

In Svelte 5, you can manage conversation state using the `$state` rune. Since **Conversationalist** is immutable, you update the state by re-assigning the variable with a new conversation object.

```svelte
<script lang="ts">
  import {
    appendUserMessage,
    createConversation,
    getMessages,
  } from 'conversationalist';

  let conversation = $state(createConversation());

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

Svelte 5's runes pair perfectly with **Conversationalist**. You can use the `ConversationHistory` class directly as a store, or wrap it in a class with runes.

```svelte
<script lang="ts">
  import { ConversationHistory, getMessages } from 'conversationalist';

  // history implements the Svelte store contract
  const history = new ConversationHistory();
</script>

<div>
  {#each getMessages($history) as m (m.id)}
    <div>{String(m.content)}</div>
  {/each}
  <button onclick={() => history.appendUserMessage('Hello!')}>
    Send
  </button>
</div>
```

> **Note**: `ConversationHistory.addEventListener()` returns an unsubscribe function, which is ideal for cleaning up reactive effects in Svelte 5 or React hooks.

## API Overview

| Category         | Key Functions                                                                                                                                                                                                               |
| :--------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Creation**     | `createConversation`, `deserializeConversation`                                                                                                                                                                             |
| **Appending**    | `appendUserMessage`, `appendAssistantMessage`, `appendSystemMessage`, `appendToolUse`, `appendToolResult`, `appendMessages`                                                                                                 |
| **Unsafe**       | `createConversationUnsafe`, `appendUnsafeMessage`                                                                                                                                                                           |
| **Streaming**    | `appendStreamingMessage`, `updateStreamingMessage`, `finalizeStreamingMessage`, `cancelStreamingMessage`                                                                                                                    |
| **Modification** | `redactMessageAtPosition`, `replaceSystemMessage`, `collapseSystemMessages`                                                                                                                                                 |
| **Context**      | `truncateToTokenLimit`, `truncateFromPosition`, `getRecentMessages`, `estimateConversationTokens`                                                                                                                           |
| **Querying**     | `getMessages`, `getMessageIds`, `getMessageById`, `getStatistics`                                                                                                                                                           |
| **Conversion**   | `toChatMessages`                                                                                                                                                                                                            |
| **Tooling**      | `getPendingToolCalls`, `getToolInteractions`, `pairToolCallsWithResults`                                                                                                                                                    |
| **Integrity**    | `validateConversationIntegrity`, `assertConversationIntegrity`                                                                                                                                                              |
| **Markdown**     | `toMarkdown`, `fromMarkdown`, `conversationHistoryToMarkdown`, `conversationHistoryFromMarkdown` (from `conversationalist/markdown`)                                                                                        |
| **Export**       | `exportMarkdown`, `normalizeLineEndings` (from `conversationalist/export`)                                                                                                                                                  |
| **Schemas**      | `conversationSchema`, `messageSchema`, `messageInputSchema`, `messageRoleSchema`, `multiModalContentSchema`, `jsonValueSchema`, `toolCallSchema`, `toolResultSchema`, `tokenUsageSchema` (from `conversationalist/schemas`) |
| **Type Guards**  | `isConversation`, `isMessage`, `isMessageInput`, `isToolCall`, `isToolResult`, `isMessageRole`, `isConversationStatus`, `isJSONValue`, `isTokenUsage`, `isMultiModalContent`                                                |
| **Role Labels**  | `ROLE_LABELS`, `LABEL_TO_ROLE`, `getRoleLabel`, `getRoleFromLabel` (from `conversationalist/markdown`)                                                                                                                      |
| **Transient**    | `isTransientKey`, `stripTransientFromRecord`, `stripTransientMetadata`                                                                                                                                                      |
| **Redaction**    | `redactPii`, `createPIIRedactionPlugin`, `createPIIRedaction`, `DEFAULT_PII_RULES` (from `conversationalist/redaction`)                                                                                                     |
| **Versioning**   | `CURRENT_SCHEMA_VERSION` (from `conversationalist/versioning`)                                                                                                                                                              |
| **Sort**         | `sortObjectKeys`, `sortMessagesByPosition` (from `conversationalist/sort`)                                                                                                                                                  |
| **History**      | `ConversationHistory`                                                                                                                                                                                                       |

## Type Guards

Use the built-in type guards to validate unknown values before operating on them:

```ts
import { isConversation, isMessage } from 'conversationalist';

if (isConversation(data)) {
  console.log(data.id);
}

if (isMessage(value)) {
  console.log(value.role);
}
```

## ConversationHistory Events

`ConversationHistory` emits typed events for every mutation. Listen to `change` for any mutation,
or to specific action events if you only care about a subset.

Events and payloads:

- `change`: fired after any mutation; `detail.type` is the specific action (`push`, `undo`, `redo`, `switch`)
- `push`: fired after a new conversation state is pushed
- `undo`: fired after undoing to the previous state
- `redo`: fired after redoing to a child state
- `switch`: fired after switching branches

```ts
import { ConversationHistory, createConversation } from 'conversationalist';

const history = new ConversationHistory(createConversation());

history.addEventListener('change', (event) => {
  console.log(event.detail.type, event.detail.conversation.id);
});

history.addEventListener('push', (event) => {
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

let conversation = createConversation({ title: 'Test' }, testEnv);
```

## Development

```bash
bun install
bun test
bun run build
```
