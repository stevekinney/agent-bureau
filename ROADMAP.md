# Roadmap

## 1. Observability and Debugging

### Done

- **Herald instrumentation** (`herald/instrumentation`): `instrument()` wraps a `GenerateFunction` with OpenTelemetry spans. Each call creates a `gen_ai.generate ${provider}` span with `SpanKind.CLIENT`, sets request/response attributes (model, max tokens, token usage). On error, sets ERROR status and records exception.
- **Operative instrumentation** (`operative/instrumentation`): `instrument()` subscribes to `ActiveRun` events and creates a span tree: `operative.run` → `operative.step.{n}` → `operative.generate` / `operative.tools`. Tracks usage, finish reason, error/abort status.
- **Armorer instrumentation** (`armorer/instrumentation`): `instrument()` traces tool execution with timing, status, arguments, results, and digests.
- **Multi-agent trace context propagation**: `RunOptions` accepts `parentContext` and `withTraceContext` for OpenTelemetry context threading. `createSubagentTool` forwards trace context to child agents. Armorer propagates toolbox `baseContext` to pre-built tools via `rawExecute`.
- **Cost estimation** (`operative`): `estimateCost()` maps `TokenUsage` + model string to dollar cost. `defaultPricingTable` covers Anthropic Claude 4/3.5, OpenAI GPT-4o/4.1/o3/o4-mini, and Gemini 2.5/2.0. Custom pricing overrides via `CostEstimationOptions`.
- **Sentinel** (`sentinel`): Event-sourced store for tracking operative runs. `createStore()` returns a `Store` that `register()`s `ActiveRun` instances and records a full action log (run/step/tool lifecycle events with timestamps and sequence numbers). Tracks state snapshots, usage accumulation, and conversation snapshots at step/run boundaries. Supports concurrent multi-run tracking.
- **Operative event emission**: `ActiveRun` exposes `addEventListener`, `on`, `once`, `subscribe`, `toObservable()`. Events: `run.started`, `step.started`, `step.generated`, `tools.executing`, `tools.executed`, `step.completed`, `run.completed`, `run.error`, `run.aborted`, `generate.retry`. Forwards events from toolbox and conversation.

### Remaining gaps

- No cost budget alerting beyond operative's `tokenBudget` stop condition.

---

## 2. Streaming

### Done

- **Conversationalist streaming lifecycle**: `appendStreamingMessage`, `updateStreamingMessage`, `finalizeStreamingMessage`, `cancelStreamingMessage`. Events: `stream.started`, `stream.updated`, `stream.finalized`, `stream.cancelled`. Streaming messages are protected from compaction and truncation.
- **Operative streaming wrapper**: `withStreaming()` wraps a `StreamingGenerateFunction` into a standard `GenerateFunction`, managing the conversationalist lifecycle automatically.
- **Herald streaming factories**: `createAnthropicGenerateStream`, `createOpenAIGenerateStream`, `createGeminiGenerateStream` — each returns a `StreamingGenerateFunction` that calls the provider SDK with `stream: true`, iterates the async stream, progressively calls `streaming.update(accumulatedText)` on each text delta, accumulates tool call fragments into complete `ToolCallInput` objects, and returns a final `GenerateResponse`. All errors wrapped in `HeraldError`.
- **Streaming types** (`herald`): `AnthropicStreamEvent`, `OpenAIChatCompletionChunk`, `AnthropicStreamingClient`, `OpenAIStreamingClient`, `GeminiStreamingModel`. Re-exports `StreamingGenerateFunction` and `StreamingHandle` from operative.
- **Streaming test infrastructure** (`herald/test`): Mock streaming clients and fixture sets for all three providers.
- **Usage pattern**: `withStreaming(createAnthropicGenerateStream(options))` produces a standard `GenerateFunction` that streams under the hood.

### Remaining gaps

- No documentation beyond type signatures and test examples.

---

## 3. Agent Loop Robustness

### Done

- **Retry logic** (`operative`): `RetryOptions` with configurable `attempts`, `delay` (number or function for exponential backoff), and `shouldRetry` predicate. Emits `generate.retry` events. Herald provides `shouldRetryHeraldError()` classifying 429, 500, 502, 503, 504 as retryable.
- **Response validation** (`operative`): `validateResponse` hook for custom rejection/regeneration. `responseSchema` with Zod for automatic validation. `schemaRetries` for configurable retry count. `schemaRetryMessage(error, attempt)` for custom validation retry prompts. `validateToolResult` hook for rejecting/re-executing tool results.
- **Context window management** (`operative`): `ContextManagementOptions` with `maxTokens` budget, `onCompact` summarization callback, and `tokenEstimator` function. Automatic conversation compaction to stay within budget.
- **Stop conditions** (`operative`): 12 composable predicates via `stopWhen`: `noToolCalls`, `toolCalled`, `maximumSteps`, `toolOutcome`, `contentMatches`, `tokenBudget`, `wallClockTimeout`, `repeatingToolCalls`, `forked`, plus combinators `every`, `some`, `not`.
- **Loop detection** (`operative`): `repeatingToolCalls` with `windowSize`, custom `fingerprint` function, and `includeResults` option for result-aware fingerprinting.
- **Wall-clock timeout** (`operative`): `wallClockTimeout(milliseconds)` stops gracefully (current step finishes, produces `stop-condition` finish reason rather than abort).
- **Tool selection** (`operative`): `selectTools(context)` hook for dynamic per-step tool gating.
- **Elicitation** (`operative`): `elicit<T>(message, schema)` for requesting structured user input mid-loop. `OnElicitation` callback. `elicitation-denied` finish reason when user declines.
- **Error classification** (`herald`): `HeraldError` wraps SDK errors with `provider`, `statusCode`, and `retryable` fields. `shouldRetryHeraldError()` for integration with operative's retry system.

### Remaining gaps

- No automatic backpressure or adaptive rate limiting at the loop level.

---

## 4. Tool Infrastructure

### Done

- **Core tooling** (`armorer`): `createTool` factory with Zod schema validation, `createToolbox` for tool registries. Provider adapters: `toAnthropicTools`/`parseAnthropicToolCalls`, `toOpenAITools`/`parseOpenAIToolCalls`, `toGeminiTools`/`parseGeminiToolCalls`.
- **Middleware** (`armorer`): `createRateLimitMiddleware`, `createCacheMiddleware`, `createTimeoutMiddleware`, `createTruncationMiddleware`. Composable chains for tool execution policies.
- **Tool composition** (`armorer`): `pipe` (sequential), `parallel` (concurrent), `bind` (context binding), `retry` (retry failed executions), `when` (conditional), `tap` (side effects), `preprocess` (input transform), `postprocess` (output transform).
- **MCP integration** (`armorer`): `createMCP()` for exposing tools over Model Context Protocol. `toMcpTools()` and `fromMcpTools()` for format conversion.
- **Fuzzy name resolution** (`armorer`): `resolveFuzzyToolName()` with tiered matching (exact → case-insensitive → normalized → suffix) for recovering from model-mangled tool names.
- **Loop detection** (`armorer`): `createLoopDetectionState()` and `detectLoop()` with warning/block thresholds and ping-pong pattern detection. Separate from operative's `repeatingToolCalls`.
- **Tool search** (`armorer`): `createSearchTool()` for agent-callable tool discovery. `queryTools()` with text, tag, and schema matching predicates.
- **Lazy-loaded tools** (`armorer`): `lazy(() => import(...))` for deferred SDK imports — loads only when tool is first executed.
- **Tool inspection** (`armorer`): `inspectTool()` and `inspectRegistry()` for introspection and validation.
- **Truncation** (`armorer`): Surrogate-pair-safe `truncateText()`, `truncateToolResultContent()`, `stripBase64Data()`. Configurable limits.
- **Batch execution** (`armorer`): `toolbox.execute()` with `concurrency` limit and `mode` (parallel/sequential).

### Remaining gaps

- No semantic/embedding-based tool search (only text matching).
- No tool versioning or deprecation lifecycle.

---

## 5. Conversation Management

### Done

- **Core messaging** (`conversationalist`): Immutable `ConversationHistory` with mutable `Conversation` wrapper. `appendMessages`, `prependSystemMessage`, `replaceSystemMessage`, `collapseSystemMessages`, `getSystemMessages`.
- **Compaction and summarization** (`conversationalist`): `compactConversation()` with user-provided `Summarizer` function. `partitionMessages()` splits into protected and compactible sections. `chunkMessages()` groups for summarization. `stripToolResultDetails()` removes verbose tool output. Protected messages (streaming, tool interactions) excluded.
- **Context window management** (`conversationalist`): `estimateConversationTokens()` with pluggable `tokenEstimator`. `truncateToTokenLimit()`, `getRecentMessages()`, `truncateFromPosition()`. `simpleTokenEstimator()` for basic BPE-style counting.
- **Multi-modal content** (`conversationalist`): `TextContent` and `ImageContent` types for vision/image support in conversations.
- **PII redaction** (`conversationalist`): `createPIIRedaction()` plugin with default rules for emails, SSNs, credit cards. Pluggable rule sets.
- **Persistence** (`conversationalist`): `SessionPersistenceAdapter` interface with `save`, `load`, `list`, `delete`. `JsonlSessionPersistenceAdapter` using append-only JSONL files. Auto-save on `change` event.
- **Deserialization** (`conversationalist`): `deserializeConversationHistory()` for restoring from JSON with versioning support.
- **Provider adapters** (`conversationalist`): `toAnthropicMessages`, `toOpenAIMessagesGrouped`, `toGeminiMessages` for converting conversations to provider-specific formats.
- **Markdown export** (`conversationalist`): `exportMarkdown()` for human-readable conversation output.

### Remaining gaps

- Only JSONL persistence adapter — no SQLite, Redis, or cloud storage adapters.
- No agent-level session persistence (conversation history only, not agent configuration or run state).
- No session lifecycle hooks in operative (`onSessionSave`, `onSessionLoad`).

---

## 6. Multi-Agent Coordination

### Done

- **Agent definition** (`operative`): `defineAgent()` returns reusable `AgentDefinition` with `agent.run()` and `agent.createRun()`. Instructions auto-prepended as system message.
- **Subagent tools** (`operative`): `createSubagentTool()` wraps an agent as a callable tool with `mapInput`/`mapOutput`, abort signal propagation, and error handling for max-steps scenarios.
- **Handoff tool** (`operative`): `createHandoffTool()` terminates the current loop with a `handoff` finish reason and returns the target agent name plus handoff message. `extractHandoffTarget()` extracts routing info from run results.
- **Early stopping handler** (`operative`): `createEarlyStoppingHandler()` calls the LLM one more time without tools when max steps is hit, asking for a summary rather than failing.

### Remaining gaps

- **Shared context** — No shared state primitive (scratchpad, blackboard) across collaborating agents. Each agent has its own conversation.
- **Supervisor patterns** — No orchestrator utility for routing tasks to specialist agents and synthesizing outputs.
- **Agent discovery** — No registry or routing mechanism to select the right agent dynamically.

---

## 7. Prompt and Instruction Composition

### What exists

Conversationalist provides system message utilities. Operative's `defineAgent` accepts an `instructions` string. The `selectTools` hook enables conditional tool availability per step.

### Remaining gaps

- **Structured composition** — No builder for assembling system prompts from named sections (persona, task, constraints, tools) with ordering and deduplication.
- **Template variables** — No `{{variable}}` resolution for dynamic prompts at runtime.
- **Conditional layering** — No declarative way to include instructions based on available tools, step count, or user role (only `prepareStep` hook).
