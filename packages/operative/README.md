# Operative

`operative` is the provider-agnostic agent runtime for Agent Bureau. It owns the loop that assembles context, calls a generate function, executes tools, records steps, handles stop conditions, emits events, manages sessions, and coordinates advanced runtime behavior.

## What It Does

- Defines agents with `defineAgent()` and runs them with `run()` or `createRun()`.
- Executes tools through `armorer` and conversation history through `conversationalist`.
- Accepts caller-provided generate functions instead of importing model SDKs.
- Provides sessions, session stores, durable run support, scheduler primitives, and heartbeat utilities.
- Adds hooks for generation, tool execution, context assembly, validation, run lifecycle, and error handling.
- Provides guardrails, retry mutators, cache middleware, context compaction, streaming, backpressure, budgets, handoffs, subagents, and supervisors.

## How It Works

The core loop starts with an agent definition, a conversation, tools, and a `GenerateFunction`. For each step, it prepares context, calls the generate function, validates the response, executes requested tools, appends tool results back to the conversation, emits typed events, and evaluates stop conditions.

Everything provider-specific stays outside the package. `herald` can supply generate functions for common providers, but callers can pass any function that satisfies the runtime type. Durable execution, scheduler tasks, and session persistence build on the same loop so product surfaces can recover or resume runs without changing agent code.

## Project Role

`operative` is the center of the Agent Bureau runtime graph. `gateway` uses it to run requests and scheduler tasks, `operative/store` observes run state and action history, `memory` and `skills` attach through hooks and tools, `armorer` supplies actions, and `conversationalist` supplies the conversation model.

## Table of Contents

- [Quick Start](#quick-start)
- [Public API](#public-api)
  - [`operative` — Core Entry Point](#operative--core-entry-point)
  - [`operative/conditions` — Stop Conditions](#operativeconditions--stop-conditions)
  - [`operative/store` — Run Store](#operativestore--run-store)
  - [`operative/streaming` — Streaming Helpers](#operativestreaming--streaming-helpers)
  - [`operative/retry` — Retry Mutators](#operativeretry--retry-mutators)
  - [`operative/instrumentation` — OpenTelemetry](#operativeinstrumentation--opentelemetry)
  - [`operative/durable` — Durable Runs](#operativedurable--durable-runs)
  - [`operative/test` — Test Utilities](#operativetest--test-utilities)
- [Development](#development)

## Quick Start

Define an agent with a stub generate function and run it to completion:

```typescript
import { defineAgent } from 'operative';
import { createToolbox } from 'armorer';
import type { GenerateFunction } from 'operative';

// Minimal inline generate function — swap for a real provider in production.
const generate: GenerateFunction = async ({ conversation }) => {
  const last = conversation.getMessages().at(-1);
  return {
    content: `Echo: ${last?.content ?? '(empty)'}`,
    toolCalls: [],
  };
};

const toolbox = createToolbox([]);

const assistant = defineAgent({
  name: 'echo-assistant',
  instructions: 'You are a helpful assistant.',
  generate,
  toolbox,
});

const result = await assistant.run('Hello, agent!');
console.log(result.content); // "Echo: Hello, agent!"
console.log(result.finishReason); // "stop-condition" | "maximum-steps" | …
```

### Event-Driven Style with `createRun()`

`createRun()` returns an `ActiveRun` with a full event surface. Attach listeners before the promise settles—the loop defers its first microtask so you never miss the opening events:

```typescript
import { createRun } from 'operative';
import { Conversation } from 'conversationalist';

const conversation = new Conversation();
conversation.appendUserMessage('Summarize the docs.');

const activeRun = createRun({ generate, toolbox, conversation });

activeRun.addEventListener('step.completed', (event) => {
  console.log(`Step ${event.step} done — ${event.content}`);
});

activeRun.addEventListener('run.completed', (event) => {
  console.log('Finish reason:', event.finishReason);
});

// Abort any time before completion.
// activeRun.abort('user cancelled');

const result = await activeRun.result;
```

---

## Public API

### `operative` — Core Entry Point

The main import surface for defining agents, running loops, managing sessions, backpressure, caching, context assembly, cost tracking, and multi-agent patterns.

#### `defineAgent(options)`

Creates a reusable `AgentDefinition` that can be invoked with `.run()` or `.createRun()`.

```typescript
import { defineAgent } from 'operative';

const agent = defineAgent({
  name: 'my-agent',
  instructions: 'You are a concise assistant.',
  generate, // GenerateFunction — required
  toolbox, // Toolbox — required
  maximumSteps: 10,
  stopWhen: (step) => step.toolCalls.length === 0,
});

// Fire-and-forget: resolves to RunResult
const result = await agent.run('What is the capital of France?');

// Event-driven: returns ActiveRun
const activeRun = agent.createRun({ conversation: 'What is 2 + 2?' });
await activeRun.result;
```

**`DefineAgentOptions`** — key fields:

| Field                 | Type                                                   | Description                               |
| --------------------- | ------------------------------------------------------ | ----------------------------------------- |
| `name`                | `string`                                               | Agent identifier.                         |
| `instructions`        | `string \| { render(): string }`                       | System prompt or renderable template.     |
| `generate`            | `GenerateFunction`                                     | The caller-supplied LLM call.             |
| `toolbox`             | `Toolbox`                                              | Tool registry from `armorer`.             |
| `stopWhen`            | `StopCondition \| StopCondition[]`                     | Loop exit predicates.                     |
| `maximumSteps`        | `number`                                               | Hard step cap (default: `25`).            |
| `prepareStep`         | `PrepareStepHook \| PrepareStepHook[]`                 | Runs before each generate call.           |
| `beforeToolExecution` | `BeforeToolExecutionHook \| BeforeToolExecutionHook[]` | Modifies tool call list before execution. |
| `afterToolExecution`  | `AfterToolExecutionHook \| AfterToolExecutionHook[]`   | Inspects/modifies tool results.           |
| `onStep`              | `OnStepHook \| OnStepHook[]`                           | Called after each step completes.         |
| `retry`               | `RetryOptions`                                         | Transient generate failure retry policy.  |
| `contextManagement`   | `ContextManagementOptions`                             | Automatic context compaction.             |
| `responseSchema`      | `ZodType`                                              | Structured output schema with retry.      |
| `hooks`               | `HookRegistry<OperativeHookMap>`                       | Typed priority-ordered hook registry.     |
| `persistence`         | `TextValueStore`                                       | Session persistence backend.              |
| `sessionId`           | `string`                                               | Session key for persistence.              |
| `autoSave`            | `'step' \| 'completion' \| false`                      | When to flush to `persistence`.           |

**`AgentRunOptions`** — override at call time:

```typescript
await agent.run({
  conversation: existingConversation, // Conversation | ConversationHistory | string
  signal: abortController.signal,
  stopWhen: myExtraCondition,
});
```

#### `run(options)`

Drives the agent loop to completion without an event surface. Use when you only need the final `RunResult`:

```typescript
import { run } from 'operative';

const result = await run({ generate, toolbox, conversation });
console.log(result.content, result.usage.total);
```

**`RunOptions`** — extends `DefineAgentOptions` minus `name`/`instructions`/persistence fields:

| Field                | Type                                                 | Description                              |
| -------------------- | ---------------------------------------------------- | ---------------------------------------- |
| `generate`           | `GenerateFunction`                                   | Required. LLM call.                      |
| `toolbox`            | `Toolbox`                                            | Required. Tool registry.                 |
| `conversation`       | `Conversation \| ConversationHistory`                | Required. Seed conversation.             |
| `stopWhen`           | `StopCondition \| StopCondition[]`                   | Loop exit predicates.                    |
| `maximumSteps`       | `number`                                             | Hard step cap (default: `25`).           |
| `retry`              | `RetryOptions`                                       | Retry policy for transient errors.       |
| `backpressure`       | `BackpressureStrategy`                               | Delay strategy applied before each step. |
| `validateResponse`   | `ValidateResponseHook \| ValidateResponseHook[]`     | Post-generate response validation.       |
| `validateToolResult` | `ValidateToolResultHook \| ValidateToolResultHook[]` | Post-execute result validation.          |
| `selectTools`        | `SelectToolsHook \| SelectToolsHook[]`               | Per-step dynamic tool filtering.         |
| `onElicitation`      | `OnElicitation`                                      | Human-in-the-loop input handler.         |
| `contextManagement`  | `ContextManagementOptions`                           | Auto compaction settings.                |
| `responseSchema`     | `ZodType`                                            | Enforce structured output via Zod.       |
| `hooks`              | `HookRegistry<OperativeHookMap>`                     | Typed hook registry.                     |
| `signal`             | `AbortSignal`                                        | External cancellation signal.            |

**`RunResult`:**

```typescript
interface RunResult {
  conversation: Conversation;
  steps: readonly StepResult[];
  content: string;
  usage: TokenUsage; // { prompt, completion, total }
  finishReason: FinishReason; // 'stop-condition' | 'maximum-steps' | 'aborted' | 'error' | …
  error?: unknown;
}
```

#### `createRun(options)`

Returns an `ActiveRun` — the event-emitting entry point. Attach listeners before awaiting `result`:

**`ActiveRun` interface:**

| Member                                | Description                                            |
| ------------------------------------- | ------------------------------------------------------ |
| `result: Promise<RunResult>`          | Resolves when the loop completes.                      |
| `abort(reason?)`                      | Cancels the loop immediately.                          |
| `addEventListener(type, listener)`    | Standard `EventTarget` listener.                       |
| `removeEventListener(type, listener)` | Removes a listener.                                    |
| `on(type)`                            | Returns an `ObservableLike` stream for the event type. |
| `once(type, listener)`                | One-time listener.                                     |
| `subscribe(type, observer)`           | RxJS-style subscription.                               |
| `events(type, options?)`              | `AsyncIterableIterator` of typed events.               |
| `toObservable()`                      | All events as a single `ObservableLike`.               |
| `[Symbol.dispose]()`                  | Aborts and completes—use with `using`.                 |

**Event types** emitted on `ActiveRun` (all prefixed by their lifecycle stage):

`run.started`, `run.completed`, `run.error`, `run.aborted`, `step.started`, `step.generated`, `step.completed`, `step.aborted`, `generate.started`, `generate.completed`, `generate.error`, `generate.retry`, `tools.executing`, `tools.executed`, `response.validated`, `tool-result.validated`, `context.compacted`, `context.budget-warning`, `elicitation.requested`, `elicitation.resolved`, `backpressure.applied`, `backpressure.released`, `usage.accumulated`, `session.saved`, `session.loaded`.

```typescript
// Iterate events as an async stream
for await (const event of activeRun.events('step.completed')) {
  console.log(event.step, event.content);
}
```

#### `GenerateFunction`

The interface operative never provides for you. Wire in any provider:

```typescript
import type { GenerateFunction } from 'operative';

// Stub for tests or demos
const generate: GenerateFunction = async ({ conversation, toolbox }) => ({
  content: 'I can help with that.',
  toolCalls: [],
  usage: { prompt: 10, completion: 8, total: 18 },
});
```

In production, `herald` provides ready-made generate functions for Anthropic, OpenAI, and Gemini.

#### Sessions

The main entry point exposes session helpers for direct session management without a `SessionStore`:

- **`createAgentSession(options)`**: Creates a new `AgentSession` object.
- **`loadAgentSession(persistence, sessionId)`**: Loads an `AgentSession` from a `TextValueStore`.
- **`saveAgentSession(persistence, session)`**: Persists an `AgentSession` to a `TextValueStore`.

```typescript
import { createAgentSession, loadAgentSession, saveAgentSession } from 'operative';

// Direct persistence (use createSessionStore from session/index for the full API)
const session = createAgentSession({
  agentName: 'my-agent',
  conversationHistory: conversation.current,
  id: 'session-abc',
});

await saveAgentSession(store, session);
const loaded = await loadAgentSession(store, 'session-abc');
```

For richer session management, `createSessionStore()` and `resumeSession()` are available at the same path and documented below under [`operative` — Core](#operativecreatesessionstore-and-resumesession).

#### `createSessionStore()` and `resumeSession()`

```typescript
import { createSessionStore, resumeSession } from 'operative';

// createSessionStore wraps any TextValueStore (e.g. Weft's KV storage)
const sessions = createSessionStore(kvStore);

await sessions.save(session);
const summary = await sessions.list({ agentName: 'my-agent', sortBy: 'updatedAt' });
const loaded = await sessions.load('session-abc');
await sessions.delete('session-abc');
await sessions.cleanup({ olderThan: 7 * 24 * 60 * 60 * 1000 }); // 1 week

// resumeSession loads an existing session (or creates a new one) and returns
// the restored Conversation so you can pass it into a run.
const { session, conversation, isNew } = await resumeSession(sessions, 'session-abc', {
  agentName: 'my-agent',
});

// Then run the agent with the restored conversation
const result = await agent.run({ conversation });
```

**`SessionStore` interface:**

| Method                         | Description                                        |
| ------------------------------ | -------------------------------------------------- |
| `save(session)`                | Persist a session.                                 |
| `load(id)`                     | Load by id; returns `undefined` if not found.      |
| `delete(id)`                   | Remove a session.                                  |
| `exists(id)`                   | Check existence.                                   |
| `list(options?)`               | Paginated list of `SessionSummary` objects.        |
| `updateMetadata(id, metadata)` | Merge metadata without rewriting the conversation. |
| `cleanup(options)`             | Delete sessions older than `options.olderThan` ms. |

#### Hooks

Hooks plug into the loop lifecycle. Register them on `RunOptions.hooks` using a `HookRegistry`, or use the simpler array fields (`prepareStep`, `onStep`, etc.).

```typescript
import { defineAgent } from 'operative';
import { composeHooks, onlyOnStep, runOnce, withTimeout, everyNSteps } from 'operative';
import { createHookRegistry } from 'lifecycle';

// Compose two prepare-step hooks into one
const combined = composeHooks(
  onlyOnStep(0, async ({ conversation }) => {
    conversation.appendSystemMessage('Extra context injected on step 0.');
  }),
  withTimeout(5000, async (ctx) => {
    // Fetch something slow — times out and silently returns undefined after 5s
  }),
);

const agent = defineAgent({
  name: 'hooked-agent',
  generate,
  toolbox,
  prepareStep: [
    combined,
    everyNSteps(3, async (ctx) => {
      /* every 3rd step */
    }),
  ],
  onStep: runOnce(async (step) => {
    console.log('First step only:', step.content);
  }),
});
```

**Hook composition utilities:**

| Function       | Signature                      | Description                                                                                            |
| -------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `composeHooks` | `(...hooks: H[]) => H`         | Sequential waterfall — a non-void return replaces the first arg for subsequent hooks.                  |
| `onlyOnStep`   | `(step: number, hook: H) => H` | Wraps a hook so it only fires on the given step number.                                                |
| `runOnce`      | `(hook: H) => H & { reset() }` | Fires at most once; call `.reset()` to re-arm between runs.                                            |
| `everyNSteps`  | `(n: number, hook: H) => H`    | Fires on steps 0, N, 2N, …                                                                             |
| `withTimeout`  | `(ms, hook, onTimeout?) => H`  | Races the hook against a timeout; `'ignore'` (default) silently returns `undefined`, `'error'` throws. |

#### Guardrails

```typescript
import {
  createGuardrails,
  createPromptInjectionDetector,
  createInputLengthDetector,
  createTopicBoundaryDetector,
  createInputGuardrail,
  createOutputGuardrail,
  createOutputPIIValidator,
  createGroundingValidator,
  createCodeSafetyValidator,
  createSessionTaintTracker,
} from 'operative';

// Injection detection on inputs
const injectionDetector = createPromptInjectionDetector({
  sensitivity: 'medium',
});

// Restrict topics
const topicGuard = createTopicBoundaryDetector({
  allowedTopics: ['cooking', 'recipes'],
  blockedTopics: ['finance', 'legal'],
});

// Block overlong inputs
const lengthGuard = createInputLengthDetector({ maxLength: 2000 });

// Compose into a guardrails hook set
const guardrails = createGuardrails({
  inputDetectors: [injectionDetector, topicGuard, lengthGuard],
  outputValidators: [createOutputPIIValidator()],
});

const agent = defineAgent({
  name: 'safe-agent',
  generate,
  toolbox,
  prepareStep: guardrails.prepareStep,
  validateResponse: guardrails.validateResponse,
});
```

#### Context Assembly

```typescript
import { createContextAssembler, createTokenBudget } from 'operative';

const budget = createTokenBudget({
  maxTokens: 100_000,
  reserveTokens: 4_000,
});

const assembler = createContextAssembler({
  budget,
  documents: [{ content: systemDoc, priority: 'high' }],
});
```

#### Backpressure

```typescript
import { createSlidingWindow, createTokenBucket, createAdaptiveBackoff } from 'operative';

// Smooth out burst traffic with a sliding window
const backpressure = createSlidingWindow({ windowMs: 60_000, maxRequests: 20 });

// Token bucket for sustained rate control
const bucket = createTokenBucket({ capacity: 10, refillRate: 1 }); // 1 token/sec

// Exponential backoff that self-adjusts based on error rate
const adaptive = createAdaptiveBackoff({ initialDelayMs: 500, maxDelayMs: 30_000 });

const result = await run({ generate, toolbox, conversation, backpressure });
```

#### Caching

```typescript
import { withCache, withCacheMetrics } from 'operative';

// withCache requires a TextValueStore backend (e.g. from Weft)
const cachedGenerate = withCache(generate, {
  store: kvStore, // TextValueStore
  keyStrategy: 'last-message', // or 'conversation-hash' or a custom CacheKeyFunction
  ttl: 3600, // seconds; 0 = no expiry
});

// withCacheMetrics wraps withCache and returns { generate, metrics }
const { generate: metered, metrics } = withCacheMetrics(generate, {
  store: kvStore,
  keyStrategy: 'conversation-hash',
  model: 'claude-sonnet-4-20250514', // optional, for cost-savings estimation
});

const result = await run({ generate: metered, toolbox, conversation });
// metrics.hits, metrics.misses, metrics.hitRate, metrics.totalSavedTokens
metrics.reset(); // clear counters between test runs
```

#### Generate Middleware

```typescript
import { composeGenerate, createFallbackGenerate } from 'operative';
import type { GenerateMiddleware } from 'operative';

// composeGenerate(base, ...middleware) applies middleware right-to-left (outermost first)
const loggingMiddleware: GenerateMiddleware = (next) => async (context) => {
  const response = await next(context);
  return response;
};
const stacked = composeGenerate(generate, loggingMiddleware);

// Failover: try providers in order, fall back on error
const withFallback = createFallbackGenerate({
  providers: [primaryGenerate, fallbackGenerate],
  shouldFallback: (error) => error instanceof Error && error.message.includes('rate limit'),
});
```

#### Multi-Agent Patterns

**Subagents:**

```typescript
import { createSubagentTool } from 'operative';

const researcherTool = createSubagentTool({
  name: 'research',
  description: 'Delegates a research task to a specialist agent.',
  agent: researcherAgent,
  input: z.object({ query: z.string() }),
  mapInput: ({ query }) => query,
  mapOutput: (result) => result.content,
});

const orchestrator = defineAgent({
  name: 'orchestrator',
  generate,
  toolbox: createToolbox([researcherTool]),
});
```

**Supervisor:**

```typescript
import { createSupervisor, createRoundRobinRouting, createCapabilityRouting } from 'operative';
import type { AgentRegistryEntry } from 'operative';

// Agents are wrapped as AgentRegistryEntry objects
const agentPool: AgentRegistryEntry[] = [
  { agent: writerAgent, description: 'Writes prose', capabilities: ['writing'] },
  { agent: researcherAgent, description: 'Finds facts', capabilities: ['research'] },
  { agent: editorAgent, description: 'Edits copy', capabilities: ['editing'] },
];

const supervisor = createSupervisor({
  agents: agentPool,
  routing: createRoundRobinRouting(),
  // or createCapabilityRouting() for skill-based dispatch
});

const supervisorResult = await supervisor.delegate('Write a detailed report on climate change.');
// supervisorResult.synthesis — the merged output
```

**Handoffs:**

```typescript
import { createHandoffTool, extractHandoffTarget, HANDOFF_MARKER } from 'operative';

// Each handoff targets one specific agent
const escalateToSupport = createHandoffTool({
  name: 'escalate-to-support',
  description: 'Transfer the conversation to the human support agent.',
  agent: supportAgent,
});

// After a run, check whether a handoff occurred
const target = extractHandoffTarget(result.steps);
if (target) {
  // target is the agent name that was handed off to
}
```

**Agent Registry:**

```typescript
import { createAgentRegistry, createAgentDiscoveryTool } from 'operative';

const registry = createAgentRegistry();
registry.register({ name: 'researcher', agent: researcherAgent, tags: ['research'] });
registry.register({ name: 'writer', agent: writerAgent, tags: ['writing'] });

// Let an orchestrator discover agents dynamically
const discoveryTool = createAgentDiscoveryTool(registry);
```

#### Scheduler

```typescript
import { createScheduler, createHeartbeat, createChunkedTask, sleep } from 'operative';
import type { SchedulerTask } from 'operative';

// The scheduler shares a generate function and toolbox across all its tasks.
const scheduler = createScheduler({
  generate,
  toolbox,
  idleDelay: 500, // ms to wait before dispatching non-immediate tasks
});

scheduler.start();

// Submit a task — resolves when complete, or null if preempted and not re-queued
const task: SchedulerTask = {
  id: 'background-sync',
  priority: 'background',
  createRun: () => ({
    conversation,
    stopWhen: stopWhen.noToolCalls,
  }),
  onComplete: (result) => {
    /* result.content */
  },
};

await scheduler.submit(task);

// Periodic proactive task (heartbeat) — requires a running scheduler
const heartbeat = createHeartbeat({
  scheduler,
  interval: 60_000,
  createHeartbeatRun: () => ({ conversation, stopWhen: stopWhen.noToolCalls }),
});
heartbeat.start();

// Break long work into preemption-friendly chunks
// createChunkedTask returns a function you call with a scheduler
const runChunked = createChunkedTask({
  name: 'dataset-processing',
  initialState: { offset: 0, processed: 0 },
  processChunk: async (state, signal) => {
    // do one chunk of work
    const done = state.offset >= totalItems;
    return { state: { ...state, offset: state.offset + 50 }, done };
  },
  onComplete: (finalState) => {
    /* all chunks done */
  },
});

await runChunked(scheduler);
```

#### Cost Estimation and Budget

```typescript
import { estimateCost, createCostBudgetMonitor } from 'operative';

const estimate = estimateCost(
  { prompt: 5000, completion: 800, total: 5800 },
  'claude-opus-4-20250514',
);
// estimate.totalCost — total dollar cost for this call

const monitor = createCostBudgetMonitor({
  budget: 0.1, // $0.10 USD
  model: 'claude-sonnet-4-20250514',
  thresholds: [0.5, 0.8], // warn at 50% and 80%
  onThreshold: (event) => console.warn(`${event.threshold * 100}% of budget used`),
  onExceeded: (event) => console.error('Budget exceeded at $' + event.currentCost.toFixed(4)),
});
```

#### Structured Output

```typescript
import { defineAgent } from 'operative';
import { zodToJsonSchema } from 'operative';
import { z } from 'zod';

const OutputSchema = z.object({
  summary: z.string(),
  keyPoints: z.array(z.string()),
  confidence: z.number().min(0).max(1),
});

const agent = defineAgent({
  name: 'structured-agent',
  generate,
  toolbox,
  responseSchema: OutputSchema,
  schemaRetries: 2,
});
```

#### Scratchpad

```typescript
import { createScratchpad, createScratchpadReadTool, createScratchpadWriteTool } from 'operative';

const scratchpad = createScratchpad({ initialValues: { step: 0 } });

const readTool = createScratchpadReadTool(scratchpad);
const writeTool = createScratchpadWriteTool(scratchpad);

const agent = defineAgent({
  name: 'scratchpad-agent',
  generate,
  toolbox: createToolbox([readTool, writeTool]),
});
```

#### Context Compaction

```typescript
import { createContextCompactor } from 'operative';

// createContextCompactor returns an onCompact function for contextManagement.
// The summarize callback receives an array of Message objects (not a Conversation).
const onCompact = createContextCompactor({
  summarize: async (messages) => {
    // Condense messages into a summary string — call your provider here.
    return `Summary of ${messages.length} prior messages.`;
  },
  retainRecentMessages: 6,
});

const agent = defineAgent({
  name: 'compacting-agent',
  generate,
  toolbox,
  contextManagement: {
    maxTokens: 80_000,
    onCompact,
  },
});
```

#### Memory Bridge

```typescript
import { createMemoryBridge, createScratchpad } from 'operative';

// operative never imports the memory package directly — supply a MemoryLike adapter.
// createMemoryBridge returns { prepareStep, onStep }.
// prepareStep recalls memories into the scratchpad on step 0.
// onStep persists scratchpad entries back to long-term memory on the final step.
const scratchpad = createScratchpad();
const bridge = createMemoryBridge({
  memory: myMemoryAdapter, // satisfies MemoryLike
  scratchpad,
  recallLimit: 5,
  scratchpadKey: 'memories',
});

const agent = defineAgent({
  name: 'memory-agent',
  generate,
  toolbox: createToolbox([
    createScratchpadReadTool(scratchpad),
    createScratchpadWriteTool(scratchpad),
  ]),
  prepareStep: bridge.prepareStep,
  onStep: bridge.onStep,
});
```

#### Identity Hook

```typescript
import { createIdentityHook } from 'operative';

const identityHook = createIdentityHook({
  resolve: async () => 'You are Aria, a friendly customer success agent.',
});

const agent = defineAgent({
  name: 'aria',
  generate,
  toolbox,
  prepareStep: identityHook,
});
```

#### Policy Enforcement

```typescript
import { createPolicyEnforcementHook } from 'operative';
import type { ToolLike } from 'operative';

// createPolicyEnforcementHook returns a tool-filtering function:
//   (tools: T[]) => T[]
// Apply it to any array of ToolLike objects to enforce allow/deny policies.
const enforcePolicy = createPolicyEnforcementHook({
  personaToolPolicy: {
    denyList: ['fs.write', 'fs.delete'], // always blocked
  },
  getActiveSkillToolPolicy: () => ({
    allowList: ['search', 'summarize'], // dynamic — per active skill
  }),
});

// Example: filter a tool-descriptor array before constructing a toolbox.
// `toolbox.tools()` returns the registered tools; pass them through enforcePolicy.
const allTools: ToolLike[] = toolbox.tools();
const allowedTools = enforcePolicy(allTools);
```

#### Early Stopping

```typescript
import { createEarlyStoppingHandler } from 'operative';

// Creates an onMaximumSteps callback that calls the model one final time
// without tools, prompting it to summarize findings before the loop ends.
const onMaximumSteps = createEarlyStoppingHandler(generate, {
  message: 'Summarize your findings so far in one paragraph.',
});

const agent = defineAgent({
  name: 'bounded-agent',
  generate,
  toolbox,
  maximumSteps: 10,
  onMaximumSteps,
});
```

---

### `operative/conditions` — Stop Conditions

Composable predicates for loop exit. All are available on the `stopWhen` namespace object, or can be imported individually.

```typescript
import { stopWhen } from 'operative/conditions';

// Stop when the model produces no tool calls
const noTools = stopWhen.noToolCalls;

// Stop after 5 steps
const maxSteps = stopWhen.maximumSteps(5);

// Stop when a specific tool was called
const submitted = stopWhen.toolCalled('submit-form');

// Stop when a tool returns a specific outcome
const resolved = stopWhen.toolOutcome('resolve-ticket', (result) => result.success === true);

// Stop when content matches a pattern
const goodbyeDetected = stopWhen.contentMatches(/goodbye/i);

// Logical composition
const compound = stopWhen.some(stopWhen.noToolCalls, stopWhen.maximumSteps(10));

// Must ALL conditions be true to stop
const strict = stopWhen.every(stopWhen.noToolCalls, stopWhen.toolCalled('finalize'));

// Invert any condition
const mustUseTool = stopWhen.not(stopWhen.noToolCalls);

// Detect the model repeating the same tool call in a loop
const noLoop = stopWhen.repeatingToolCalls({ threshold: 3 });

// Stop on token budget
const underBudget = stopWhen.tokenBudget({ maxTokens: 50_000 });

// Hard wall-clock timeout
const timed = stopWhen.wallClockTimeout({ timeoutMs: 30_000 });

// Stop when accumulated cost exceeds a dollar amount
const affordable = stopWhen.costBudget({ budget: 0.05, model: 'claude-sonnet-4-20250514' });

// Fork: stop condition for branching workflows
const branchDone = stopWhen.forked();

const agent = defineAgent({
  name: 'bounded-agent',
  generate,
  toolbox,
  stopWhen: [noTools, maxSteps],
});
```

**All `stopWhen` predicates:**

| Predicate                      | Description                                                 |
| ------------------------------ | ----------------------------------------------------------- |
| `noToolCalls`                  | Stop when a step produces zero tool calls.                  |
| `toolCalled(name)`             | Stop when a tool with the given name was called.            |
| `maximumSteps(n)`              | Stop after `n` steps.                                       |
| `toolOutcome(name, predicate)` | Stop when a tool result satisfies `predicate`.              |
| `contentMatches(pattern)`      | Stop when the response content matches a string or regex.   |
| `every(...conditions)`         | AND — stop when all conditions are true.                    |
| `some(...conditions)`          | OR — stop when any condition is true.                       |
| `not(condition)`               | Negate a condition.                                         |
| `forked()`                     | Stop condition for branching / forked workflow control.     |
| `repeatingToolCalls(options?)` | Stop when the same tool repeats above a threshold.          |
| `tokenBudget(options)`         | Stop when cumulative token usage exceeds `maxTokens`.       |
| `wallClockTimeout(options)`    | Stop when elapsed wall-clock time exceeds `timeoutMs`.      |
| `costBudget(options)`          | Stop when accumulated dollar cost exceeds `options.budget`. |

---

### `operative/store` — Run Store

Observes one or more `ActiveRun` instances, accumulating steps, usage, and the action log. Use this to build dashboards, replay UIs, or cross-run analytics.

```typescript
import { createStore } from 'operative/store';
import { createRun } from 'operative';

const store = createStore({ maxActions: 500, maxSnapshots: 10 });

const activeRun = createRun({ generate, toolbox, conversation });
const runId = store.register(activeRun, 'run-001');

// Subscribe to all store mutations
store.subscribe((state, action) => {
  const runState = state.runs.get(runId);
  console.log(runState?.status, action.type);
});

// Subscribe to a specific event type
store.subscribe('action', (event) => {
  console.log('Action recorded:', event.action.type);
});

// Inspect a run
const run = store.getRun(runId);
console.log(run?.steps.length, run?.usage.total);

// Remove when done
store.removeRun(runId);

// Tear down all subscriptions
store.dispose();
```

**`Store` interface:**

| Member                      | Description                                                   |
| --------------------------- | ------------------------------------------------------------- |
| `register(activeRun, id?)`  | Start tracking an `ActiveRun`. Returns the run id.            |
| `getState()`                | Returns `{ runs: Map<string, RunState>, actions: Action[] }`. |
| `getRun(id)`                | Returns the current `RunState` for a run.                     |
| `subscribe(listener)`       | Subscribe to all state mutations.                             |
| `subscribe(type, observer)` | Subscribe to a specific `StoreEventType`.                     |
| `removeRun(id)`             | Remove a run from the store.                                  |
| `deregister(id)`            | Detach store listeners without deleting run state.            |
| `dispose()`                 | Unsubscribe all runs and complete the event target.           |

**`RunState`:**

| Field          | Type                                               | Description                             |
| -------------- | -------------------------------------------------- | --------------------------------------- |
| `id`           | `string`                                           | Run identifier.                         |
| `status`       | `'running' \| 'completed' \| 'error' \| 'aborted'` | Current run status.                     |
| `steps`        | `StepResult[]`                                     | Completed steps.                        |
| `usage`        | `TokenUsage`                                       | Accumulated token counts.               |
| `finishReason` | `FinishReason \| undefined`                        | Set on terminal transition.             |
| `snapshots`    | `ConversationSnapshot[]`                           | Conversation snapshots after each step. |
| `actions`      | `Action[]`                                         | Per-run action log slice.               |
| `activeRun`    | `ActiveRun`                                        | Reference to the live run.              |

**Events:** `RunRegisteredEvent`, `RunRemovedEvent`, `StoreActionEvent`.

---

### `operative/streaming` — Streaming Helpers

Wraps a streaming generate function into the standard `GenerateFunction` contract, and provides enhanced streaming primitives with state machines and backpressure buffers.

#### `withStreaming(fn)`

Adapts a `StreamingGenerateFunction` (one that receives a `StreamingHandle`) into a standard `GenerateFunction`. The helper manages `appendStreamingMessage → updateStreamingMessage → finalizeStreamingMessage` on the conversation so the loop never sees raw streaming state:

```typescript
import { withStreaming } from 'operative/streaming';
import type { StreamingGenerateFunction } from 'operative';

const streamingGenerate: StreamingGenerateFunction = async ({ conversation, streaming }) => {
  // Push incremental tokens through streaming.update()
  streaming.update('Hello');
  streaming.update(', world');
  return {
    content: 'Hello, world',
    toolCalls: [],
    usage: { prompt: 5, completion: 10, total: 15 },
  };
};

const generate = withStreaming(streamingGenerate);

// `generate` is now a standard GenerateFunction — pass it anywhere.
const result = await run({ generate, toolbox, conversation });
```

#### `withEnhancedStreaming(options)`

Provides a full streaming pipeline with state machines, block parsing, and backpressure:

```typescript
import { withEnhancedStreaming } from 'operative/streaming';

const enhanced = withEnhancedStreaming({
  onBlock: (block) => {
    if (block.type === 'text') console.log('Text chunk:', block.content);
    if (block.type === 'tool_use') console.log('Tool block:', block.toolName);
  },
  onComplete: () => console.log('Stream done'),
});
```

#### `createBackpressureBuffer(options)`

Creates a backpressure-aware buffer for streaming chunks:

```typescript
import { createBackpressureBuffer } from 'operative/streaming';

const buffer = createBackpressureBuffer({ highWaterMark: 100, strategy: 'drop' });
```

#### `createStreamStateMachine()`

Parses a raw token stream into typed blocks (`text`, `tool_use`, `tool_result`):

```typescript
import { createStreamStateMachine } from 'operative/streaming';

const machine = createStreamStateMachine();
machine.transition('text-delta', { content: 'Hello' });
```

**Exported types:** `StreamBlock`, `StreamCommand`, `StreamEvent`, `StreamEventMap`, `StreamState`, `StreamStateMachine`, `BlockType`, `EnhancedStreamingOptions`, `BackpressureBuffer`, `BackpressureBufferOptions`, `StreamCustomEvent`.

---

### `operative/retry` — Retry Mutators

Transforms the generate context before each retry attempt—escalate temperature, drop bad tools, inject schema error feedback, or add jitter to delays.

```typescript
import {
  composeMutators,
  createTemperatureEscalationMutator,
  createSchemaErrorMutator,
  createToolRemovalMutator,
  createOverflowMutator,
  addJitter,
  RETRY_TEMPERATURE_KEY,
} from 'operative/retry';
import type { RetryMutator } from 'operative/retry';

// Start at 0.7, add 0.1 per attempt up to 1.0
const escalate = createTemperatureEscalationMutator({
  initial: 0.7,
  increment: 0.1,
  max: 1.0,
});

// Re-inject a schema validation error as a user message
const schemaFeedback = createSchemaErrorMutator();

// Remove tools that caused errors on the previous attempt
const dropBadTools = createToolRemovalMutator();

// Handle context-window overflow by trimming early messages
const overflow = createOverflowMutator({ keepMessages: 10 });

// Add random jitter to any delay function
const withJitter = addJitter({ maxJitter: 200 });

// Compose into a single mutator
const mutator = composeMutators(escalate, schemaFeedback, dropBadTools);

const agent = defineAgent({
  name: 'resilient-agent',
  generate,
  toolbox,
  retry: {
    attempts: 3,
    delay: 1000,
    mutate: mutator,
    jitter: true,
  },
});
```

**Exported functions:**

| Function                                      | Description                                                                          |
| --------------------------------------------- | ------------------------------------------------------------------------------------ |
| `composeMutators(...mutators)`                | Chains mutators left-to-right — each receives the context the previous one returned. |
| `createTemperatureEscalationMutator(options)` | Increases temperature on each retry. Writes to `RETRY_TEMPERATURE_KEY` in metadata.  |
| `createSchemaErrorMutator()`                  | Appends schema validation error details as a user message.                           |
| `createToolRemovalMutator()`                  | Removes tools that failed on the previous attempt.                                   |
| `createOverflowMutator(options)`              | Trims the conversation when a context-overflow error is detected.                    |
| `addJitter(options?)`                         | Wraps a delay function to add random offset.                                         |
| `RETRY_TEMPERATURE_KEY`                       | Metadata key used by `createTemperatureEscalationMutator`.                           |

---

### `operative/instrumentation` — OpenTelemetry

Attaches OpenTelemetry spans to an `ActiveRun`, mirroring the agent loop lifecycle as nested spans. Requires `@opentelemetry/api` (peer dependency, optional).

```typescript
import { instrument } from 'operative/instrumentation';
import { createRun } from 'operative';
import { trace } from '@opentelemetry/api';

const activeRun = createRun({ generate, toolbox, conversation });

// Wire up OTel spans
const stopInstrumentation = instrument(activeRun, {
  tracer: trace.getTracer('my-app', '1.0.0'),
  // Or let instrument create a default tracer:
  // tracerName: 'operative',
  // tracerVersion: '0.0.0',
});

await activeRun.result;
stopInstrumentation(); // Remove listeners and end any open spans
```

`instrument()` creates:

- `operative.run` span for the full run lifetime.
- `operative.step.N` spans for each step, nested under the run span.
- `operative.generate` spans for each LLM call, nested under their step.
- `operative.tools` spans for tool execution batches, nested under their step.

Span attributes include token usage, step counts, finish reason, abort reason, generate duration in ms, and retry attempt counts.

**Exported:**

| Symbol                            | Description                                         |
| --------------------------------- | --------------------------------------------------- |
| `instrument(activeRun, options?)` | Attach OTel spans; returns an unsubscribe function. |
| `InstrumentationOptions`          | `{ tracer?, tracerName?, tracerVersion? }`          |

---

### `operative/durable` — Durable Runs

Drives agent runs through the Weft durable execution engine—checkpointed, crash-recoverable, and resumable. The `ActiveRun` surface is identical to the in-memory path; only the second argument to `createRun()` or `run()` changes.

```typescript
import { createRun } from 'operative';
import type { DurableRunRouting } from 'operative';
import {
  createRunEngine,
  createCheckpointStore,
  createRunWorkflow,
  createDurableActiveRun,
  reattachDurableActiveRun,
} from 'operative/durable';

// Build the durable substrate once at startup
const engine = await createRunEngine({ storage: kvStore });
const checkpointStore = createCheckpointStore(kvStore);

// Start a new durable run — survives crashes and resumes automatically
const durable: DurableRunRouting = {
  engine,
  checkpointStore,
  runId: 'run-2024-001',
  prompt: 'Summarize the annual report.',
};

const activeRun = createRun({ generate, toolbox, conversation }, durable);
const result = await activeRun.result;

// Reattach after a server restart to observe a recovered run
const recovered = reattachDurableActiveRun(
  { engine, checkpointStore },
  {
    runId: 'run-2024-001',
    sessionId: 'session-001',
    options: { generate, toolbox, conversation },
  },
);
```

**Exported functions:**

| Function                                   | Description                                                                  |
| ------------------------------------------ | ---------------------------------------------------------------------------- |
| `createRunEngine(options)`                 | Creates and recovers a `RunEngine` backed by Weft storage.                   |
| `createCheckpointStore(kvStore)`           | KV-backed store for per-step run checkpoints.                                |
| `createDurableActiveRun(context, input)`   | Low-level: create a durable `ActiveRun` directly.                            |
| `reattachDurableActiveRun(context, input)` | Reattach listeners to a run already in progress (e.g. after server restart). |
| `createRunWorkflow(options)`               | Creates the Weft workflow definition for agent runs.                         |
| `isAgentRunWorkflowInput(value)`           | Type guard for `AgentRunWorkflowInput`.                                      |
| `createStorageActivities(store)`           | Weft activities for checkpoint read/write.                                   |
| `startDurableRunResult(options)`           | Starts a run result inside a durable workflow context.                       |
| `resumeDurableRunResult(options)`          | Resumes an existing run result from checkpoint.                              |
| `SCHEDULER_ORIGIN_TAG`                     | Tag identifying scheduler-originated durable runs.                           |
| `SCHEDULER_RUN_ID_PREFIX`                  | Prefix for scheduler-managed run IDs.                                        |

**Exported types:** `DurableActiveRunOptions`, `DurableActiveRunContext`, `RecoveredRunHandle`, `StartDurableRunResultOptions`, `CheckpointStore`, `RunEngine`, `AnyRunEngine`, `CreateRunEngineOptions`, `RunEngineObservability`, `AgentRunWorkflowInput`, `AgentRunWorkflowResult`, `DurableRunDeps`, `RunCheckpoint`, `RunCursor`, `StepRecord`.

---

### `operative/test` — Test Utilities

Test helpers for the agent loop. Import in test files only.

```typescript
import {
  createMockGenerate,
  createMockGenerateOnce,
  createRunRecorder,
  createMockScratchpad,
  createMockAgentDefinition,
  createMockAgentRegistry,
  createTestStore,
} from 'operative/test';
import type { RunRecorder } from 'operative/test';
import type { GenerateResponse } from 'operative';

// Replay pre-canned responses in sequence
const generate = createMockGenerate([
  { content: 'Step 1 response', toolCalls: [] },
  { content: 'Step 2 response', toolCalls: [], usage: { prompt: 5, completion: 8, total: 13 } },
]);

const activeRun = createRun({ generate, toolbox, conversation });

// Record every event for assertion
const recorder: RunRecorder = createRunRecorder(activeRun);
await activeRun.result;

expect(recorder.events.map((e) => e.type)).toContain('run.completed');
expect(recorder.steps).toHaveLength(2);
expect(generate.callCount).toBe(2);

// Single-shot generate — throws if called more than once
const once = createMockGenerateOnce({ content: 'Only once', toolCalls: [] });

// In-memory store for testing operative/store consumers
const store = createTestStore();

// Mock agent definition for registry tests
const mockAgent = createMockAgentDefinition('test-agent', {
  run: async () => ({
    content: 'custom',
    steps: [],
    usage: { prompt: 0, completion: 0, total: 0 },
    finishReason: 'stop-condition',
    conversation: {} as never,
  }),
});
```

**Exported:**

| Symbol                                        | Description                                                                                    |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `createMockGenerate(responses)`               | Replays `GenerateResponse[]` in sequence; exposes `.calls` and `.callCount`.                   |
| `createMockGenerateOnce(response)`            | Returns response once; throws on subsequent calls.                                             |
| `createRunRecorder(activeRun)`                | Records all events from an `ActiveRun` for assertion. Exposes `.events`, `.steps`, `.clear()`. |
| `createMockScratchpad(initialValues?)`        | In-memory `Scratchpad` for testing scratchpad-dependent agents.                                |
| `createMockAgentDefinition(name, overrides?)` | Minimal `AgentDefinition` with a stub `run` and `createRun`.                                   |
| `createMockAgentRegistry(entries?)`           | Pre-populated `AgentRegistry` for registry consumer tests.                                     |
| `createTestStore()`                           | In-memory `Store` instance from `operative/store`.                                             |
| `RunRecorder`                                 | Interface for the recorder object.                                                             |

---

## Development

Run package checks from this directory:

```bash
bun run validate
bun run build
```
