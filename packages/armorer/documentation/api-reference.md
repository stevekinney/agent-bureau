# Public API Reference

## Overview

Reference for exported functions, types, and subpath APIs. New code should prefer `armorer/core` for tool specs and registry/search, and `armorer/utilities` for execution and composition.

### Utilities export: `armorer/utilities`

#### `createTool(options)`

Creates an executable tool with Zod validation, events, and a callable proxy interface.

Options (`CreateToolOptions`):

- `name`: string (maps to `identity.name`)
- `description`: string (maps to `display.description`)
- `input?`: Zod object schema for input validation or a plain object shape; defaults to `z.object({})`.
- `execute`: async `(params: TInput, context: ToolContext) => TOutput`.
- `tags?`: kebab-case strings, de-duped.
- `metadata?`: `ToolMetadata`, `Promise<ToolMetadata>`, `() => ToolMetadata`, or `() => Promise<ToolMetadata>`.
- `timeout?`: number (milliseconds).
- `concurrency?`: number (per-tool concurrency limit).

Returns: `Tool` for sync metadata, `Promise<Tool>` for async metadata.

Exposed properties and methods:

- `tool(params)` call signature.
- `identity`: `{ name, namespace, version }`.
- `display`: `{ title, description, examples }`.
- `input`: the Zod input schema.
- `tags`, `metadata`, `configuration`.
- `execute(call | params, options?)`: returns `ToolResult` (for call) or raw output (for params).
- `addEventListener`, `dispatchEvent`, `on`, `once`, `subscribe`, `toObservable`, `events`.
- `complete()`, `completed`.

```typescript
function createTool<...>(
  options: CreateToolOptions<...>,
  toolbox?: Toolbox,
): Tool | Promise<Tool>;
```

#### `createToolbox(serialized?, options?)`

Creates an execution engine and tool registry.

Options (`ToolboxOptions`):

- `context?`: `ToolboxContext` merged into all tool execution contexts.
- `middleware?`: Array of `ToolMiddleware` functions.
- `policy?`: Global policy hooks.
- `telemetry?`: boolean - enable detailed execution events.
- `getTool?`: resolver used when deserialized configurations are missing `execute`; may return a function or `Promise<function>`.

### Instrumentation export: `armorer/instrumentation`

#### `instrument(toolbox, options?)`

Auto-instruments a Toolbox instance with OpenTelemetry tracing.

```typescript
import { instrument } from 'armorer/instrumentation';
unregister = instrument(toolbox);
```

### Middleware export: `armorer/middleware`

#### `createCacheMiddleware(options)`

Caches tool results based on input hash.

#### `createRateLimitMiddleware(options)`

Limits tool execution frequency.

#### `createTimeoutMiddleware(ms)`

Enforces a hard execution timeout.

### Testing export: `armorer/test`

See also: [Testing Utilities](testing.md)

#### `createMockTool(options)`

Creates a mock tool with `.mockResolve()` and `.mockReject()` helpers and a `.calls` history.

#### `createTestRegistry()`

Creates a Toolbox instance that records all execution history in a `.history` array.

### Core export: `armorer/core`

#### `defineTool(options)`

Defines a static tool specification (identity, display, input) without execution logic. Recommended for shared libraries.

#### `serializeToolDefinition(tool)`

Converts a tool definition to a provider-neutral JSON-serializable format.

Registry surface (`Toolbox`):

- `register(...entries: (ToolConfiguration | Tool)[])`
- `createTool(options)`: create and register a tool in one call
- `execute(call | calls)`
- `extend(...entries | toolbox)`: return a new composed toolbox without mutating the original
- `tools()` (returns registered `Tool[]` for registry helpers)
- `getTool(name)`
- `getMissingTools(names)`
- `hasAllTools(names)`
- `inspect(detailLevel?: InspectorDetailLevel)`
- `toJSON(): SerializedToolbox`
- Event methods: `addEventListener`, `dispatchEvent`, `on`, `once`, `subscribe`, `toObservable`, `events`
- Lifecycle: `complete()`, `completed`

`register()` accepts tool instances or raw configurations. When you register a tool, its `configuration` is stored for serialization. `createTool()` is a convenience that uses the same options as `createTool(options)`, registers the result, and returns the registered instance. If `input` is omitted (in either `register()` raw configuration or `createTool()`), Toolbox defaults it to `z.object({})`.

Signature:

```typescript
const tool = toolbox.createTool(options);
```

`ToolConfiguration.execute` receives `ToolRuntimeContext`, which includes any base context plus `dispatchEvent`, `configuration`, `toolCall`, `signal`, and `timeout` (milliseconds). `ToolConfiguration.execute` may also be a `Promise` that resolves to an execute function, or use `lazy(() => import(...))` to defer dynamic imports.

#### `getMissingTools(names)`

Returns the subset of tool names that are not registered.

Example:

```typescript
const missing = toolbox.getMissingTools(['toolA', 'toolB', 'toolC']);
// -> ['toolB', 'toolC']
```

Signature:

```typescript
function createToolbox(serialized?: SerializedToolbox, options?: ToolboxOptions): Toolbox;
```

#### `combineToolboxes(...toolboxes)`

Merges one or more toolboxes into a new toolbox. Tool collisions and context collisions both resolve with "last wins" semantics based on argument order.

Signature:

```typescript
function combineToolboxes(...toolboxes: [Toolbox, ...Toolbox[]]): Toolbox;
```

`combineToolbox(...toolboxes)` is still exported as a compatibility alias but deprecated.

#### `isTool(value)`

Type guard for `Tool`.

Signature:

```typescript
function isTool(value: unknown): value is Tool;
```

#### Tool events (`DefaultToolEvents`)

See [Eventing](eventing.md) for end-to-end usage patterns.

- `execute-start`: `{ params }`
- `validate-success`: `{ params, parsed }`
- `validate-error`: `{ params, error }`
- `execute-success`: `{ result }`
- `execute-error`: `{ error }`
- `settled`: `{ result?, error? }`
- `progress`: `{ percent?, message? }`
- `stream-start`: `{ mode: 'stream' | 'collect' }`
- `stream-chunk`: `{ chunk, index }`
- `stream-end`: `{ chunks, completed }`
- `stream-error`: `{ error, index }`
- `output-chunk`: `{ chunk }`
- `log`: `{ level, message, data? }`
- `cancelled`: `{ reason? }`
- `status-update`: `{ status }`

Execution and validation events include `toolCall` and `configuration` in their detail payload.

#### Registry events (`ToolboxEvents`)

See [Eventing](eventing.md) for subscription patterns and bubbled event behavior.

- `call`: `{ tool, call }`
- `complete`: `{ tool, result }`
- `error`: `{ tool?, result }`
- `not-found`: `ToolCall` for missing tool
- `query`: `{ criteria?, results }`
- `search`: `{ options, results }`
- `status:update`: `ToolStatusUpdate` for UI progress

`query` events are emitted by `queryTools` when you pass a toolbox as input.

#### Query helpers and types

Registry helpers live in `armorer/query` and accept a toolbox, tool, or iterable.
See also: [Searching Tools](searching-tools.md).

Functions:

- `queryTools(input, criteria?)`: filter-only query
- `reindexSearchIndex(input)`: rebuild cached text indexes on demand

`ToolQuery` fields include `tags`, `text`, `schema`, `metadata`, `predicate`, and boolean groups (`and`, `or`, `not`) plus paging/selection (`limit`, `offset`, `select`). `TagFilter` supports `any`, `all`, and `none`. `SchemaFilter` supports `keys` and `matches`. `MetadataFilter` supports `has`, `eq`, `contains`, `startsWith`, `range`, and `predicate`. `ToolPredicate` is `(tool) => boolean`.

Functions:

- `tagsMatchAny(tags)`: match tools that contain any tag
- `tagsMatchAll(tags)`: match tools that contain all tags
- `tagsMatchNone(tags)`: exclude tools that contain any tag
- `schemaMatches(schema)`: loose schema match
- `schemaHasKeys(keys)`: require schema keys
- `textMatches(query)`: search name, description, tags, schema keys, and metadata keys

#### Type guards

- `isTool(obj)`: returns `obj is Tool` - checks if an object is a tool
- `isToolbox(input)`: returns `input is Toolbox` - checks if an object is a Toolbox registry

#### Inspection helpers and schemas

- `inspectTool(tool, detailLevel?)`: returns `ToolInspection`
- `inspectRegistry(tools, detailLevel?)`: returns `RegistryInspection`
- `extractSchemaSummary(schema, includeShape?)`: returns `SchemaSummary`
- `extractMetadataFlags(metadata)`: returns `MetadataFlags`

Runtime validation schemas:

- `SchemaSummarySchema`
- `MetadataFlagsSchema`
- `ToolInspectionSchema`
- `RegistryInspectionSchema`

#### Type exports

Core registry types (main export):

- `Toolbox`: registry interface
- `ToolboxContext`: base context bag for registry execution
- `ToolboxOptions`: options for `createToolbox`
- `ToolboxEvents`: registry event map
- `ToolRuntimeContext`: context passed to `ToolConfiguration.execute`
- `SerializedToolbox`: serialized `ToolConfiguration[]`
- `ToolStatusUpdate`: registry status payload

Registry helper types (`armorer/query`):

- `QueryResult`: array of `Tool`
- `QuerySelectionResult`: query result union for selections
- `Embedder`: `(texts: string[]) => number[][] | Promise<number[][]>` - function to generate embeddings
- `EmbeddingVector`: numeric vector returned by `Embedder`
- `EmbeddingMatch`: embedding match metadata with `field` and `score`
- `TagFilter`: tag filters (`any`, `all`, `none`)
- `SchemaFilter`: schema filters (`keys`, `matches`)
- `MetadataFilter`: metadata filters (`has`, `eq`, `contains`, `startsWith`, `range`, `predicate`)
- `MetadataPrimitive`: primitive metadata values
- `MetadataRange`: numeric range for metadata
- `ToolQuery`: query input + paging/selection
- `ToolQueryCriteria`: filter-only query input
- `ToolQueryOptions`: paging/selection options
- `ToolQuerySelect`: selection mode (`tool`, `name`, `configuration`, `summary`)
- `ToolSummary`: summarized tool shape

Tool types:

- `CreateToolOptions`: options for `createTool`
- `WithContext`: helper type for merged context
- `Tool`: callable tool interface
- `ToolConfiguration`: registry tool configuration (execute may be lazy)
- `ToolMetadata`: metadata bag for filtering and inspection
- `ToolParametersSchema`: Zod object schema alias
- `ToolEventsMap`: event name to detail map
- `DefaultToolEvents`: built-in tool event map
- `ToolCustomEvent`: typed event wrapper
- `ToolContext`: tool execution context
- `ToolCallWithArguments`: tool call with parsed arguments
- `ToolExecuteOptions`: execution options (`signal`, `timeout` in milliseconds, `stream`)
- `ToolExecuteWithOptions`: execution options with params, callId, timeout in milliseconds, and `stream`

Policy types:

- `ToolPolicyHooks`: hooks for policy enforcement (`beforeExecute`, `afterExecute`)
- `ToolPolicyContext`: context passed to `beforeExecute` hook
- `ToolPolicyAfterContext`: context passed to `afterExecute` hook
- `ToolPolicyDecision`: return type from policy hooks (`{ allow: boolean, reason?: string }`)
- `ToolPolicyContextProvider`: function returning policy context

Validation and diagnostics types:

- `OutputValidationMode`: `'warn' | 'error' | 'silent'`
- `OutputValidationResult`: result of output validation
- `ToolValidationReport`: validation report with warnings and errors
- `ToolValidationWarning`: individual validation warning
- `ToolRepairHint`: hint for repairing validation issues
- `ToolDiagnostics`: diagnostics options for tools
- `ToolDiagnosticsAdapter`: adapter for custom diagnostics reporting
- `ToolDigestOptions`: options for tool digest generation

Middleware types:

- `ToolMiddleware`: middleware function type for tool configuration transformation

Query types:

- `ToolPredicate`: sync tool predicate
- `TextQuery`: text query input (string or object)
- `TextQueryField`: text query fields
- `TextQueryMode`: `contains` | `exact` | `fuzzy`
- `TextQueryWeights`: per-field weights for text queries
- `NormalizedTextQuery`: normalized text query object
- `TextMatchScore`: text match scoring result
- `TextSearchIndex`: cached text index shape

Inspection types:

- `InspectorDetailLevel`: `summary` | `standard` | `full`
- `SchemaSummary`: schema keys and optional shape summary
- `MetadataFlags`: extracted metadata flags
- `ToolInspection`: per-tool inspection output
- `RegistryInspection`: registry inspection output

Core types:

- `ToolCall`: LLM tool call shape
- `ToolResult`: execution result shape
- `MinimalToolConfiguration`: minimal tool configuration

Event system types (re-exported from `event-emission`):

- `AddEventListenerOptionsLike`: listener options
- `AsyncIteratorOptions`: async iterator configuration
- `MinimalAbortSignal`: AbortSignal-compatible shape
- `ObservableLike`: minimal observable interface
- `Observer`: observable callback set
- `Subscription`: subscription handle

### Subpath export: `armorer/mcp`

MCP server integration.

- `createMCP(toolbox, options?)`: build an MCP server from a toolbox registry
- `toMcpTools(input, options?)`: convert toolbox tools into MCP tool definitions with handlers
- `fromMcpTools(tools, options?)`: convert MCP tool definitions into executable toolbox tools
- `toolConfigurationFromMetadata(tool)`: read MCP configuration from `tool.metadata.mcp`
- Types: `CreateMCPOptions`, `MCPToolConfiguration`, `MCPToolLike`, `MCPToolDefinition`, `MCPToolSource`, `MCPToolHandler`, `ToMCPToolsOptions`, `FromMCPToolsOptions`, `MCPResourceRegistrar`, `MCPPromptRegistrar`

### Subpath export: `armorer/query`

Registry query helpers and types.

#### Registry API

- `queryTools(input, criteria?)`: filter-only query
- `reindexSearchIndex(input)`: rebuild cached text indexes

### Subpath export: `armorer/lazy`

Lazy helper for deferring execute function imports.

#### Lazy API

- `lazy(loader)`: memoized async loader for tool execute functions

### Subpath export: `armorer/utilities`

Composition helpers and types.

#### Composition API

- `pipe(...tools)`: left-to-right composition (2 to 9 tools); returns an `Tool`
- `bind(tool, bound, options?)`: bind tool parameters; returns an `Tool`
- `tap(tool, effect)`: run a side effect and return the original output
- `when(predicate, whenTrue, whenFalse?)`: conditional tool routing
- `parallel(...tools)`: run tools concurrently (2 to 9 tools); returns an array of outputs
- `retry(tool, options?)`: retry a tool on failure with backoff options
- `preprocess(tool, mapper)`: transform inputs before passing to tool; returns an `Tool`
- `postprocess(tool, mapper)`: transform outputs after tool executes; returns an `Tool`
- `PipelineError`: error with `{ stepIndex, stepName, originalError }`

Pipelines created with `pipe()` and tools created with `parallel()` emit `ComposedToolEvents` including `step-start`, `step-complete`, and `step-error`.

#### Composition types

- `AnyTool`: generic tool constraint
- `ToolWithInput`: tool constrained by input type
- `InferToolInput`: extract input type from tool
- `InferToolOutput`: extract output type from tool
- `ComposedTool`: composed tool type
- `ComposedToolEvents`: step event map

### Subpath export: `armorer/adapters/openai` (also `armorer/openai`)

- `toOpenAI(input)`: converts a tool, tool array, or `Toolbox` to OpenAI Chat Completions tools (`OpenAITool` or `OpenAITool[]`)
- `parseToolCalls(toolCalls, mapper?)`: parses OpenAI tool calls into `ToolCallInput[]`
- `formatToolResults(results)`: sync formatter for non-streaming results
- `formatToolResultsAsync(results)`: async formatter that collects streaming results before formatting
- Types: `JSONSchema`, `OpenAIFunction`, `OpenAITool`

### Subpath export: `armorer/adapters/anthropic` (also `armorer/anthropic`)

- `toAnthropic(input)`: converts a tool, tool array, or `Toolbox` to Anthropic Messages tools (`AnthropicTool` or `AnthropicTool[]`)
- Types: `AnthropicInputSchema`, `AnthropicTool`, `JSONSchemaProperty`

### Subpath export: `armorer/adapters/gemini` (also `armorer/gemini`)

- `toGemini(input)`: converts a tool, tool array, or `Toolbox` to Gemini function declarations (`GeminiFunctionDeclaration` or array)
- Type helper: `GeminiTool` for wrapper objects with `functionDeclarations`
- Types: `GeminiFunctionDeclaration`, `GeminiSchema`, `GeminiTool`

### Subpath export: `armorer/open-ai/agents` (also `armorer/adapters/open-ai/agents`)

OpenAI Agents SDK adapter for integrating Toolbox tools with `@openai/agents`.

Functions:

- `toOpenAIAgentTools(input, options?)`: async converter for OpenAI Agents SDK tool format
- `createOpenAIToolGate(options)`: creates a permission gate function for tool access control

Types:

- `OpenAIAgentTool`: return type of OpenAI Agents SDK's `tool()` function
- `OpenAIAgentToolConfiguration`: tool configuration override options
- `OpenAIAgentToolOptions`: options for `toOpenAIAgentTools()`
- `OpenAIAgentToolsResult`: return type of `toOpenAIAgentTools()`
- `OpenAIToolGateOptions`: options for `createOpenAIToolGate()`
- `OpenAIToolGateDecision`: return type of the gate function

### Subpath export: `armorer/tools`

Pre-configured tools for common agentic workflows.

#### Search Tools Tool

A tool that searches for other tools in a Toolbox registry, enabling semantic tool discovery in agentic workflows.

Functions:

- `createSearchTool(toolbox, options?)`: creates a search tool bound to a toolbox

Options (`CreateSearchToolOptions`):

- `limit?`: Default maximum number of tools to return (default: 10)
- `explain?`: Include matching reasons in results (default: false)
- `name?`: Custom tool name (default: 'search-tools')
- `description?`: Custom tool description
- `tags?`: Additional tags to add to the tool
- `register?`: Automatically register with the toolbox (default: true)

Types:

- `CreateSearchToolOptions`: options for `createSearchTool()`
- `SearchToolsResult`: individual search result with name, description, tags, score, and optional reasons
- `SearchToolsInput`: input parameters (query, limit, tags)
- `SearchTool`: the created tool type

Usage:

```typescript
import { createToolbox } from 'armorer';
import { createSearchTool } from 'armorer/tools';

const toolbox = createToolbox();
// ... register tools

const searchTool = createSearchTool(toolbox);
const results = await searchTool({ query: 'send message' });
// [{ name: 'send-email', description: '...', score: 1.5 }, ...]
```

See [Search Tool](search-tool.md) for complete documentation.
