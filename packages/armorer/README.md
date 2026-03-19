# Toolbox

A lightweight, type-safe registry for validated AI tools. Build tools with Zod schemas and metadata, register them in a toolbox, execute them, and query them with registry helpers and event hooks.

## Table of Contents

- [Overview](#overview)
- [Features](#features)
- [Package Structure](#package-structure)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Safety, Policy, and Metadata](#safety-policy-and-metadata)
- [Creating Tools](#creating-tools)
- [TypeScript](#typescript)
- [Documentation](#documentation)
- [License](#license)

## Overview

Toolbox turns tool calling into a structured, observable, and searchable workflow. Define schemas once, validate at runtime, and export tools to popular providers without rewriting adapters.

## Features

- Zod-powered schema validation with TypeScript inference
- Central tool registry with execution, policy, and event hooks
- Query helpers with text, tag, schema, and metadata filters
- Semantic search with vector embeddings (OpenAI, Pinecone, etc.)
- Provider adapters for OpenAI, Anthropic, and Gemini
- Tool composition utilities (pipe/bind/when/parallel/retry)
- **OpenTelemetry Instrumentation**: Native tracing for agentic loops
- **Built-in Middleware**: Caching, Rate Limiting, and Timeouts
- **Testing Utilities**: Mock tools and test registries for easy verification
- MCP server integration for exposing tools over MCP
- OpenAI Agents SDK integration with tool gating and MCP support for Claude Agent SDK
- Concurrency controls and execution tracing hooks
- Pre-configured search tool for semantic tool discovery in agentic workflows

## Package Structure

Toolbox is organized into focused submodules so you can import only what you need:

### Core Modules

#### `armorer` (Main Entry Point)

The primary API for creating and managing tools:

```typescript
import { createToolbox, createTool, isTool } from 'armorer';
```

**Exports:** `createToolbox`, `createTool`, `createToolCall`, `combineToolboxes` (plus deprecated alias `combineToolbox`), `lazy`, `withContext`, `isTool`, `isToolbox`, `createMiddleware`, provider import helpers on `createToolbox`, and all core types.

#### `armorer/utilities`

Composition and utility functions:

```typescript
import { pipe, parallel, retry, when } from 'armorer/utilities';
```

**Exports:** Everything from main entry point **plus** `pipe`, `bind`, `parallel`, `retry`, `when`, `tap`, `preprocess`, `postprocess`, `PipelineError`, error utilities, and composition types.

#### `armorer/query`

Query helpers and predicates for filtering tools:

```typescript
import { queryTools, textMatches, tagsMatchAll, schemaMatches } from 'armorer/query';
```

**Exports:** `queryTools`, `reindexSearchIndex`, `textMatches`, `tagsMatchAll`, `tagsMatchAny`, `tagsMatchNone`, `schemaMatches`, `schemaHasKeys`, and related types.

#### `armorer/inspect`

Tool and registry inspection utilities:

```typescript
import { inspectTool, inspectRegistry } from 'armorer/inspect';
```

**Exports:** `inspectTool`, `inspectRegistry`, `extractSchemaSummary`, `extractMetadataFlags`, and Zod schemas for inspection results.

### Provider Adapters

#### `armorer/adapters/openai`

OpenAI Chat Completions API format:

```typescript
import {
  formatOpenAIToolResults,
  formatOpenAIToolResultsAsync,
  fromOpenAITools,
  parseOpenAIToolCalls,
  toOpenAITools,
} from 'armorer/adapters/openai';
```

#### `armorer/adapters/anthropic`

Anthropic Messages API format:

```typescript
import {
  formatAnthropicToolResults,
  fromAnthropicTools,
  parseAnthropicToolCalls,
  toAnthropicTools,
} from 'armorer/adapters/anthropic';
```

#### `armorer/adapters/gemini`

Google Gemini API format:

```typescript
import {
  formatGeminiToolResults,
  fromGeminiTools,
  parseGeminiToolCalls,
  toGeminiTools,
} from 'armorer/adapters/gemini';
```

Toolboxes also expose lazy provider exporters, and `createToolbox` exposes matching lazy provider import helpers:

```typescript
const openAITools = await toolbox.toOpenAITools();
const importedToolbox = await createToolbox.fromOpenAITools(openAITools, {
  getTool(configuration) {
    return async (params) => {
      throw new Error(`Add execute for ${configuration.name}`);
    };
  },
});
```

### Infrastructure

#### `armorer/instrumentation`

OpenTelemetry tracing:

```typescript
import { instrument } from 'armorer/instrumentation';
```

#### `armorer/middleware`

Standard middleware (caching, rate limiting, timeouts, truncation):

```typescript
import {
  createCacheMiddleware,
  createRateLimitMiddleware,
  createTimeoutMiddleware,
  createTruncationMiddleware,
} from 'armorer/middleware';
```

#### `armorer/test`

Testing utilities:

```typescript
import { createMockTool, createTestRegistry } from 'armorer/test';
```

### Integrations

#### `armorer/mcp` (or `armorer/integrations/mcp`)

Model Context Protocol server integration:

```typescript
import { createMCP, toMcpTools, fromMcpTools } from 'armorer/mcp';
```

#### `armorer/adapters/open-ai/agents`

OpenAI Agents SDK integration with tool gating:

```typescript
import {
  toOpenAIAgentTools,
  createOpenAIToolGate,
} from 'armorer/adapters/open-ai/agents';
```

### Other Utilities

#### `armorer/tools`

Pre-built tools (search, etc.):

```typescript
import { createSearchTool } from 'armorer/tools';
```

#### `armorer/utilities`

Composition utilities (re-exported from `armorer/utilities`):

```typescript
import { pipe, bind, parallel } from 'armorer/utilities';
```

## Quick Start

```typescript
import { createToolbox, createTool } from 'armorer';
import { z } from 'zod';

const addNumbers = createTool({
  name: 'add-numbers',
  description: 'Add two numbers together',
  input: z.object({
    a: z.number(),
    b: z.number(),
  }),
  tags: ['math', 'calculator'],
  async execute({ a, b }) {
    return a + b;
  },
});

const toolbox = createToolbox([addNumbers]);

const toolCall = await toolbox.execute({
  id: 'call-123',
  name: 'add-numbers',
  arguments: { a: 5, b: 3 },
});

console.log(toolCall.result); // 8
```

## Immutable Toolbox Composition

Compose toolboxes without mutating existing instances.

```typescript
import { createToolbox, combineToolboxes } from 'armorer';

const base = createToolbox([mathTool], {
  context: { region: 'us-east-1' },
});

const extended = base.extend(stringTool);
// `base` is unchanged, `extended` has both tools.

const adminTools = createToolbox([auditTool], {
  context: { role: 'admin' },
});

const merged = base.extend(adminTools);
// Context is shallow merged, last toolbox wins:
// merged context => { region: 'us-east-1', role: 'admin' }

const combined = combineToolboxes(base, adminTools);
// Same merge rules, useful when combining many toolboxes at once.
```

## Safety and Policy

Use policy hooks to block or gate risky actions before execution.

## Batch Execution

Execute multiple tools in parallel or sequentially with global controls.

```ts
const results = await toolbox.execute([call1, call2, call3], {
  concurrency: 5, // Global concurrency limit
  mode: 'parallel', // 'parallel' | 'sequential'
  errorMode: 'collect', // 'collect' (default) | 'failFast'
});
```

## Approval Flows

Policies can pause execution for human approval or input.

```ts
const toolbox = createToolbox([], {
  policy: {
    async beforeExecute(context) {
      if (context.metadata?.sensitive) {
        return {
          status: 'needs_approval',
          reason: 'Sensitive action requires confirmation',
        };
      }
      return { allow: true };
    },
  },
});

const result = await toolbox.execute(sensitiveCall);
if (result.outcome === 'action_required') {
  // Present approval UI to user...
}
```

## Agent Integration

Toolbox provides helpers to integrate with LLM providers like OpenAI.

```typescript
import {
  formatOpenAIToolResults,
  formatOpenAIToolResultsAsync,
  parseOpenAIToolCalls,
  toOpenAITools,
} from 'armorer/adapters/openai';

// 1. Export tools
const tools = toOpenAITools(toolbox);

// 2. Call model
const completion = await openai.chat.completions.create({ tools, ... });

// 3. Parse and execute
const toolCalls = parseOpenAIToolCalls(completion.choices[0].message.tool_calls);
const results = await toolbox.execute(toolCalls);

// 4. Format results
const messages = formatOpenAIToolResults(results);

// Use async formatter when any tool call uses { stream: true }
const streamingMessages = await formatOpenAIToolResultsAsync(results);
```

If you want the root package to stay adapter-light until you need it, use the lazy toolbox methods instead:

```typescript
const tools = await toolbox.toOpenAITools();
const imported = await createToolbox.fromOpenAITools(tools, {
  getTool(configuration) {
    return async (params) => loadExecute(configuration.name, params);
  },
});
```

## Using with Conversationalist

Use `armorer` for tool schemas, provider tool definitions, tool-call parsing, and execution. Use `conversationalist` for the persistent conversation state and provider message history.

```typescript
import {
  appendToolCalls,
  appendToolResultsAsync,
  appendUserMessage,
  createConversationHistory,
} from 'conversationalist/conversation';
import { toOpenAIMessagesGrouped } from 'conversationalist/adapters/openai';
import { createToolbox } from 'armorer';
import { parseOpenAIToolCalls, toOpenAITools } from 'armorer/adapters/openai';

let conversation = createConversationHistory({ title: 'Weather' });
conversation = appendUserMessage(conversation, 'What is the weather in Denver?');

const tools = toOpenAITools(toolbox);
const messages = toOpenAIMessagesGrouped(conversation);
const completion = await openai.chat.completions.create({ model: 'gpt-4o', messages, tools });

const toolCalls = parseOpenAIToolCalls(completion.choices[0]?.message?.tool_calls);
conversation = appendToolCalls(conversation, toolCalls);

const results = await toolbox.execute(toolCalls, { stream: true });
conversation = await appendToolResultsAsync(conversation, results);
```

See [Using `armorer` with `conversationalist`](documentation/conversationalist-integration.md) for complete OpenAI, Anthropic, and Gemini examples.

## Observability (OpenTelemetry)

Native instrumentation for distributed tracing.

```ts
import { createToolbox } from 'armorer';
import { instrument } from 'armorer/instrumentation';

const toolbox = createToolbox();
instrument(toolbox); // Auto-wires all tool calls to OTel Spans
```

## Middleware

Batteries-included middleware for production needs.

```ts
import { createToolbox } from 'armorer';
import {
  createCacheMiddleware,
  createRateLimitMiddleware,
  createTruncationMiddleware,
} from 'armorer/middleware';

const toolbox = createToolbox([], {
  middleware: [
    createCacheMiddleware({ ttlMs: 60000 }),
    createRateLimitMiddleware({ limit: 100, windowMs: 60000 }),
    createTruncationMiddleware({ maxCharacters: 2000 }),
  ],
});
```

### Truncation

Prevent oversized tool results from blowing up context windows. The truncation utilities safely handle UTF-16 surrogate pairs and strip base64 data.

```ts
import { truncateToolResultContent } from 'armorer/truncation';
import { createTruncationMiddleware } from 'armorer/middleware';

// Standalone usage
const truncated = truncateToolResultContent(longResult, {
  maxCharacters: 4000,
  isError: false,
});

// As middleware
const toolbox = createToolbox(tools, {
  middleware: [createTruncationMiddleware({ maxCharacters: 4000 })],
});
```

### Fuzzy Tool Name Resolution

LLMs sometimes mangle tool names (wrong case, dots instead of hyphens). Enable resolution to auto-correct:

```ts
const toolbox = createToolbox(tools, {
  resolution: true,
});

toolbox.addEventListener('name-resolved', (event) => {
  console.log(`Resolved ${event.detail.originalName} → ${event.detail.resolvedName} (${event.detail.tier})`);
});
```

Resolution tiers (in order): exact → case-insensitive → normalized (dot/slash/underscore → hyphen) → suffix (last segment). Ambiguous matches return not-found for safety.

### Loop Detection

Catch stuck models that repeat the same tool call in a loop:

```ts
const toolbox = createToolbox(tools, {
  loopDetection: true,  // or { warningThreshold: 5, blockThreshold: 10 }
});

toolbox.addEventListener('loop-warning', (event) => {
  console.warn(event.detail.message);
});

toolbox.addEventListener('loop-blocked', (event) => {
  console.error(event.detail.message);
  // Tool call was blocked and returned an error result
});
```

Detectors: simple repeat (same call N times) and ping-pong (alternating between two calls).

## Testing

Utilities for testing tools and agent logic.

```ts
import { createMockTool, createTestRegistry } from 'armorer/test';

const mock = createMockTool({ name: 'weather' });
mock.mockResolve({ temp: 72 });

const toolbox = createTestRegistry();
toolbox.register(mock);

await toolbox.execute({ name: 'weather', arguments: {} });
console.log(toolbox.history[0].call.name); // 'weather'
```

## Safety, Policy, and Metadata

Toolbox supports registry-level policy hooks and per-tool policy for centralized guardrails.
You can also tag tools as mutating or read-only and enforce those tags at the registry. See the [Registry documentation](documentation/registry.md) for details on querying, searching, and middleware.

```ts
import { createToolbox, createTool } from 'armorer';
import { z } from 'zod';

const toolbox = createToolbox([], {
  readOnly: true,
  policy: {
    beforeExecute({ toolName, metadata }) {
      if (metadata?.mutates) {
        return { allow: false, reason: `${toolName} is mutating` };
      }
    },
  },
  telemetry: true,
});

const writeFile = createTool({
  name: 'fs.write',
  description: 'Write a file',
  input: z.object({ path: z.string(), content: z.string() }),
  metadata: { mutates: true },
  async execute() {
    return { ok: true };
  },
});

toolbox.register(writeFile);
```

Metadata keys with built-in enforcement:

- `metadata.mutates: true` marks a tool as mutating
- `metadata.readOnly: true` marks a tool as read-only
- `metadata.dangerous: true` marks a tool as dangerous
- `metadata.concurrency: number` sets a per-tool concurrency limit

Registry options for enforcement:

- `readOnly: true` denies mutating tools automatically
- `allowMutation: false` denies mutating tools automatically
- `allowDangerous: false` denies dangerous tools automatically

Execution tracing events (opt-in via `telemetry: true`):

- `tool.started` with `startedAt`
- `tool.finished` with `status` and `durationMs`

Per-tool concurrency:

```ts
createTool({
  name: 'git.status',
  description: 'status',
  metadata: { concurrency: 1 },
  input: z.object({}),
  async execute() {
    return { ok: true };
  },
});
```

## Creating Tools

### Overview

Define tools with Zod schemas, validation, and typed execution contexts. For advanced patterns like chaining tools together, see [Tool Composition](documentation/composition.md).

### Basic Tool

```typescript
const greetUser = createTool({
  name: 'greet-user',
  description: 'Greet a user by name',
  input: z.object({
    name: z.string(),
    formal: z.boolean().optional(),
  }),
  async execute({ name, formal }) {
    return formal ? `Good day, ${name}.` : `Hey ${name}!`;
  },
});
```

Tools are callable. `await tool(params)` and `await tool.execute(params)` are equivalent. If you need a `ToolResult` object instead of throwing on errors, use `tool.execute(toolCall)` or `tool.executeWith(...)`.

`executeWith(...)` lets you supply params plus `callId`, `timeout` (milliseconds), `signal`, and `stream` in a single call, returning a `ToolResult` instead of throwing. `rawExecute(...)` invokes the underlying implementation with a full `ToolContext` when you need precise control over dispatch/meta or to bypass the `ToolCall` wrapper.

Tool schemas must be object schemas (`z.object(...)` or a plain object shape). Tool calls always pass a JSON object for `arguments`, so wrap primitives inside an object (for example, `z.object({ value: z.number() })`).

You can use `isTool(obj)` to check if an object is a tool:

```typescript
import { isTool, createTool } from 'armorer';

const tool = createTool({ ... });
if (isTool(tool)) {
  // TypeScript knows tool is ToolboxTool here
  console.log(tool.name);
}
```

### Creating and Registering in One Step

You can create a tool and register it with a toolbox in one step by passing the toolbox as the second argument:

```typescript
const toolbox = createToolbox([], {
  context: { userId: 'user-123', apiKey: 'secret' },
});

const tool = createTool(
  {
    name: 'my-tool',
    description: 'A tool with toolbox context',
    input: z.object({ input: z.string() }),
    async execute({ input }, context) {
      // context includes toolbox.context automatically
      console.log('User:', context.userId);
      return input.toUpperCase();
    },
  },
  toolbox, // Automatically registers the tool
);
```

### Tool Without Inputs

If your tool accepts no input arguments, omit `input` (it defaults to `z.object({})`):

```typescript
const healthCheck = createTool({
  name: 'health-check',
  description: 'Verify service is alive',
  async execute() {
    return 'ok';
  },
});
```

### Tool with Metadata

Metadata is a lightweight, out-of-band descriptor for things that should not be part of the tool's input schema. It is useful for discovery and routing (filter/query by tier, cost, capabilities, auth requirements), for UI grouping, or for analytics and policy checks without changing the tool signature.

```typescript
const fetchWeather = createTool({
  name: 'fetch-weather',
  description: 'Get current weather for a location',
  input: z.object({
    city: z.string(),
    units: z.enum(['celsius', 'fahrenheit']).optional(),
  }),
  tags: ['weather', 'api', 'external'],
  metadata: {
    requiresAuth: true,
    rateLimit: 100,
    capabilities: ['read'],
  },
  async execute({ city, units = 'celsius' }) {
    // ... fetch weather data
    return { temp: 22, conditions: 'sunny' };
  },
});
```

### Tool with Context

Use `withContext` to inject shared context into tools:

```typescript
const createToolWithContext = withContext({ userId: 'user-123', apiKey: 'secret' });

const userTool = createToolWithContext({
  name: 'get-user-data',
  description: 'Fetch user data',
  input: z.object({}),
  async execute(_params, context) {
    // Access context.userId and context.apiKey
    return { userId: context.userId };
  },
});
```

### Lazy-Loaded Execute Functions

You can supply `execute` as a promise that resolves to a function. To avoid `import()` starting immediately, wrap the dynamic import with `lazy` so it only loads on first execution:

```typescript
import { lazy } from 'armorer/lazy';

const heavyTool = createTool({
  name: 'heavy-tool',
  description: 'Runs an expensive workflow',
  input: z.object({ input: z.string() }),
  execute: lazy(() => import('./tools/heavy-tool').then((mod) => mod.execute)),
});
```

If the promise rejects or resolves to a non-function, `tool.execute(toolCall)` returns a `ToolResult` with `error` set, and `tool.execute(params)` or calling the tool directly throws an `Error` with the same message.

### Tool Events

Listen to tool execution lifecycle events:

```typescript
const tool = createTool({
  name: 'my-tool',
  description: 'A tool with events',
  input: z.object({ input: z.string() }),
  async execute({ input }, { dispatch }) {
    dispatch({ type: 'progress', detail: { percent: 50, message: 'Processing...' } });
    return input.toUpperCase();
  },
});

tool.addEventListener('execute-start', (event) => {
  console.log('Starting:', event.detail.params);
});

tool.addEventListener('execute-success', (event) => {
  console.log('Result:', event.detail.result);
});

tool.addEventListener('execute-error', (event) => {
  console.error('Error:', event.detail.error);
});

tool.addEventListener('progress', (event) => {
  if (event.detail.percent !== undefined) {
    console.log(`${event.detail.percent}%: ${event.detail.message ?? ''}`);
  } else {
    console.log(event.detail.message ?? 'Progress update');
  }
});
```

### Streaming Output

Tools that return an `AsyncIterable` support two execution modes:

- default (`stream` omitted/`false`): Armorer **collects** chunks into an array and returns that array as `result`.
- `stream: true`: Armorer returns a live stream on `ToolResult.stream` (and `ToolResult.result`), and you consume it incrementally.

```typescript
const streamTool = createTool({
  name: 'stream-tool',
  description: 'Emits tokens',
  input: z.object({}),
  async execute() {
    return {
      async *[Symbol.asyncIterator]() {
        yield 'hello';
        yield 'world';
      },
    };
  },
});

// Collect fallback (default)
const collected = await streamTool.execute({
  id: 'collect-1',
  name: 'stream-tool',
  arguments: {},
});
console.log(collected.result); // ['hello', 'world']

// Live stream mode
const live = await streamTool.execute(
  { id: 'live-1', name: 'stream-tool', arguments: {} },
  { stream: true },
);

for await (const chunk of live.stream!) {
  console.log('chunk', chunk);
}
```

Stream lifecycle events are emitted for both modes: `stream-start`, `stream-chunk`, `stream-end`, and `stream-error`. `output-chunk` continues to be emitted for compatibility.

### Dispatching Progress Events

To report progress from inside a tool, use the `dispatch` function provided in the `ToolContext` (second argument to `execute`). Emit a `progress` event with an optional `percent` number (0–100) and an optional `message`:

```typescript
const longTask = createTool({
  name: 'long-task',
  description: 'Does work in phases',
  input: z.object({ input: z.string() }),
  async execute({ input }, { dispatch }) {
    dispatch({ type: 'progress', detail: { percent: 10, message: 'Queued' } });
    // ... do work
    dispatch({ type: 'progress', detail: { percent: 50, message: 'Halfway' } });
    // ... do more work
    dispatch({ type: 'progress', detail: { percent: 100, message: 'Done' } });
    return input.toUpperCase();
  },
});
```

Then subscribe to `progress` on the tool:

```typescript
longTask.addEventListener('progress', (event) => {
  console.log(`${event.detail.percent}%: ${event.detail.message ?? ''}`);
});
```

## Search Tool for Agentic Workflows

Toolbox includes a pre-configured search tool that lets agents discover available tools dynamically. This is useful when you have many tools and want the LLM to find the right one for a task.

```typescript
import { createToolbox, createTool } from 'armorer';
import { createSearchTool } from 'armorer/tools';
import { z } from 'zod';

const toolbox = createToolbox();

// Install the search tool - it auto-registers with the toolbox
createSearchTool(toolbox);

// Register your tools (can be done before or after the search tool)
createTool(
  {
    name: 'send-email',
    description: 'Send an email to recipients',
    input: z.object({ to: z.string(), subject: z.string(), body: z.string() }),
    tags: ['communication'],
    async execute({ to, subject, body }) {
      return { sent: true };
    },
  },
  toolbox,
);

// Agents can now search for tools via toolbox.execute()
const result = await toolbox.execute({
  name: 'search-tools',
  arguments: { query: 'contact someone' },
});

console.log(result.result);
// [{ name: 'send-email', description: '...', tags: ['communication'], score: 1.5 }]
```

The search tool:

- **Auto-registers** with the toolbox when created
- **Discovers tools dynamically** - finds tools registered before or after it
- **Works with provider adapters** - included in `toOpenAITools(toolbox)`, `toAnthropicTools(toolbox)`, and `toGeminiTools(toolbox)`
- **Supports semantic search** when embeddings are configured on the toolbox

See [Search Tool documentation](documentation/search-tool.md) for filtering by tags, configuration options, and agentic workflow examples.

## TypeScript

### Overview

TypeScript inference guidance and type-level patterns. For a complete list of exported types, see the [API Reference](documentation/api-reference.md).

Toolbox is written in TypeScript and provides full type inference:

```typescript
const tool = createTool({
  name: 'typed-tool',
  description: 'A typed tool',
  input: z.object({
    count: z.number(),
    name: z.string().optional(),
  }),
  async execute(params) {
    // params is typed as { count: number; name?: string }
    return params.count * 2;
  },
});

// Return type is inferred
const result = await tool({ count: 5 }); // number
```

## Documentation

Longer-form docs live in `documentation/`:

- [Common Patterns](documentation/patterns/) - Circuit breakers, session management, request deduplication, resource pooling, fallback tools, audit trails, cost tracking, and more
- [Toolbox Registry](documentation/registry.md) - Registration, execution, querying, searching, middleware, and serialization
- [Searching Tools](documentation/searching-tools.md) - Discover tools with `queryTools`
- [Eventing](documentation/eventing.md) - Tool and toolbox events, streaming APIs, and progress/status patterns
- [Context and withContext](documentation/context.md) - Shared toolbox context, tool-local context injection, and runtime execution context
- [Tool Composition](documentation/composition.md) - `pipe`, `bind`, `tap`, `when`, `parallel`, `retry`, `preprocess`, `postprocess`
- [Embeddings & Semantic Search](documentation/embeddings.md) - Vector embeddings with OpenAI and Pinecone
- [Integrations](documentation/integrations/) - Pinecone, LanceDB, and Chroma integration guides
- [Pinecone Integration](documentation/integrations/pinecone.md) - Managed vector database for hosted semantic retrieval
- [LanceDB Integration](documentation/integrations/lancedb.md) - Serverless vector database for local and cloud deployments
- [Chroma Integration](documentation/integrations/chroma.md) - Open-source embedding database with built-in embedding functions
- [Search Tool](documentation/search-tool.md) - Pre-configured tool for semantic tool discovery in agentic workflows
- [AbortSignal Support](documentation/about-signal.md) - Cancellation and timeout handling
- [Testing Utilities](documentation/testing.md) - `createMockTool` and `createTestRegistry` for test workflows
- [JSON Schema Output](documentation/json-schema.md) - Export tools as JSON Schema
- [Provider Adapters](documentation/provider-adapters.md) - OpenAI, Anthropic, and Gemini integrations
- [MCP Server](documentation/mcp.md) - Expose tools over Model Context Protocol
- [Agent SDK Integrations](documentation/agent-sdk-integrations.md) - OpenAI and Anthropic Agent SDK usage via MCP
- [OpenAI Agents SDK](documentation/openai-agents-sdk.md) - Integration with `@openai/agents` including tool gating
- [Public API Reference](documentation/api-reference.md) - Complete API reference with all exports and types
- [Contributing](CONTRIBUTING.md) - Local development workflows

## Roadmap

See [ROADMAP.md](ROADMAP.md) for planned features, community requests, and version goals.

## License

MIT. See `LICENSE`.
