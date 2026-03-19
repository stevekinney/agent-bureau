# Armorer Public API Reference

This document tracks the published export map in [package.json](/Users/stevekinney/Developer/agent-bureau/packages/armorer/package.json). If a symbol is listed here, it is part of the package's current public surface.

## Export Map

| Entry point                       | Purpose                                                                                                                |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `armorer`                         | Common runtime surface for creating tools, creating toolboxes, materializing calls and results, and core runtime types |
| `armorer/core`                    | Low-level tool-definition, registry, schema, query, identity, error, and serialization primitives                      |
| `armorer/query`                   | Query, search, text predicate, and filter helpers                                                                      |
| `armorer/inspect`                 | Inspection helpers and validation schemas                                                                              |
| `armorer/utilities`               | Composition helpers plus shared materializers                                                                          |
| `armorer/lazy`                    | Lazy execute loader helper                                                                                             |
| `armorer/registry`                | Direct registry export surface                                                                                         |
| `armorer/mcp`                     | MCP integration surface                                                                                                |
| `armorer/integrations/mcp`        | Alias of `armorer/mcp`                                                                                                 |
| `armorer/adapters/openai`         | OpenAI tool definition, tool-call, and tool-result adapters                                                            |
| `armorer/adapters/anthropic`      | Anthropic tool definition, tool-call, and tool-result adapters                                                         |
| `armorer/adapters/gemini`         | Gemini tool definition, tool-call, and tool-result adapters                                                            |
| `armorer/adapters/open-ai/agents` | OpenAI Agents SDK integration                                                                                          |
| `armorer/tools`                   | Prebuilt tools                                                                                                         |
| `armorer/instrumentation`         | OpenTelemetry instrumentation helpers                                                                                  |
| `armorer/middleware`              | Middleware helpers                                                                                                     |
| `armorer/truncation`             | Tool result truncation utilities                                                                                       |
| `armorer/test`                    | Test builders and recorders                                                                                            |

## `armorer`

### Functions

- `combineToolbox`: compatibility alias of `combineToolboxes`.
- `combineToolboxes`: merge multiple toolboxes into one.
- `createMiddleware`: type-preserving helper for middleware creation.
- `createTool`: create an executable tool from a configuration object.
- `createToolCall`: create a canonical tool call object with validated arguments.
- `createToolbox`: create a toolbox instance or rehydrate one from serialized/imported definitions.
- `isTool`: runtime type guard for tools.
- `isToolbox`: runtime type guard for toolboxes.
- `lazy`: memoized lazy loader for deferred execute functions.
- `materializeToolCall`: normalize one `ToolCallInput` into a JSON-safe `ToolCall`.
- `materializeToolCalls`: normalize multiple tool calls.
- `materializeToolResult`: normalize one non-streaming `ToolResultInput`.
- `materializeToolResultAsync`: normalize one tool result, collecting stream payloads when needed.
- `materializeToolResults`: normalize multiple non-streaming tool results.
- `materializeToolResultsAsync`: normalize multiple tool results, collecting streams when needed.
- `withContext`: bind extra runtime context into a tool factory.

### Types

- `AddEventListenerOptionsLike`
- `AsyncIteratorOptions`
- `CreateToolOptions`
- `DefaultToolEvents`
- `ImportedToolConfiguration`
- `ImportedToolboxOptions`
- `JSONValue`
- `MinimalAbortSignal`
- `MinimalToolConfiguration`
- `ObservableLike`
- `Observer`
- `SerializedToolbox`
- `SerializedToolboxJSONSchema`
- `Subscription`
- `Tool`
- `ToolAction`
- `ToolActionInput`
- `ToolCall`
- `ToolCallInput`
- `ToolCallWithArguments`
- `ToolConfiguration`
- `ToolContext`
- `ToolCustomEvent`
- `ToolDiagnostics`
- `ToolDiagnosticsAdapter`
- `ToolDigestOptions`
- `ToolError`
- `ToolErrorCategory`
- `ToolErrorInput`
- `ToolEventsMap`
- `ToolExecuteOptions`
- `ToolExecuteWithOptions`
- `ToolExecutionResult`
- `ToolMetadata`
- `ToolMiddleware`
- `ToolParametersSchema`
- `ToolPolicyAfterContext`
- `ToolPolicyContext`
- `ToolPolicyContextProvider`
- `ToolPolicyDecision`
- `ToolPolicyHooks`
- `ToolProvider`
- `ToolRepairHint`
- `ToolResult`
- `ToolResultInput`
- `ToolResultLike`
- `ToolRuntimeContext`
- `ToolStatusUpdate`
- `ToolValidationReport`
- `ToolValidationWarning`
- `Toolbox`
- `ToolboxCallInputForTools`
- `ToolboxContext`
- `ToolboxEntries`
- `ToolboxEntry`
- `ToolboxEvents`
- `ToolboxOptions`
- `ToolboxRuntimeContext`
- `ToolsFromEntries`
- `WithContext`

### Runtime conveniences on `createToolbox`

- `createToolbox.fromProvider(provider, definitions, options?)`
- `createToolbox.fromOpenAITools(definitions, options?)`
- `createToolbox.fromAnthropicTools(definitions, options?)`
- `createToolbox.fromGeminiTools(definitions, options?)`

### Runtime conveniences on `Toolbox`

- `toolbox.toProvider(provider, options?)`
- `toolbox.toOpenAITools()`
- `toolbox.toAnthropicTools()`
- `toolbox.toGeminiTools()`
- `toolbox.asExecuteResolver()`

## `armorer/core`

### Context types

- `AbortSignalLike`
- `Logger`
- `Span`
- `Tracer`
- `ToolContext`
- `ToolTenant`
- `ToolUser`

### Errors

- `ToolError`
- `ToolErrorCategory`
- `isToolError`

### Identity

- `ToolId`
- `ToolIdentity`
- `ToolIdentityInput`
- `formatToolId`
- `normalizeIdentity`
- `parseToolId`

### Inspection

- `InspectorDetailLevel`
- `MetadataFlags`
- `MetadataFlagsSchema`
- `RegistryInspection`
- `RegistryInspectionSchema`
- `SchemaSummary`
- `SchemaSummarySchema`
- `ToolInspection`
- `ToolInspectionSchema`
- `extractMetadataFlags`
- `extractSchemaSummary`
- `inspectRegistry`
- `inspectTool`

### Query predicates

- `NormalizedTextQuery`
- `TextMatchScore`
- `TextQuery`
- `TextQueryField`
- `TextQueryMode`
- `TextQueryWeights`
- `TextSearchIndex`
- `ToolPredicate`
- `buildTextSearchIndex`
- `internalQueryPredicateTestUtilities`
- `normalizeTextQuery`
- `schemaHasKeys`
- `schemaMatches`
- `scoreTextMatch`
- `scoreTextMatchFromIndex`
- `scoreTextMatchValueFromIndex`
- `tagsMatchAll`
- `tagsMatchAny`
- `tagsMatchNone`
- `textMatches`

### Registry and search

- `Embedder`
- `EmbeddingMatch`
- `EmbeddingVector`
- `MetadataFilter`
- `MetadataPrimitive`
- `MetadataRange`
- `QueryEvent`
- `QueryResult`
- `QuerySelectionResult`
- `RegisterOptions`
- `RegistryOptions`
- `ResolveOptions`
- `RiskFilter`
- `SchemaFilter`
- `SearchEvent`
- `TagFilter`
- `ToolMatch`
- `ToolMatchDetails`
- `ToolQuery`
- `ToolQueryCriteria`
- `ToolQueryInput`
- `ToolQueryOptions`
- `ToolQuerySelect`
- `ToolRankContext`
- `ToolRankResult`
- `ToolRanker`
- `ToolRegistry`
- `ToolRegistryLike`
- `ToolSearchOptions`
- `ToolSearchRank`
- `ToolSearchRanker`
- `ToolSummary`
- `ToolTieBreaker`
- `VersionSelector`
- `createRegistry`
- `internalRegistryTestUtilities`
- `queryTools`
- `registerToolIndexes`
- `reindexSearchIndex`
- `searchTools`
- `unregisterToolIndexes`

### Risk

- `ToolRisk`

### Schema utilities

- `ToolSchema`
- `getSchemaKeys`
- `getSchemaShape`
- `isZodObjectSchema`
- `isZodSchema`
- `schemasLooselyMatch`
- `unwrapSchema`

### Serialization

- `JsonArray`
- `JsonObject`
- `JsonPrimitive`
- `JsonSchema`
- `JsonValue`
- `SerializedToolDefinition`
- `assertJsonValue`
- `serializeRegistry`
- `serializeToolDefinition`
- `sortJsonValue`
- `stableStringifyJson`

### Tag utilities

- `EnforceKebabCaseArray`
- `KebabCaseString`
- `NormalizeTagsOption`
- `assertKebabCaseTag`
- `normalizeTags`
- `uniqTags`

### Tool definitions

- `AnyToolDefinition`
- `DefineToolOptions`
- `ToolDefinition`
- `ToolDisplay`
- `ToolLifecycle`
- `defineTool`

## `armorer/query`

### Functions

- `queryTools`
- `reindexSearchIndex`
- `schemaHasKeys`
- `schemaMatches`
- `tagsMatchAll`
- `tagsMatchAny`
- `tagsMatchNone`
- `textMatches`

### Types

- `Embedder`
- `EmbeddingVector`
- `MetadataFilter`
- `MetadataPrimitive`
- `MetadataRange`
- `NormalizedTextQuery`
- `QueryEvent`
- `QueryResult`
- `QuerySelectionResult`
- `RiskFilter`
- `SchemaFilter`
- `TagFilter`
- `TextMatchScore`
- `TextQuery`
- `TextQueryField`
- `TextQueryMode`
- `TextQueryWeights`
- `TextSearchIndex`
- `ToolPredicate`
- `ToolQuery`
- `ToolQueryCriteria`
- `ToolQueryInput`
- `ToolQueryOptions`
- `ToolQuerySelect`
- `ToolSummary`

## `armorer/inspect`

- `extractMetadataFlags`
- `extractSchemaSummary`
- `inspectRegistry`
- `inspectTool`
- `MetadataFlags`
- `MetadataFlagsSchema`
- `RegistryInspection`
- `RegistryInspectionSchema`
- `SchemaSummary`
- `SchemaSummarySchema`
- `ToolInspection`
- `ToolInspectionSchema`

## `armorer/utilities`

### Functions

- `bind`
- `materializeToolCall`
- `materializeToolCalls`
- `materializeToolResult`
- `materializeToolResultAsync`
- `materializeToolResults`
- `materializeToolResultsAsync`
- `parallel`
- `pipe`
- `postprocess`
- `preprocess`
- `retry`
- `tap`
- `when`

### Types

- `AnyTool`
- `ComposedTool`
- `ComposedToolEvents`
- `InferToolInput`
- `InferToolOutput`
- `MaterializeToolCallOptions`
- `PipelineError`
- `ToolWithInput`

## `armorer/lazy`

- `lazy`

## `armorer/registry`

`armorer/registry` re-exports the registry/search surface from `armorer/core`:

- `createRegistry`
- `queryTools`
- `searchTools`
- `reindexSearchIndex`
- `registerToolIndexes`
- `unregisterToolIndexes`
- all registry/search types listed in the `armorer/core` registry section above

## `armorer/mcp`

`armorer/mcp` and `armorer/integrations/mcp` export the same surface.

### Functions

- `createMCP`
- `fromMcpTools`
- `toMcpTools`
- `toolConfigurationFromMetadata`

### Types

- `CreateMCPOptions`
- `FromMCPToolsOptions`
- `MCPPromptRegistrar`
- `MCPResourceRegistrar`
- `MCPToolConfiguration`
- `MCPToolDefinition`
- `MCPToolHandler`
- `MCPToolLike`
- `MCPToolSource`
- `ToMCPToolsOptions`

### Test seam

- `internalMcpTestUtilities`

## `armorer/adapters/openai`

### Functions

- `createNameMapper`
- `formatOpenAIToolResults`
- `formatOpenAIToolResultsAsync`
- `fromOpenAITools`
- `mapToOpenAIName`
- `parseOpenAIToolCalls`
- `toOpenAITools`

### Types

- `JSONSchema`
- `OpenAIAdapterOptions`
- `OpenAIFunction`
- `OpenAITool`
- `OpenAIToolCall`
- `OpenAIToolMessage`

### Adapter object

- `openAIToolAdapter`

## `armorer/adapters/anthropic`

### Functions

- `formatAnthropicToolResults`
- `formatAnthropicToolResultsAsync`
- `fromAnthropicTools`
- `parseAnthropicToolCalls`
- `toAnthropicTools`

### Types

- `AnthropicContentBlock`
- `AnthropicInputSchema`
- `AnthropicTextBlock`
- `AnthropicTool`
- `AnthropicToolResultBlock`
- `AnthropicToolUseBlock`
- `JSONSchemaProperty`

### Adapter object

- `anthropicToolAdapter`

## `armorer/adapters/gemini`

### Functions

- `formatGeminiToolResults`
- `formatGeminiToolResultsAsync`
- `fromGeminiTools`
- `parseGeminiToolCalls`
- `toGeminiTools`

### Types

- `GeminiFileDataPart`
- `GeminiFormatToolResultsOptions`
- `GeminiFunctionCallPart`
- `GeminiFunctionDeclaration`
- `GeminiFunctionResponsePart`
- `GeminiInlineDataPart`
- `GeminiPart`
- `GeminiSchema`
- `GeminiTextPart`
- `GeminiTool`

### Adapter object

- `geminiToolAdapter`

## `armorer/adapters/open-ai/agents`

### Functions

- `createOpenAIToolGate`
- `toOpenAIAgentTools`

### Types

- `OpenAIAgentTool`
- `OpenAIAgentToolConfiguration`
- `OpenAIAgentToolOptions`
- `OpenAIAgentToolsResult`
- `OpenAIToolGateDecision`
- `OpenAIToolGateOptions`

### Test seam

- `internalOpenAIAgentsTestUtilities`

## `armorer/tools`

### Functions

- `createSearchTool`

### Types

- `CreateSearchToolOptions`
- `SearchTool`
- `SearchToolsInput`
- `SearchToolsResult`

## `armorer/instrumentation`

- `instrument`
- `InstrumentationOptions`

## `armorer/middleware`

- `createCacheMiddleware`
- `createRateLimitMiddleware`
- `createTimeoutMiddleware`
- `createTruncationMiddleware` — also wraps async iterable `stream`/`result` fields with character-limited iteration
- `ToolResultTruncationOptions`

## `armorer/truncation`

- `truncateToolResultContent`
- `truncateText`
- `safeSlice`
- `createTruncatingAsyncIterable` — wraps an `AsyncIterable`, yielding chunks until the character limit is reached then emitting a truncation marker
- `containsBase64Data`
- `stripBase64Data`
- `isHighSurrogate`
- `isLowSurrogate`
- `DEFAULT_MAX_CHARACTERS`
- `DEFAULT_ERROR_MAX_CHARACTERS`
- `TruncationOptions`
- `ToolResultTruncationOptions`

## `armorer/test`

### Functions

- `createMockTool`
- `createTestRegistry`
- `createTestToolbox`
- `createToolboxRecorder`

### Types

- `MockToolOptions`
- `TestRegistry`
- `ToolboxRecorder`

## Public but intentionally low-level test seams

These exports are public today because they sit behind exported entry points. They are intended for coverage and white-box verification:

- `internalMcpTestUtilities`
- `internalOpenAIAgentsTestUtilities`
- `internalQueryPredicateTestUtilities`
- `internalRegistryTestUtilities`
