# Roadmap

## 1. Observability — Full-Loop Tracing

### What exists

Armorer has complete OpenTelemetry instrumentation for tool execution (`instrument()` in `armorer/instrumentation`). It traces tool calls with timing, status, arguments, results, and digests. Operative emits granular events (`run.started`, `step.started`, `step.generated`, `tools.executing`, `tools.executed`, `step.completed`, `run.completed`, `run.error`, `run.aborted`, etc.) via event-emission.

### Done

- **Herald instrumentation** (`herald/instrumentation`): `instrument()` wraps a `GenerateFunction` with OpenTelemetry spans. Each call creates a `gen_ai.generate ${provider}` span with `SpanKind.CLIENT`, sets `gen_ai.system`, `gen_ai.provider`, `gen_ai.request.model`, and optionally `gen_ai.request.max_tokens`. On success, sets `gen_ai.response.prompt_tokens`, `gen_ai.response.completion_tokens`, `gen_ai.response.total_tokens`, status OK. On error, sets ERROR status, records exception, re-throws.
- **Operative instrumentation** (`operative/instrumentation`): `instrument()` subscribes to `ActiveRun` events and creates a span tree: `operative.run` → `operative.step.{n}` → `operative.generate` / `operative.tools`. Tracks usage, finish reason, error/abort status. Returns an unsubscribe function.
- **Multi-agent trace context propagation**: `RunOptions` and `AgentRunOptions` accept `parentContext` (opaque OTel Context) and `withTraceContext` (callback to run functions within a parent context). The loop wraps `generate()` and `toolbox.execute()` calls through `withTraceContext` when both fields are present. `ToolContext` has a `traceContext` field and `createSubagentTool` forwards it as `parentContext` to child agents. Armorer now propagates toolbox `baseContext` to pre-built `Tool` objects via `rawExecute` on the tool configuration.
- **Cost estimation** (`operative`): `estimateCost()` maps `TokenUsage` + model string to dollar cost. `getModelPricing()` returns pricing for a model. `defaultPricingTable` covers Anthropic Claude 4/3.5, OpenAI GPT-4o/4.1/o3/o4-mini, and Gemini 2.5/2.0. Custom pricing overrides via `CostEstimationOptions`.

### Remaining gaps

- No cost budget alerting beyond operative's existing `tokenBudget` stop condition.

---

## 2. Streaming — End-to-End from SDK to Consumer

### What exists

Conversationalist has a complete streaming message lifecycle: `appendStreamingMessage`, `updateStreamingMessage`, `finalizeStreamingMessage`, `cancelStreamingMessage`, plus streaming events (`stream.started`, `stream.updated`, `stream.finalized`, `stream.cancelled`). Operative has `withStreaming()` that wraps a `StreamingGenerateFunction` and manages the conversationalist streaming lifecycle automatically.

### What's missing

Herald returns complete responses only. There is no way to stream tokens from the SDK through herald into operative's streaming infrastructure. To stream today, users must bypass herald entirely and write their own generate function that calls the SDK with `stream: true` and uses `withStreaming`.

### Work to do

- Add streaming variants to each herald factory: `createAnthropicGenerateStream`, `createOpenAIGenerateStream`, `createGeminiGenerateStream`. Each should return a `StreamingGenerateFunction` (the type operative's `withStreaming` expects).
- Each streaming factory should:
  - Call the SDK with `stream: true`
  - Iterate the SDK's stream, calling `streaming.update(content)` on each text delta
  - Accumulate tool calls from stream events
  - Return the final `GenerateResponse` when the stream completes
- Add streaming mock clients to `herald/test` for testing without real API calls.
- Document the pattern: `withStreaming(createAnthropicGenerateStream(options))` produces a standard `GenerateFunction` that streams under the hood.

---

## 3. Prompt and Instruction Composition

### What exists

Conversationalist provides system message utilities: `appendSystemMessage`, `prependSystemMessage`, `replaceSystemMessage`, `collapseSystemMessages`, `getSystemMessages`. Operative's `defineAgent` accepts an `instructions` string that gets prepended to the conversation as a system message.

### What's missing

There is no structured way to:

- **Compose instructions from parts** — Real agents have personas, task descriptions, tool usage guidelines, output format constraints, and safety rules. These come from different sources and need to be assembled, ordered, and deduplicated. Today you concatenate strings.
- **Parameterize prompts** — Template variables like `{{user_name}}` or `{{current_date}}` that get resolved at runtime. Without this, every dynamic prompt requires string interpolation scattered across application code.
- **Layer context conditionally** — Include certain instructions only when specific tools are available, or only after a certain step count, or only for certain user roles. The `prepareStep` hook can do this but it requires manual conversation manipulation.

### Work to do

- Create an instruction builder that composes a system prompt from named sections with ordering and deduplication. Something like `createInstructions({ persona: '...', task: '...', constraints: '...', tools: '...' })` that produces a single string or structured system message.
- Add simple template variable resolution (mustache-style or tagged template literals) so instructions can reference runtime values without string concatenation.
- Integrate with `defineAgent` so agent definitions can declare instruction sections that get composed at run time.

---

## 4. Persistence — More Adapters and Automatic Saving

### What exists

Conversationalist defines a `SessionPersistenceAdapter` interface with `save`, `load`, `list`, and `delete` methods. A `JsonlSessionPersistenceAdapter` implements it using append-only JSONL files. The `Conversation` class auto-saves on every `change` event when a persistence adapter is provided via the environment.

### What's missing

- **No additional adapters** — JSONL works for local development but is not suitable for production. There are no adapters for SQLite, Redis, PostgreSQL, or cloud storage.
- **No agent-level persistence** — The persistence interface saves conversation history but not agent configuration, run results, or step-level data. You cannot resume an interrupted agent run.
- **No session management** — Loading a session gives you the conversation but not the agent context (which tools were available, what stop conditions were active, what the instructions were). Resuming a session means reconstructing all of that manually.

### Work to do

- Implement a SQLite adapter using `bun:sqlite` for local persistence with proper indexing and querying. This is the highest-value adapter since it works without external services and supports concurrent access better than JSONL.
- Implement a Redis adapter for distributed/serverless use cases where conversations need to be shared across processes.
- Design an agent session type that bundles conversation history with agent configuration metadata, so a session can be fully resumed without reconstructing the agent definition.
- Add session lifecycle hooks to operative (`onSessionSave`, `onSessionLoad`) so the loop can participate in persistence without the user wiring it manually.

---

## 5. Multi-Agent Coordination

### What exists

Operative provides two multi-agent primitives: `defineAgent` for creating reusable agent configurations, and `createSubagentTool` for wrapping an agent as a tool callable by a parent agent. Subagent tools support input/output mapping, abort signal propagation, and configurable error handling for max-steps scenarios. Agents can be nested to arbitrary depth.

### What's missing

The current model is strictly hierarchical: a parent delegates to a child via tool calls, and the child returns a result. There is no support for:

- **Peer-to-peer handoff** — Agent A decides it cannot handle the request and transfers the conversation to Agent B, with Agent B taking over the loop entirely (not as a subtask). This is the pattern used by customer service systems where a general triage agent hands off to a specialist.
- **Shared context** — When agents collaborate, they often need shared state beyond the conversation (a scratchpad, a task list, accumulated research). Today each agent has its own conversation and there is no shared memory between them.
- **Supervisor patterns** — A coordinator agent that routes tasks to specialist agents, monitors their progress, and synthesizes their outputs. This differs from subagent tools because the supervisor does not call specialists via tool use — it orchestrates them programmatically.
- **Agent discovery** — When you have many defined agents, there is no registry or routing mechanism to select the right agent for a task dynamically.

### Work to do

- Design a handoff protocol where an agent can yield control to another agent, transferring the conversation and a handoff message. The loop should support a `handoff` finish reason and return enough context for the caller to route to the next agent.
- Add a shared context primitive (a typed key-value store or blackboard) that can be passed to multiple agents and persisted across steps. This could integrate with operative's `StepContext`.
- Build a supervisor utility that accepts a roster of agents and a routing function, runs the appropriate agent for each turn, and collects results. This is orchestration above the single-agent loop.
- Add an agent registry pattern where agents register themselves with capabilities/descriptions, and a router can select the best agent for a given input (potentially using embeddings from armorer's embedding infrastructure).
