# Toolbox Registry

## Overview

Register tools, execute tool calls, and query the registry.

For a dedicated guide to tool and registry event streams, see [Eventing](eventing.md).
For a dedicated guide to `queryTools`, see [Searching Tools](searching-tools.md).

### Registration

```typescript
const toolbox = createToolbox();

// Register individual tools
toolbox.register(tool1);
toolbox.register(tool2, tool3);

// Or register configurations directly
toolbox.register(tool1.configuration, tool2.configuration);

// Or initialize with tool configurations
const toolbox = createToolbox([tool1.configuration, tool2.configuration]);

// Or create + register in one step
const registered = toolbox.createTool({
  name: 'quick-tool',
  description: 'Registered on creation',
  input: z.object({ value: z.string() }),
  async execute({ value }) {
    return value.toUpperCase();
  },
});
```

Tool configurations also support lazy execute functions (import from `armorer/lazy`):

```typescript
import { lazy } from 'armorer/lazy';

toolbox.register({
  name: 'lazy-configuration',
  description: 'Loads on first use',
  input: z.object({ id: z.string() }),
  execute: lazy(() => import('./tools/lazy-configuration').then((mod) => mod.execute)),
});
```

Tool configurations and `createTool()` are consistent: if `input` is omitted, Toolbox defaults it to `z.object({})` for no-params tools.

### Execution

```typescript
// Execute a single tool call
const result = await toolbox.execute({
  id: 'call-id',
  name: 'tool-name',
  arguments: { key: 'value' },
});

// Execute multiple tool calls in parallel
const results = await toolbox.execute([
  { id: 'call-1', name: 'tool-a', arguments: { x: 1 } },
  { id: 'call-2', name: 'tool-b', arguments: { y: 2 } },
]);
// Returns: ToolResult[] - array of results in the same order as input calls

// Execute with AbortSignal support
const controller = new AbortController();
const results = await toolbox.execute(calls, { signal: controller.signal });

// Streaming mode: preserve async-iterable tool output
const streamed = await toolbox.execute(
  { id: 'stream-1', name: 'token-tool', arguments: {} },
  { stream: true },
);
for await (const chunk of streamed.stream!) {
  console.log('chunk', chunk);
}
```

When executing multiple tool calls, they are executed in parallel using `Promise.all()`. The return value is an array of `ToolResult` objects in the same order as the input calls. You can listen to events from individual tools using `toolbox.addEventListener`:

```typescript
// Listen for progress events from any tool during parallel execution
toolbox.addEventListener('progress', (event) => {
  console.log(`Tool ${event.detail.tool.identity.name}: ${event.detail.percent}%`);
});

// Listen for execution events
toolbox.addEventListener('execute-start', (event) => {
  console.log(`Starting: ${event.detail.tool.identity.name}`);
});

toolbox.addEventListener('execute-success', (event) => {
  console.log(`Completed: ${event.detail.tool.identity.name}`, event.detail.result);
});
```

### Instrumentation (OpenTelemetry)

Toolbox provides native OpenTelemetry instrumentation via the `armorer/instrumentation` module.

```typescript
import { createToolbox } from 'armorer';
import { instrument } from 'armorer/instrumentation';
import { context, trace } from '@opentelemetry/api';

const toolbox = createToolbox();
const unregister = instrument(toolbox);
const tracer = trace.getTracer('worker');

// All subsequent calls via toolbox.execute() will create OpenTelemetry spans
await tracer.startActiveSpan('temporal.activity', async (activitySpan) => {
  await toolbox.execute(
    { id: 'lookup-account', name: 'lookupAccount', arguments: { accountId: 'acct_123' } },
    {
      parentContext: trace.setSpan(context.active(), activitySpan),
      spanLinks: [{ context: activitySpan.spanContext() }],
    },
  );
});
```

### Middleware

Toolbox supports middleware to wrap tool execution logic. This is useful for cross-cutting concerns like caching, rate limiting, and timeouts.

```typescript
import { createToolbox } from 'armorer';
import { createCacheMiddleware, createRateLimitMiddleware } from 'armorer/middleware';

const toolbox = createToolbox([], {
  middleware: [
    // Cache results for 1 minute
    createCacheMiddleware({ ttlMs: 60000 }),
    // Limit to 10 calls per minute per tool
    createRateLimitMiddleware({ limit: 10, windowMs: 60000 }),
  ],
});
```

Available middleware in `armorer/middleware`:

- `createCacheMiddleware(options)`
- `createRateLimitMiddleware(options)`
- `createTimeoutMiddleware(ms)`

### Testing

Testing agentic systems is easier with mock tools and test registries from `armorer/test`.

```typescript
import { createMockTool, createTestRegistry } from 'armorer/test';

// Create a mock tool with canned responses
const weatherMock = createMockTool({ name: 'get_weather' });
weatherMock.mockResolve({ temp: 72 });

const toolbox = createTestRegistry();
toolbox.register(weatherMock);

// Execute your agent logic using the test registry
// ...

// Assert on execution history
console.log(toolbox.history[0].call.name); // 'get_weather'
console.log(weatherMock.calls.length); // 1
```

### Querying Tools

```typescript
import { queryTools } from 'armorer/query';

// Query by tag (OR match)
const mathTools = queryTools(toolbox, { tags: { any: ['math'] } });

// Require all tags (AND match)
const fastMath = queryTools(toolbox, { tags: { all: ['math', 'fast'] } });

// Exclude tags
const safeTools = queryTools(toolbox, { tags: { none: ['destructive', 'dangerous'] } });

// Query by text (name, description, tags, schema keys, metadata keys)
const tools = queryTools(toolbox, { text: 'weather' });

// Fuzzy text with field scoping
const fuzzy = queryTools(toolbox, {
  text: {
    query: 'weathr',
    mode: 'fuzzy',
    threshold: 0.7,
    fields: ['name', 'description'],
  },
});

// Query by schema keys or shape
const toolsByKeys = queryTools(toolbox, { schema: { keys: ['city'] } });
const toolsByShape = queryTools(toolbox, {
  schema: { matches: z.object({ city: z.string() }) },
});

// Query by metadata
const premiumTools = queryTools(toolbox, { metadata: { eq: { tier: 'premium' } } });
const keyedTools = queryTools(toolbox, { metadata: { has: ['capabilities'] } });
const ranged = queryTools(toolbox, { metadata: { range: { score: { min: 5 } } } });
const owned = queryTools(toolbox, { metadata: { contains: { owner: 'team-' } } });

// Custom predicate
const tools = queryTools(toolbox, { predicate: (tool) => tool.tags?.includes('api') });

// Boolean groups + pagination + selection
const summaries = queryTools(toolbox, {
  or: [{ tags: { any: ['fast'] } }, { text: 'priority' }],
  not: { tags: { any: ['deprecated'] } },
  select: 'summary',
  limit: 10,
  offset: 10,
});
```

#### Query Details

`queryTools(input, criteria?)` filters tools with AND semantics across the provided criteria. It accepts a toolbox registry, a single tool, an array of tools, or any iterable of tools. The `criteria` object is optional; if omitted, all tools are returned.

Core criteria:

- `tags`: `{ any?: string[]; all?: string[]; none?: string[] }` (case-insensitive)
- `text`: `string | { query: string; mode?: 'contains' | 'exact' | 'fuzzy'; fields?: TextQueryField[]; threshold?: number; weights?: Partial<Record<TextQueryField, number>> }`
- `schema`: `{ keys?: string[]; matches?: ToolParametersSchema }`
- `metadata`: `{ has?: string[]; eq?: Record<string, unknown>; contains?: Record<string, string | string[] | number | boolean | null>; startsWith?: Record<string, string>; range?: Record<string, { min?: number; max?: number }>; predicate?: (metadata) => boolean }`
- `predicate`: `(tool) => boolean` for custom filtering

Boolean groups:

- `and`: nested criteria that must all match
- `or`: nested criteria where at least one must match
- `not`: criteria or list of criteria to exclude

Selection and paging:

- `select`: `'tool' | 'name' | 'configuration' | 'summary'` (default: `tool`)
- `limit` / `offset`: pagination controls
- `includeSchema` / `includeToolConfiguration`: when `select: 'summary'`, include schema/configuration

Text query fields (`TextQueryField`) are `name`, `description`, `tags`, `schemaKeys`, and `metadataKeys`. Text queries are tokenized (camelCase, snake_case, and diacritics are normalized) and scores scale with the number of matched tokens. Fuzzy matching uses `threshold` (default `0.7`) to determine a match score.

If the registry was created with `embed`, text queries also use embeddings for semantic matches. Lexical matches still apply, so embeddings only broaden recall rather than replacing the existing behavior.

Embedding matches use cosine similarity over the returned vectors. Queries only consult embeddings when lexical matching fails, and `threshold` applies to the similarity score. You can also disable specific fields by setting their `text.weights` to `0`.

#### Embeddings

Provide an embedder to `createToolbox` to enrich text queries with semantic matching. The registry batches searchable fields for each tool (name, description, tags, schema keys, metadata keys) and stores vectors on registration.

The embedder is called with a list of texts and must return a same-length list of numeric vectors; mismatched or invalid vectors are ignored. Embeddings are cached per tool and can be recomputed with `reindexSearchIndex`.

```typescript
const toolbox = createToolbox([], {
  embed: async (texts) => embeddingsClient.embed(texts),
});
```

```typescript
import { reindexSearchIndex } from 'armorer/query';

reindexSearchIndex(toolbox);
```

If the embedder is asynchronous, the first query may fall back to lexical matching until vectors are available; subsequent calls will use embeddings automatically.

For detailed examples including OpenAI and Pinecone integration, see the [Embeddings & Semantic Search](embeddings.md) documentation.

#### Type Guards

You can use `isToolbox()` to check if an object is a Toolbox registry:

```typescript
import { isToolbox, createToolbox } from 'armorer';

const registry = createToolbox();
if (isToolbox(registry)) {
  // TypeScript knows registry is Toolbox here
  const tools = registry.tools();
  const inspection = registry.inspect();
}
```

This is useful when working with functions that accept multiple types and you need to determine the type at runtime.

#### Middleware

You can transform tool configurations during registration using middleware. Middleware functions receive a tool configuration and return a (possibly modified) configuration. Middleware is applied in order before the tool is built.

```typescript
import { createToolbox, createMiddleware } from 'armorer';

// Create middleware to add metadata
const addSourceMetadata = createMiddleware((configuration) => ({
  ...configuration,
  metadata: { ...configuration.metadata, source: 'middleware' },
}));

// Create middleware to validate configurations
const validateConfiguration = createMiddleware((configuration) => {
  if (!configuration.name || configuration.name.length < 3) {
    throw new Error('Tool name must be at least 3 characters');
  }
  return configuration;
});

const toolbox = createToolbox([], {
  middleware: [validateConfiguration, addSourceMetadata],
});

// All registered tools will have the middleware applied
toolbox.register(myTool);
```

Common middleware patterns:

- **Validation**: Enforce naming conventions, required metadata, or schema constraints
- **Enrichment**: Add default metadata like timestamps, source identifiers, or tags
- **Transformation**: Rename tools, modify schemas, or wrap execute functions
- **Logging**: Track tool registration for observability

Middleware must be synchronous when deserializing from `SerializedToolbox`. The middleware receives the full `ToolConfiguration` including the execute function.

#### getTool() for Deserialization

When deserializing a toolbox (loading from JSON), tool configurations may not have execute functions. Use `getTool()` to provide execute functions dynamically. The resolver can be synchronous or async (for lazy imports).

```typescript
const toolbox = createToolbox(serializedConfigurations, {
  getTool: async (configuration) => {
    // Resolve execute lazily by tool name.
    const mod = await import(`./tools/${configuration.name}.js`);
    return mod.execute;
  },
});
```

If `getTool()` cannot resolve a function (or resolves to a non-function), executing that tool returns an error with the tool name and resolver hint.

#### Pre-computed Embeddings in Metadata

You can also store pre-computed embeddings directly on tool metadata to skip embedding computation during registration. This is useful when you already have embeddings from another source or want to pre-compute them offline.

```typescript
const tool = createTool({
  name: 'pre-embedded-tool',
  description: 'A tool with pre-computed embeddings',
  input: z.object({ input: z.string() }),
  metadata: {
    // Store embeddings as an array of EmbeddingEntry objects
    embeddings: [
      { field: 'name', text: 'pre-embedded-tool', vector: [0.1, 0.2, ...], magnitude: 1.0 },
      { field: 'description', text: 'A tool with pre-computed embeddings', vector: [0.3, 0.4, ...], magnitude: 1.0 },
    ],
    // Or as a single embedding property (alternative format)
    embedding: {
      name: [0.1, 0.2, ...],
      description: [0.3, 0.4, ...],
    },
  },
  async execute({ input }) {
    return input.toUpperCase();
  },
});

// When registering with a toolbox that has an embedder,
// tools with pre-computed embeddings will skip embedding computation
const toolbox = createToolbox([tool], {
  embed: async (texts) => {
    // This won't be called for tools that already have embeddings in metadata
    return embeddingsClient.embed(texts);
  },
});
```

The toolbox will automatically detect and use embeddings from `metadata.embeddings` (array format) or `metadata.embedding` (object format) if present, avoiding redundant embedding computation.

### Registry Events

For complete eventing patterns (including observables and async iterators), see [Eventing](eventing.md).

```typescript
toolbox.addEventListener('registered', (event) => {
  console.log('Registered:', event.detail.name);
});

toolbox.addEventListener('call', (event) => {
  console.log('Calling:', event.detail.call.name);
});

toolbox.addEventListener('complete', (event) => {
  console.log('Completed:', event.detail.result);
});

toolbox.addEventListener('error', (event) => {
  console.error('Error:', event.detail.result.error);
});

toolbox.addEventListener('search', (event) => {
  console.log('Search results:', event.detail.results);
});

toolbox.addEventListener('status:update', (event) => {
  console.log(`${event.detail.name}: ${event.detail.status}`);
});
```

### Context Injection

Pass shared context to all registered tools:

For a complete guide to context sources and `withContext`, see [Context and withContext](context.md).

```typescript
const toolbox = createToolbox([], {
  context: {
    userId: 'user-123',
    sessionId: 'session-456',
  },
});

toolbox.register({
  name: 'context-aware',
  description: 'A tool that uses context',
  input: z.object({}),
  async execute(_params, context) {
    // Access context.userId and context.sessionId
    console.log('User:', context.userId);
    return 'ok';
  },
});
```

### Inspection

`toolbox.inspect()` returns a snapshot of the registry for logging, diagnostics, or UI inventory screens. It reports counts plus a list of tool inspections. Detail levels control how much schema and metadata information is included: `summary` returns only name/description/tags, `standard` (default) adds schema keys and metadata flags, and `full` adds a simplified schema shape for each tool. Inspection is side-effect free and returns copies so you can safely log or mutate the output.

```typescript
const inspection = toolbox.inspect(); // 'standard' detail level
const summary = toolbox.inspect('summary'); // Less detail
const full = toolbox.inspect('full'); // Full schema shapes

console.log(inspection.counts.total); // Number of registered tools
console.log(inspection.tools); // Array of tool inspections
```

Example shape (standard detail):

```typescript
const inspection = toolbox.inspect();

console.log(inspection.counts); // { total, withTags, withMetadata }
console.log(inspection.tools[0]);
// {
//   name: 'fetch-weather',
//   description: 'Get current weather for a location',
//   tags: ['weather', 'api', 'external'],
//   schema: { keys: ['city', 'units'] },
//   metadata: { hasCustomMetadata: true, capabilities: ['read'], effort: 'low' }
// }
```

### Serialization

```typescript
// Export for storage/transmission
const serialized = toolbox.toJSON();

// Rehydrate from serialized state
const restored = createToolbox(serialized);
```

`SerializedToolbox` is a `ToolConfiguration[]` that includes execute functions, so it is meant for in-process cloning. Functions are not JSON-serializable, so `JSON.stringify(toolbox.toJSON())` will drop them. If you need cross-process persistence, store your own manifest (name, input schema, metadata, module path) and rebuild configurations at startup, typically using `lazy(() => import(...))` for the execute function.

### Combining Toolboxes

Use `.extend()` for immutable composition from an existing toolbox:

```typescript
import { createToolbox } from 'armorer';

const base = createToolbox([addTool, subtractTool], {
  context: { workspaceId: 'ws-1' },
});

const extended = base.extend(formatTool, parseTool);
// `base` is unchanged. `extended` includes all four tools.

const adminToolbox = createToolbox([auditTool], {
  context: { role: 'admin' },
});

const merged = base.extend(adminToolbox);
// Context merge is shallow, last toolbox wins:
// { workspaceId: 'ws-1', role: 'admin' }
```

Use `combineToolboxes(...)` when merging many toolboxes at once:

```typescript
import { combineToolboxes } from 'armorer';

const combined = combineToolboxes(mathToolbox, stringToolbox, adminToolbox);
console.log(combined.tools()); // All tools from all inputs
```

Behavior for both `.extend(toolbox)` and `combineToolboxes(...)`:

- Tools are copied via `toJSON()` into a new toolbox
- If multiple toolboxes define the same tool name, the **last** one wins
- Contexts are shallow-merged in input order (last one wins on key collisions)

`combineToolbox(...)` remains available as a compatibility alias but is deprecated in favor of `combineToolboxes(...)`.
