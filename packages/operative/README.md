# Operative

`@lostgradient/operative` is the provider-agnostic agent runtime for Agent Bureau. It owns the loop that assembles context, calls a generate function, executes tools, records steps, handles stop conditions, emits events, manages sessions, and coordinates advanced runtime behavior.

## Installation

```bash
bun add @lostgradient/operative zod armorer conversationalist @lostgradient/weft
```

Operative supports Bun and Node.js runtimes. Node.js consumers must use Node `>=20.19.0`: the
published CJS exports keep `conversationalist@0.5.0` external as a declared dependency, and that
ESM-only dependency requires Node's unflagged `require(esm)` support. Bun consumers must use Bun
`>=1.3.13`. `zod` is required. Provider SDKs and OpenTelemetry are optional peers: install only
the SDKs for the provider subpaths you use, and no provider SDK is loaded when its provider is
unused.

The public package exports are `@lostgradient/operative`, `bureau-types`, `conditions`, `durable`,
`guardrails`, `instrumentation`, `retry`, `streaming`, `store`, `test`, `anthropic`, `openai`,
`gemini`, `providers`, `providers/anthropic`, `providers/openai`, `providers/gemini`,
`providers/fallover`, `providers/routing`, `providers/streaming`, `providers/embeddings`,
`providers/embeddings/openai`, `providers/embeddings/gemini`, `providers/embeddings/voyage`,
`providers/embeddings/ollama`, `providers/instrumentation`, and `providers/test`.

## What It Does

- Defines agents with `createAgent()` and drives the loop directly with `createActiveRun()`.
- Executes tools through `armorer` and conversation history through `conversationalist`.
- Accepts caller-provided generate functions instead of importing model SDKs.
- Provides sessions, session stores, durable run support, scheduler primitives, and heartbeat utilities.
- Adds hooks for generation, tool execution, context assembly, validation, run lifecycle, and error handling.
- Provides guardrails, retry mutators, cache middleware, context compaction, streaming, backpressure, budgets, handoffs, subagents, and supervisors.

## How It Works

The core loop starts with an agent definition, a conversation, tools, and a `GenerateFunction`. For each step, it prepares context, calls the generate function, validates the response, executes requested tools, appends tool results back to the conversation, emits typed events, and evaluates stop conditions.

Everything provider-specific stays behind a narrow seam: the `@lostgradient/operative/anthropic`, `@lostgradient/operative/openai`, and `@lostgradient/operative/gemini` subpaths (plus fallover, routing, and embedding factories under `@lostgradient/operative/providers/*`) supply ready-made generate functions, but callers can pass any function that satisfies the `GenerateFunction` type. Durable execution, scheduler tasks, and session persistence build on the same loop so product surfaces can recover or resume runs without changing agent code.

## Project Role

`operative` is the center of the Agent Bureau runtime graph. `gateway` uses it to run requests and scheduler tasks, `@lostgradient/operative/store` observes run state and action history, `memory` and `skills` attach through hooks and tools, `armorer` supplies actions, and `conversationalist` supplies the conversation model.

## Table of Contents

- [Quick Start](#quick-start)
- [Public API](#public-api)
  - [`operative` — Core Entry Point](#operative--core-entry-point)
  - [`@lostgradient/operative/conditions` — Stop Conditions](#operativeconditions--stop-conditions)
  - [`@lostgradient/operative/guardrails` — Guardrails](#operativeguardrails--guardrails)
  - [`@lostgradient/operative/store` — Run Store](#operativestore--run-store)
  - [`@lostgradient/operative/streaming` — Streaming Helpers](#operativestreaming--streaming-helpers)
  - [`@lostgradient/operative/retry` — Retry Mutators](#operativeretry--retry-mutators)
  - [`@lostgradient/operative/instrumentation` — OpenTelemetry](#operativeinstrumentation--opentelemetry)
  - [`@lostgradient/operative/providers/instrumentation` — OpenTelemetry (Inference Calls)](#operativeprovidersinstrumentation--opentelemetry-inference-calls)
  - [OTel GenAI Semantic Conventions](#otel-genai-semantic-conventions)
  - [`@lostgradient/operative/durable` — Durable Runs](#operativedurable--durable-runs)
  - [`@lostgradient/operative/test` — Test Utilities](#operativetest--test-utilities)
- [Development](#development)

## Quick Start

Create an agent with a stub generate function and run it to completion:

```typescript
import { createAgent } from '@lostgradient/operative';
import type { GenerateFunction } from '@lostgradient/operative';

// Minimal inline generate function — swap for a real provider in production.
const generate: GenerateFunction = async ({ conversation }) => {
  const last = conversation.getMessages().at(-1);
  return {
    content: `Echo: ${last?.content ?? '(empty)'}`,
    toolCalls: [],
  };
};

const assistant = createAgent({
  generate,
  instructions: 'You are a helpful assistant.',
});

const run = assistant.run('Hello, agent!');
const result = await run.result();
console.log(result.content); // "Echo: Hello, agent!"
console.log(result.finishReason); // "stop-condition" | "maximum-steps" | …
```

### Event-Driven Style with `createActiveRun()`

`createAgent().run()` returns a non-thenable `AgentRun` handle: iterate it directly for events, or call `.result()` for the terminal `RunResult`. For the full event-emitting surface (`addEventListener`, `on`, `subscribe`, …) reach for `createActiveRun()` — the lower-level factory `createAgent` builds on — which returns an `ActiveRun` instead. Attach listeners before awaiting `result`—the loop defers its first microtask so you never miss the opening events:

```typescript
import { Conversation } from 'conversationalist';
import { createActiveRun, stopWhen } from '@lostgradient/operative';

const conversation = new Conversation();
conversation.appendUserMessage('Summarize the docs.');

const activeRun = createActiveRun({
  generate,
  toolbox, // a Toolbox from armorer's createToolbox() — empty or populated
  conversation,
  stopWhen: stopWhen.noToolCalls(),
});

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

#### `createAgent(options)`

The documented public factory for a standalone, bureau-less agent. `generate` is required — there's no bureau to inherit a provider from. Runs are in-memory and ephemeral by default (no durability, no session, no shared memory) unless you inject your own `Toolbox` and `ConversationHistory`, as below.

```typescript
import { createAgent } from '@lostgradient/operative';

const agent = createAgent({
  generate: myProvider, // GenerateFunction — required
  instructions: 'You are a research assistant.',
  tools: { search: searchTool }, // name-keyed map; the map key is canonical
  stopWhen: (step) => step.toolCalls.length === 0,
});

const run = agent.run('Summarize the Q3 report.'); // fresh conversation
for await (const event of run) {
  /* iterate, OR */
}
const result = await run.result(); // await — same handle
```

**`CreateAgentOptions`** — key fields:

| Field               | Type                                    | Description                                                                          |
| ------------------- | --------------------------------------- | ------------------------------------------------------------------------------------ |
| `generate`          | `GenerateFunction`                      | Required. The caller-supplied LLM call.                                              |
| `tools`             | `Record<string, Tool>`                  | Name-keyed tool map. Mutually exclusive with `toolbox`.                              |
| `toolbox`           | `Toolbox`                               | A pre-built `Toolbox`, used as-is across every run. Mutually exclusive with `tools`. |
| `instructions`      | `string`                                | System prompt appended on fresh string-input runs only.                              |
| `stopWhen`          | `StopCondition \| StopCondition[]`      | Loop exit predicates.                                                                |
| `maximumSteps`      | `number`                                | Hard step cap.                                                                       |
| `retry`             | `RetryOptions`                          | Transient generate failure retry policy.                                             |
| `contextManagement` | `ContextManagementOptions`              | Automatic context compaction.                                                        |
| `permissions`       | `HeadlessPermissionPolicyConfiguration` | Deny-by-default headless mode (AB-94). Mutually exclusive with `toolbox`.            |

`agent.run(input)` accepts either a plain `string` (starts a fresh conversation — `instructions`, if given, is appended as a system message, then `input` as a user message) or `{ conversation: ConversationHistory }` (resumes an existing history — see the next section).

##### Stateless chat host: resume a conversation, share a toolbox, park on approval

A host with a browser- or client-owned conversation and an approval-gated toolbox — a stateless HTTP chat backend, for example — needs three things `createAgent` provides directly:

1. **A conversation input**, not just a fresh string: `agent.run({ conversation })` starts the loop from an existing `ConversationHistory` — the shape a stateless backend POSTs and stores between turns.
2. **A pre-built `Toolbox`**, not a freshly composed one: pass `toolbox` instead of `tools`. The same instance is reused across every `run()` call, which is required for armorer's cross-request approval flow — `toolbox.resumeApproval(signedApproval)` only verifies a token signed by the toolbox's own `approvalSecret`.
3. **Park-on-approval**, not headless denial: `stopWhen: [stopWhen.pendingApproval(), stopWhen.noToolCalls()]` (from `@lostgradient/operative/conditions`) stops the run cleanly after a step whose tool results include a pending approval — no further `generate` call happens, and the pending approval stays reachable on the final `RunResult`'s last step. `noToolCalls()` has to be combined in: `pendingApproval()` alone never fires on a normal, no-tool-call turn, so a plain text reply would otherwise run to `maximumSteps` instead of finishing.

```typescript
import { createToolbox } from 'armorer';
import { createAgent, stopWhen } from '@lostgradient/operative';

// Built once per process — the stable approvalSecret is what makes
// resumeApproval() work across separate HTTP requests.
//
// `approvalPolicy` is load-bearing, not decoration: armorer only installs its
// approval hook when a policy (or a registry/tool policy, or a deny flag) is
// present. Without one, `allowMutation` and `allowDangerous` both default to
// true and `deleteFileTool` would simply EXECUTE — `approvalSecret` alone only
// signs a pending approval once something has produced one.
const toolbox = createToolbox([deleteFileTool], {
  approvalPolicy: { mode: 'on-mutation' },
  approvalSecret: Bun.env['APPROVAL_SECRET'],
});

const agent = createAgent({
  generate: myProvider,
  toolbox,
  stopWhen: [stopWhen.pendingApproval(), stopWhen.noToolCalls()],
});

// Turn 1: run from the client-POSTed history.
const run = agent.run({ conversation: clientHistory });
const result = await run.result();
const pending = result.steps.at(-1)?.results.find((r) => r.pendingApproval)?.pendingApproval;
// ...send `pending` to a human, store `result.conversation.current` server-side...

// Later, on approval: resume on the SAME toolbox instance.
const resumedResult = await toolbox.resumeApproval(signedApproval);
```

> [!IMPORTANT] Reconcile the pending result — do not append on top of it
> `result.conversation` already carries an `action_required` tool-result for this call: the loop appends it before `stopWhen` ever runs. Appending `resumedResult` alongside it leaves two tool-results for one call, which most providers reject or mishandle on the next turn.
>
> Replace it in place with conversationalist's `resolveToolResult(conversation, callId, resumedResult)`, which addresses the message by `callId` (not by position or recency) and therefore works identically on a `Conversation` rehydrated from a persisted `ConversationHistory` — the case a stateless host hits on every resumed request. `Conversation.undo()` is NOT a substitute: it walks the in-process undo/redo graph, which a rehydrated conversation does not have in the same shape.
>
> Start the next turn from the resolved history. This README does not yet carry a full worked example of that round trip; see conversationalist's own documentation for `resolveToolResult` until one lands here.

**Mutation ownership:** `agent.run({ conversation })` SNAPSHOTS the supplied `ConversationHistory` — it clones the value before wrapping it in a fresh internal `Conversation`, so the run's state and the object you passed in are independent from the moment `run()` is called: the run never mutates your object, and mutations you make to it afterward (a stateless host commonly keeps a mutable reference between turns) never leak into an in-flight run. This matches the durable path's existing snapshot semantics. `instructions` is not re-appended on this path; the supplied history is assumed to already carry whatever system context it needs, so resuming it repeatedly never duplicates system messages.

#### `createActiveRun(options)`

The full-control factory behind `createAgent`, `createSessionHandle`, and bureau-owned agents alike — documented, public API, not an internal implementation detail. It accepts the complete `RunOptions` bag directly: an existing `Conversation` instance (not just a `ConversationHistory`), a pre-built `Toolbox`, hooks, and durable routing (engine + checkpoint store + run id). `bureau` and `evaluation` both depend on it as first-party consumers.

Most callers should reach for `createAgent({...}).run(...)` instead — it wraps `createActiveRun` in the higher-level `AgentRun` handle and covers the common cases. Reach for `createActiveRun` directly when you need something `createAgent` doesn't expose: an already-live `Conversation` instance, durable routing, hooks (`prepareStep`, `onStep`, `validateResponse`, …), structured output via `responseSchema`, or a pre-built emitter to bind tool dispatches to.

```typescript
import { createActiveRun, stopWhen } from '@lostgradient/operative';

// `stopWhen` is required for the in-memory loop to finish on an ordinary turn:
// without a stop condition, a text-only provider response keeps advancing until
// `maximumSteps` (25) instead of returning after the first reply.
const activeRun = createActiveRun({
  generate,
  toolbox,
  conversation,
  stopWhen: [stopWhen.noToolCalls()],
});
const result = await activeRun.result;
console.log(result.content, result.usage.total);
```

Like `createAgent`, a plain `ConversationHistory` passed here is SNAPSHOTTED on the way in, so a host that keeps mutating its stored history between turns cannot corrupt an in-flight run. Pass an already-live `Conversation` instance instead when you deliberately want the run to share it.

**`RunOptions`** — the complete options bag accepted by `createActiveRun`; key fields:

| Field                 | Type                                                   | Description                                                                          |
| --------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `generate`            | `GenerateFunction`                                     | Required. The caller-supplied LLM call.                                              |
| `toolbox`             | `Toolbox`                                              | Required. Tool registry.                                                             |
| `conversation`        | `Conversation \| ConversationHistory`                  | Required. Seed conversation.                                                         |
| `stopWhen`            | `StopCondition \| StopCondition[]`                     | Loop exit predicates.                                                                |
| `maximumSteps`        | `number`                                               | Hard step cap (default: `25`).                                                       |
| `prepareStep`         | `PrepareStepHook \| PrepareStepHook[]`                 | Runs before each generate call.                                                      |
| `beforeToolExecution` | `BeforeToolExecutionHook \| BeforeToolExecutionHook[]` | Modifies tool call list before execution.                                            |
| `afterToolExecution`  | `AfterToolExecutionHook \| AfterToolExecutionHook[]`   | Inspects/modifies tool results.                                                      |
| `onStep`              | `OnStepHook \| OnStepHook[]`                           | Called after each step completes.                                                    |
| `retry`               | `RetryOptions`                                         | Transient generate failure retry policy.                                             |
| `backpressure`        | `BackpressureStrategy`                                 | Delay strategy applied before each step.                                             |
| `validateResponse`    | `ValidateResponseHook \| ValidateResponseHook[]`       | Post-generate response validation.                                                   |
| `validateToolResult`  | `ValidateToolResultHook \| ValidateToolResultHook[]`   | Post-execute result validation.                                                      |
| `selectTools`         | `SelectToolsHook \| SelectToolsHook[]`                 | Per-step dynamic tool filtering.                                                     |
| `onElicitation`       | `OnElicitation`                                        | Human-in-the-loop input handler.                                                     |
| `contextManagement`   | `ContextManagementOptions`                             | Automatic context compaction.                                                        |
| `responseSchema`      | `ZodType`                                              | Structured output schema with retry.                                                 |
| `schemaRetries`       | `number`                                               | Retry attempts on schema validation failure.                                         |
| `onMaximumSteps`      | `(context) => Promise<string \| void>`                 | Called when the loop exits on `maximumSteps` — a returned string replaces `content`. |
| `hooks`               | `HookRegistry<OperativeHookMap>`                       | Typed priority-ordered hook registry.                                                |
| `signal`              | `AbortSignal`                                          | External cancellation signal.                                                        |

**`RunResult`:**

```typescript
interface RunResult {
  conversation: Conversation;
  steps: readonly StepResult[];
  content: string;
  usage: TokenUsage; // { prompt, completion, total }
  finishReason: FinishReason; // 'stop-condition' | 'maximum-steps' | 'aborted' | 'error' | …
  error?: unknown;
  schemaValidation?: { success: boolean; error?: unknown }; // present when responseSchema is set
}
```

**`ActiveRun` interface** — returned by `createActiveRun`, the event-emitting entry point. Attach listeners before awaiting `result`:

| Member                                | Description                                            |
| ------------------------------------- | ------------------------------------------------------ |
| `result: Promise<RunResult>`          | Resolves when the loop completes.                      |
| `abort(reason?)`                      | Cancels the loop immediately.                          |
| `complete()`                          | Completes the event stream without aborting the loop.  |
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
import type { GenerateFunction } from '@lostgradient/operative';

// Stub for tests or demos
const generate: GenerateFunction = async ({ conversation, toolbox }) => ({
  content: 'I can help with that.',
  toolCalls: [],
  usage: { prompt: 10, completion: 8, total: 18 },
});
```

In production, `operative`'s own provider subpaths (`@lostgradient/operative/anthropic`, `@lostgradient/operative/openai`, `@lostgradient/operative/gemini`) provide ready-made generate functions for Anthropic, OpenAI, and Gemini.

#### Sessions

The main entry point exposes session helpers for direct session management without a `SessionStore`:

- **`createAgentSession(options)`**: Creates a new `AgentSession` object.
- **`loadAgentSession(persistence, sessionId)`**: Loads an `AgentSession` from a conditional text-value store.
- **`saveAgentSession(persistence, session)`**: Persists an `AgentSession` through conflict-aware session storage.

```typescript
import { createAgentSession, loadAgentSession, saveAgentSession } from '@lostgradient/operative';

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
import {
  createActiveRun,
  createSessionStore,
  resumeSession,
  stopWhen,
} from '@lostgradient/operative';

// createSessionStore wraps Weft's conditional TextValueStore.
const sessions = createSessionStore(kvStore);

await sessions.save(session);
const summaries = await sessions.list({ agentName: 'my-agent', sortBy: 'updatedAt' });
const loaded = await sessions.load('session-abc');
await sessions.delete('session-abc');
await sessions.cleanup({ olderThan: 7 * 24 * 60 * 60 * 1000 }); // 1 week

// resumeSession loads an existing session (or creates a new one) and returns
// the restored Conversation so you can pass it into a run.
const { session, conversation, isNew } = await resumeSession(sessions, 'session-abc', {
  agentName: 'my-agent',
});

// Then drive a run from the restored, already-live Conversation instance.
// createAgent().run() only accepts a plain ConversationHistory (it snapshots
// its own fresh Conversation internally); createActiveRun accepts a live
// Conversation directly, which is what resumeSession returns.
const activeRun = createActiveRun({
  generate,
  toolbox,
  conversation,
  stopWhen: stopWhen.noToolCalls(),
});
const result = await activeRun.result;
```

**`SessionStore` interface:**

| Method                         | Description                                                 |
| ------------------------------ | ----------------------------------------------------------- |
| `save(session)`                | Persist a session with conflict-aware merging.              |
| `update(id, updater)`          | Read-modify-write a session through optimistic concurrency. |
| `load(id)`                     | Load by id; returns `undefined` if not found.               |
| `delete(id)`                   | Remove a session.                                           |
| `exists(id)`                   | Check existence.                                            |
| `list(options?)`               | Paginated list of `SessionSummary` objects.                 |
| `updateMetadata(id, metadata)` | Merge metadata without rewriting the conversation.          |
| `cleanup(options)`             | Delete sessions older than `options.olderThan` ms.          |

Sessions include a persisted `revision` number. New `AgentSession` objects start
at revision `0`; successful `SessionStore` writes increment the stored revision.
When concurrent writers save stale copies of the same session, the store retries
with Weft's conditional batch primitive and merges conversation messages, run
references, and metadata instead of silently dropping one writer's turns.

#### Hooks

Hooks plug into the loop lifecycle. Register them on `RunOptions.hooks` using a `HookRegistry`, or use the simpler array fields (`prepareStep`, `onStep`, etc.).

```typescript
import {
  composeHooks,
  createActiveRun,
  onlyOnStep,
  runOnce,
  withTimeout,
  everyNSteps,
  stopWhen,
} from '@lostgradient/operative';

// Compose two prepare-step hooks into one
const combined = composeHooks(
  onlyOnStep(0, async ({ conversation }) => {
    conversation.appendSystemMessage('Extra context injected on step 0.');
  }),
  withTimeout(5000, async (ctx) => {
    // Fetch something slow — times out and silently returns undefined after 5s
  }),
);

const activeRun = createActiveRun({
  generate,
  toolbox,
  conversation,
  stopWhen: stopWhen.noToolCalls(),
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

See [`@lostgradient/operative/guardrails`](#operativeguardrails--guardrails) below for the tripwire model, the detector/validator catalog, provenance and the three retrieval surfaces, and the `bureau` default preset. This is a quick-start example; import from either `operative` or `@lostgradient/operative/guardrails` — they're the same implementation.

```typescript
import {
  createActiveRun,
  createGuardrails,
  createPromptInjectionDetector,
  createInputLengthDetector,
  createTopicBoundaryDetector,
  createOutputPIIValidator,
  stopWhen,
} from '@lostgradient/operative';

// Injection detection on inputs
const injectionDetector = createPromptInjectionDetector();

// Restrict topics
const topicGuard = createTopicBoundaryDetector({
  allowedTopics: ['cooking', 'recipes'],
  blockedKeywords: ['finance', 'legal'],
});

// Block overlong inputs
const lengthGuard = createInputLengthDetector({ maxLength: 2000 });

// Compose into a guardrails hook set
const guardrails = createGuardrails({
  input: { detectors: [injectionDetector, topicGuard, lengthGuard] },
  output: { validators: [createOutputPIIValidator()] },
});

const activeRun = createActiveRun({
  generate,
  toolbox,
  conversation,
  stopWhen: stopWhen.noToolCalls(),
  prepareStep: guardrails.prepareStep,
  validateResponse: guardrails.validateResponse,
});
```

#### Context Assembly

`createContextAssembler()` returns a function that, given a conversation and a
budget, partitions messages into system / retrieved / history slices and
trims each to fit:

```typescript
import { createContextAssembler, createTokenBudget } from '@lostgradient/operative';

const budget = createTokenBudget({
  maxTokens: 100_000,
  minimumResponseTokens: 4_000,
});

const assembler = createContextAssembler();
const { messages, budgetReport } = assembler({ conversation, budget });
```

**Stable-prefix mode (`stablePrefix: true`)** trades the default
priority-ranked/budget-fill behavior for a prompt-cache-friendly one: system
messages and `pinnedMessages` are assembled into a prefix that stays
byte-identical across steps as the conversation grows — never budget-truncated,
never re-ranked — and the last message of that prefix comes back with
`cacheBoundary: true`. History and `retrievedMessages` are unaffected: they're
assembled exactly as in the default mode and appended AFTER the stable prefix,
so their normal per-step re-ranking never touches the cached region.

```typescript
const { messages } = assembler({
  conversation,
  budget,
  stablePrefix: true,
  pinnedMessages: [toolUsageNotesMessage], // always included, in order, right after system
});
```

The `cacheBoundary` mark is the same conversation-level primitive
`conversationalist`'s Anthropic adapter already lowers to a `cache_control`
breakpoint (`toAnthropicMessages`). `createAnthropicProvider` and
`createAnthropicProviderStream` consume it directly — pass `assembler` and
`contextBudget` and every request runs through stable-prefix assembly instead
of sending the conversation verbatim:

```typescript
import {
  createAnthropicProvider,
  createContextAssembler,
  createTokenBudget,
} from '@lostgradient/operative';

const generate = createAnthropicProvider({
  model: 'claude-sonnet-4-20250514',
  assembler: createContextAssembler(),
  contextBudget: createTokenBudget({ maxTokens: 100_000 }),
  pinnedMessages: [toolUsageNotesMessage],
});
```

**Cache economics.** Anthropic prices a cache write at 1.25x the base prompt
rate and a cache read at 0.1x (`estimateCost` already applies this — see
`cost-estimation.ts`). A run whose system prompt is a few thousand tokens pays
that 1.25x premium once, on the first step, then reads the same prefix at
0.1x on every following step instead of paying full price for it again — a
~90% cost cut on that slice of the request for steps 2 onward. Prompt-cache
hit rate is exposed per step and cumulatively on `usage.accumulated`
(`UsageAccumulatedEvent.stepCacheHitRate` / `totalCacheHitRate`, computed by
`estimateCacheHitRate`). `test/prompt-cache-economics.test.ts` walks through
these numbers end to end against the mock Anthropic client (no live API
calls) — see it for the worked example.

**Extended (1-hour) cache TTL.** Anthropic's cache breakpoints default to a
5-minute TTL. Passing `extendedCacheTtl: true` to `createAnthropicProvider` /
`createAnthropicProviderStream` opts every `cache_control` breakpoint lowered
from a `cacheBoundary` mark into the extended one-hour TTL instead
(`cache_control: { type: 'ephemeral', ttl: '1h' }`), which Anthropic bills at
a higher cache-write rate in exchange for a longer-lived cache. It only takes
effect on requests that actually have a cache boundary (i.e. `assembler` +
`contextBudget`, or an already-marked conversation). OpenAI and Gemini use
implicit, non-configurable prompt caching — there's no checkpoint metadata to
interpret, so this option doesn't apply to `createOpenAIProvider` /
`createGeminiProvider`.

#### Providers Behind a Proxy

Every shipped provider (`createAnthropicProvider`, `createOpenAIProvider`,
`createGeminiProvider`, and their streaming counterparts) accepts a
`baseURL` override and an arbitrary `apiKey` string with no shape
validation — both pass straight to the underlying SDK client, so a
credential-injecting proxy can sit in front of the real provider and swap in
the real key server-side:

```typescript
const generate = createAnthropicProvider({
  model: 'claude-sonnet-4-20250514',
  apiKey: 'placeholder-token', // never a real key — the proxy injects it
  baseURL: 'https://llm-proxy.internal.example.com',
});
```

**Per-provider endpoint allowlist.** Each provider issues requests to exactly
one endpoint per generate call (a second, distinct endpoint for the streaming
factories of OpenAI and Gemini) — the set below is pinned by
`test/provider-proxy-contract.test.ts`, which runs each provider (and each
streaming counterpart) through a real SDK client against a local `Bun.serve`
mock and asserts the exact `(method, path)` set observed over a multi-step
run. Use it to build a proxy allowlist:

| Provider           | Method | Path                                               | Auth header                     |
| ------------------ | ------ | -------------------------------------------------- | ------------------------------- |
| Anthropic          | POST   | `/v1/messages` (streaming uses the same path)      | `x-api-key`                     |
| OpenAI             | POST   | `/chat/completions` (streaming uses the same path) | `authorization: Bearer <token>` |
| Gemini             | POST   | `/v1beta/models/{model}:generateContent`           | `x-goog-api-key`                |
| Gemini (streaming) | POST   | `/v1beta/models/{model}:streamGenerateContent`     | `x-goog-api-key`                |

No provider issues a token-counting, models-list, or beta/experimental
endpoint call as part of a normal generate step.

**Per-run request metadata.** `requestMetadata` (a `Record<string, string>`)
attaches to every generate request of a run:

```typescript
const generate = createAnthropicProvider({
  model: 'claude-sonnet-4-20250514',
  requestMetadata: { requestId: 'run-42', tenant: 'acme' },
});
```

It's mapped to each provider's native field: Anthropic Messages `metadata`,
OpenAI Chat Completions `metadata` (native string-keyed map, up to 16 keys).
Gemini's `generateContent` API has no request-level metadata field, so
`requestMetadata` is an explicit no-op for `createGeminiProvider` /
`createGeminiProviderStream`.

**Anthropic caveat — the whole object is forwarded, but the real API only
accepts `user_id`.** Anthropic's `Metadata` type has exactly one documented
field (`user_id`); calling `createAnthropicProvider` with `requestMetadata`
containing OTHER keys and pointing `baseURL` at Anthropic's real endpoint
directly (no proxy in front) gets the request rejected. This option exists
for the credential-injecting-proxy case above: the proxy sees the whole
object on the wire and can route/log on it, then either forward only
`user_id` to the real Anthropic API or strip/translate the rest before
forwarding. Don't pass arbitrary `requestMetadata` keys straight through to
`api.anthropic.com` — only to a proxy that knows what to do with them.

#### Provider Errors

Every shipped provider throws `ProviderError` (`@lostgradient/operative/providers`) for
HTTP/SDK failures — it carries `provider`, `cause`, an optional
`statusCode`, and `retryable` (true only for status codes in `{429, 500,
502, 503, 504}`).

`createAnthropicProviderStream` and `createOpenAIProviderStream` throw the
more specific `ToolCallParseError` — a `ProviderError` subclass — when the
model finishes a turn but the accumulated tool-call argument JSON it
streamed doesn't parse. This is a malformed-output problem, not an API
failure: the request succeeded, the model just emitted bad JSON. It carries
`toolName`, `toolCallId` (`string | undefined` — the provider didn't always
assign one before the parse failed), and `rawArguments` (the unparsed
fragment) alongside the inherited `ProviderError` fields, and `retryable` is
always `false` since it never has a `statusCode`.

```typescript
import { ToolCallParseError } from '@lostgradient/operative/providers';

try {
  await generate(context);
} catch (error) {
  if (error instanceof ToolCallParseError) {
    // The model streamed unparseable arguments for error.toolName —
    // distinct from a provider outage.
  }
}
```

If the caller aborts `context.signal` mid-stream while a tool call's
arguments are still accumulating, the truncated fragment is never parsed
and never thrown as a `ToolCallParseError` — that's cancellation, not
malformed model output, so the tool call is simply omitted from the
response's `toolCalls`.

`classifyError` (from `operative`) recognizes `ToolCallParseError` and
reports it under the `'model-output'` category, so error-classification and
routing code can tell "the provider is down" apart from "the model emitted
bad JSON" without an `instanceof` check.

**Cross-entrypoint `instanceof`.** Operative bundles each public entrypoint
(`operative`, `@lostgradient/operative/openai`, `@lostgradient/operative/providers`, ...) separately
with no shared chunks, so a `ToolCallParseError` thrown from one
entrypoint's bundle is not `instanceof` the `ToolCallParseError` re-exported
from a different entrypoint. `classifyError` accounts for this internally.
If you need to check the error type yourself across entrypoints, use
`isToolCallParseError` (`@lostgradient/operative/providers`) instead of a bare
`instanceof`:

```typescript
import { isToolCallParseError } from '@lostgradient/operative/providers';

if (isToolCallParseError(error)) {
  // Matches structurally even if `error` came from a different
  // operative entrypoint's bundle than this check.
}
```

#### Backpressure

```typescript
import {
  createActiveRun,
  createSlidingWindow,
  createTokenBucket,
  createAdaptiveBackoff,
  stopWhen,
} from '@lostgradient/operative';

// Smooth out burst traffic with a sliding window
const backpressure = createSlidingWindow({ windowSize: 60_000, maximumRequests: 20 });

// Token bucket for sustained rate control
const bucket = createTokenBucket({ tokensPerInterval: 1, interval: 1000 }); // 1 token/sec

// Exponential backoff that self-adjusts based on error rate
const adaptive = createAdaptiveBackoff({ initialDelay: 500, maximumDelay: 30_000 });

const activeRun = createActiveRun({
  generate,
  toolbox,
  conversation,
  stopWhen: stopWhen.noToolCalls(),
  backpressure,
});
const result = await activeRun.result;
```

#### Caching

```typescript
import { createActiveRun, stopWhen, withCache, withCacheMetrics } from '@lostgradient/operative';

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

const activeRun = createActiveRun({
  generate: metered,
  toolbox,
  conversation,
  stopWhen: stopWhen.noToolCalls(),
});
const result = await activeRun.result;
// metrics.hits, metrics.misses, metrics.hitRate, metrics.totalSavedTokens
metrics.reset(); // clear counters between test runs
```

#### Generate Middleware

```typescript
import { composeGenerate, createFallbackGenerate } from '@lostgradient/operative';
import type { GenerateMiddleware } from '@lostgradient/operative';

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

The registry-based patterns below (`createSupervisor`, `createHandoffTool`, `createAgentRegistry`) predate `createAgent` and are built around the older `RegistryAgent` shape — `{ name, run(input, context?): Promise<unknown> }`. A `StandaloneAgent` from `createAgent` doesn't expose `.name`, and its `.run(input)` returns a non-thenable `AgentRun` rather than a `Promise` directly, so wrap it in a thin adapter (`{ name, run: (input) => agent.run(input).result() }`) wherever one of these APIs expects a `RegistryAgent`.

**Subagents:**

```typescript
import { createAgent, createSubagentTool } from '@lostgradient/operative';
import { z } from 'zod';

const researcherTool = createSubagentTool({
  name: 'research',
  description: 'Delegates a research task to a specialist agent.',
  agentName: 'researcher',
  run: (prompt) => researcherAgent.run(prompt).result(),
  input: z.object({ query: z.string() }),
  // mapInput receives the tool's raw, Zod-validated arguments as `unknown` —
  // narrow to the schema shape declared above.
  mapInput: (input) => (input as { query: string }).query,
});

const orchestrator = createAgent({
  generate,
  tools: { research: researcherTool },
});
```

**Context isolation (AB-64):** by default, `createSubagentTool` keeps a
sub-agent's full conversation, steps, and usage out of the parent's context
window — only a capped summary of its `content` crosses back. `returnMode`
controls this:

- `'summary'` — the **documented default**. Only `result.content`, condensed
  by a `summarizer` and hard-capped at `summaryTokenCap` tokens (default
  `500`), returns to the parent. The sub-agent's own transcript stays
  isolated. This is what keeps a fan-out of several sub-agents from blowing
  up the orchestrator's context window.
- `'full'` — `result.content` is returned verbatim and uncapped. Opt in
  deliberately, e.g. for a single close-coupled delegation that needs the
  sub-agent's exact output (structured extraction, code the parent will
  paste unmodified).

Both modes ultimately hand off to `mapOutput(result)`, which still receives
the complete `RunResult` — including `conversation`, `steps`, and `usage` —
so a custom `mapOutput` CAN reach past the summary and return those fields
directly. `returnMode`/`summaryTokenCap` cap `result.content`, not what a
custom `mapOutput` chooses to do with the rest of the object; keep that in
mind if you override `mapOutput`.

```typescript
const researcherTool = createSubagentTool({
  name: 'research',
  description: 'Delegates a research task to a specialist agent.',
  agentName: 'researcher',
  run: (prompt) => researcherAgent.run(prompt).result(),
  input: z.object({ query: z.string() }),
  // mapInput receives the tool's raw, Zod-validated arguments as `unknown` —
  // narrow to the schema shape declared above.
  mapInput: (input) => (input as { query: string }).query,
  // returnMode: 'summary' is the default — shown explicitly here.
  returnMode: 'summary',
  summaryTokenCap: 300,
  // Swap in a real LLM-backed condensation instead of the default
  // character-truncation summarizer:
  summarizer: async (result, { agentName, maxTokens, signal }) => {
    // Pass `signal` through to cancel the LLM call if the parent tool call
    // is aborted while summarization is in flight.
    return condenseWithLLM(result.content, { agentName, maxTokens, signal });
  },
});
```

**Supervisor:**

```typescript
import {
  createSupervisor,
  createRoundRobinRouting,
  createCapabilityRouting,
} from '@lostgradient/operative';
import type { AgentRegistryEntry } from '@lostgradient/operative';

// Agents are wrapped as AgentRegistryEntry objects; `.agent` is a
// RegistryAgent adapter over each StandaloneAgent (see the note above).
const agentPool: AgentRegistryEntry[] = [
  {
    agent: { name: 'writer', run: (input) => writerAgent.run(input).result() },
    description: 'Writes prose',
    capabilities: ['writing'],
  },
  {
    agent: { name: 'researcher', run: (input) => researcherAgent.run(input).result() },
    description: 'Finds facts',
    capabilities: ['research'],
  },
  {
    agent: { name: 'editor', run: (input) => editorAgent.run(input).result() },
    description: 'Edits copy',
    capabilities: ['editing'],
  },
];

const supervisor = createSupervisor({
  agents: agentPool,
  routing: createRoundRobinRouting(),
  // or createCapabilityRouting() for skill-based dispatch
});

const supervisorResult = await supervisor.delegate('Write a detailed report on climate change.');
// supervisorResult.synthesis — the merged output
```

**Supervisor synthesis and context discipline (AB-64):** the built-in
`synthesis` strategy concatenates every delegated agent's `result.content`
verbatim, attributed by agent name — it applies no cap. That default is fine
for a small, fixed agent pool, but it does not carry the same
context-isolation discipline as `createSubagentTool`'s `'summary'` mode: a
`createFanOutRouting()` delegation across many agents can accumulate an
uncapped amount of text into `supervisorResult.synthesis`. For fan-out at
scale, supply a custom `SynthesisStrategy` that applies the same discipline
— condense each `SupervisorTaskResult` (optionally via
`defaultSubagentSummarizer` or your own summarizer) and cap the combined
output before returning it:

```typescript
import { createFanOutRouting, defaultSubagentSummarizer } from '@lostgradient/operative';
import type { SynthesisStrategy } from '@lostgradient/operative';

const cappedSynthesis: SynthesisStrategy = async (results) => {
  const summaries = await Promise.all(
    results.map(async (r) => {
      if (r.error || !r.result) return `[${r.agentName}] Error`;
      const summary = await defaultSubagentSummarizer(r.result, {
        agentName: r.agentName,
        maxTokens: 200,
      });
      return `[${r.agentName}] ${summary}`;
    }),
  );
  return summaries.join('\n\n');
};

const supervisor = createSupervisor({
  agents: agentPool,
  routing: createFanOutRouting(),
  synthesis: cappedSynthesis,
});
```

**Handoffs:**

```typescript
import { createHandoffTool, extractHandoffTarget, HANDOFF_MARKER } from '@lostgradient/operative';

// Each handoff targets one specific agent
const escalateToSupport = createHandoffTool({
  name: 'escalate-to-support',
  description: 'Transfer the conversation to the human support agent.',
  agent: { name: 'support', run: (input) => supportAgent.run(input).result() },
});

// After a run, check whether a handoff occurred. extractHandoffTarget expects
// each step's tool-result content as a string — true for any tool built with
// createTool() (execute always returns a string), but RunResult.steps carries
// the wider ToolExecutionResult.content (JSONValue), so narrow it first.
const target = extractHandoffTarget(
  result.steps.map((step) => ({
    results: step.results.map((r) => ({ content: String(r.content) })),
  })),
);
if (target) {
  // target is the agent name that was handed off to
}
```

**Agent Registry:**

```typescript
import { createAgentRegistry, createAgentDiscoveryTool } from '@lostgradient/operative';

const registry = createAgentRegistry();
registry.register({
  agent: { name: 'researcher', run: (input) => researcherAgent.run(input).result() },
  description: 'Finds facts',
  capabilities: ['research'],
  tags: ['research'],
});
registry.register({
  agent: { name: 'writer', run: (input) => writerAgent.run(input).result() },
  description: 'Writes prose',
  capabilities: ['writing'],
  tags: ['writing'],
});

// Let an orchestrator discover agents dynamically
const discoveryTool = createAgentDiscoveryTool(registry);
```

#### Scheduler

```typescript
import {
  createScheduler,
  createHeartbeat,
  createChunkedTask,
  stopWhen,
} from '@lostgradient/operative';
import type { SchedulerTask } from '@lostgradient/operative';

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
    generate,
    toolbox,
    conversation,
    stopWhen: stopWhen.noToolCalls(),
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
  createHeartbeatRun: () => ({ generate, toolbox, conversation, stopWhen: stopWhen.noToolCalls() }),
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
import { estimateCost, createCostBudgetMonitor } from '@lostgradient/operative';

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
import { createActiveRun, stopWhen } from '@lostgradient/operative';
import { z } from 'zod';

const OutputSchema = z.object({
  summary: z.string(),
  keyPoints: z.array(z.string()),
  confidence: z.number().min(0).max(1),
});

const activeRun = createActiveRun({
  generate,
  toolbox,
  conversation,
  stopWhen: stopWhen.noToolCalls(),
  responseSchema: OutputSchema,
  schemaRetries: 2,
});
```

#### Scratchpad

```typescript
import {
  createAgent,
  createScratchpad,
  createScratchpadReadTool,
  createScratchpadWriteTool,
} from '@lostgradient/operative';

const scratchpad = createScratchpad({ initialValues: { step: 0 } });

const readTool = createScratchpadReadTool(scratchpad);
const writeTool = createScratchpadWriteTool(scratchpad);

const agent = createAgent({
  generate,
  tools: { 'scratchpad-read': readTool, 'scratchpad-write': writeTool },
});
```

#### Context Compaction

```typescript
import { createActiveRun, createContextCompactor, stopWhen } from '@lostgradient/operative';

// createContextCompactor returns an onCompact function for contextManagement.
// The summarize callback receives an array of Message objects (not a Conversation).
const onCompact = createContextCompactor({
  summarize: async (messages) => {
    // Condense messages into a summary string — call your provider here.
    return `Summary of ${messages.length} prior messages.`;
  },
  retainRecentMessages: 6,
});

const activeRun = createActiveRun({
  generate,
  toolbox,
  conversation,
  stopWhen: stopWhen.noToolCalls(),
  contextManagement: {
    maxTokens: 80_000,
    onCompact,
  },
});
```

#### Memory Bridge

```typescript
import {
  createActiveRun,
  createMemoryBridge,
  createScratchpad,
  stopWhen,
} from '@lostgradient/operative';
import type { GenerateFunction, MemoryLike } from '@lostgradient/operative';

declare const generate: GenerateFunction;
declare const myMemoryAdapter: MemoryLike;

// operative never imports the memory package directly — supply a MemoryLike adapter.
// createMemoryBridge returns { prepareStep, onStep }.
// prepareStep recalls memories into the scratchpad on step 0.
// onStep persists scratchpad entries back to long-term memory on the final step.
// Register createScratchpadReadTool(scratchpad) / createScratchpadWriteTool(scratchpad)
// on the toolbox you pass below so the model can read and write it.
const scratchpad = createScratchpad();
const bridge = createMemoryBridge({
  memory: myMemoryAdapter, // satisfies MemoryLike
  scratchpad,
  recallLimit: 5,
  scratchpadKey: 'memories',
});

const activeRun = createActiveRun({
  generate,
  toolbox,
  conversation,
  stopWhen: stopWhen.noToolCalls(),
  prepareStep: bridge.prepareStep,
  onStep: bridge.onStep,
});
```

#### Identity Hook

```typescript
import { createActiveRun, createIdentityHook, stopWhen } from '@lostgradient/operative';

const identityHook = createIdentityHook({
  resolve: async () => 'You are Aria, a friendly customer success agent.',
});

const activeRun = createActiveRun({
  generate,
  toolbox,
  conversation,
  stopWhen: stopWhen.noToolCalls(),
  prepareStep: identityHook,
});
```

#### Policy Enforcement

```typescript
import { createPolicyEnforcementHook } from '@lostgradient/operative';
import type { ToolLike } from '@lostgradient/operative';

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
import { createActiveRun, createEarlyStoppingHandler, stopWhen } from '@lostgradient/operative';

// Creates an onMaximumSteps callback that calls the model one final time
// without tools, prompting it to summarize findings before the loop ends.
const onMaximumSteps = createEarlyStoppingHandler(generate, {
  message: 'Summarize your findings so far in one paragraph.',
});

const activeRun = createActiveRun({
  generate,
  toolbox,
  conversation,
  stopWhen: stopWhen.noToolCalls(),
  maximumSteps: 10,
  onMaximumSteps,
});
```

---

### `@lostgradient/operative/conditions` — Stop Conditions

Composable predicates for loop exit. All are available on the `stopWhen` namespace object, or can be imported individually.

```typescript
import { createActiveRun } from '@lostgradient/operative';
import { stopWhen } from '@lostgradient/operative/conditions';

// Stop when the model produces no tool calls (each predicate is a factory — call it)
const noTools = stopWhen.noToolCalls();

// Stop after 5 steps
const maxSteps = stopWhen.maximumSteps(5);

// Stop when a specific tool was called
const submitted = stopWhen.toolCalled('submit-form');

// Stop when any tool result's outcome is 'error' or 'action_required'
const errored = stopWhen.toolOutcome('error');

// Stop when content satisfies a predicate
const goodbyeDetected = stopWhen.contentMatches((content) => /goodbye/i.test(content));

// Logical composition
const compound = stopWhen.some(stopWhen.noToolCalls(), stopWhen.maximumSteps(10));

// Must ALL conditions be true to stop
const strict = stopWhen.every(stopWhen.noToolCalls(), stopWhen.toolCalled('finalize'));

// Invert any condition
const mustUseTool = stopWhen.not(stopWhen.noToolCalls());

// Detect the model repeating the same tool call in a loop (windowSize defaults to 3)
const noLoop = stopWhen.repeatingToolCalls({ windowSize: 3 });

// Stop on token budget (maxTokens is positional)
const underBudget = stopWhen.tokenBudget(50_000);

// Hard wall-clock timeout (milliseconds is positional)
const timed = stopWhen.wallClockTimeout(30_000);

// Stop when accumulated cost exceeds a dollar amount
const affordable = stopWhen.costBudget({ budget: 0.05, model: 'claude-sonnet-4-20250514' });

// Fork: stop condition for branching workflows
const branchDone = stopWhen.forked();

// Park cleanly after a step whose tool results include a pending approval —
// no further generate call happens. See createAgent's stateless chat host
// recipe above for the full resume flow (toolbox.resumeApproval + a fresh
// run started from the updated conversation history).
const parkOnApproval = stopWhen.pendingApproval();

const activeRun = createActiveRun({
  generate,
  toolbox,
  conversation,
  stopWhen: [noTools, maxSteps],
});
```

**All `stopWhen` predicates:**

| Predicate                                  | Description                                                              |
| ------------------------------------------ | ------------------------------------------------------------------------ |
| `noToolCalls()`                            | Stop when a step produces zero tool calls.                               |
| `toolCalled(name)`                         | Stop when a tool with the given name was called.                         |
| `maximumSteps(n)`                          | Stop after `n` steps.                                                    |
| `toolOutcome(outcome)`                     | Stop when any tool result's outcome is `'error'` or `'action_required'`. |
| `contentMatches(predicate)`                | Stop when `predicate(content)` returns `true`.                           |
| `every(...conditions)`                     | AND — stop when all conditions are true.                                 |
| `some(...conditions)`                      | OR — stop when any condition is true.                                    |
| `not(condition)`                           | Negate a condition.                                                      |
| `forked()`                                 | Stop condition for branching / forked workflow control.                  |
| `repeatingToolCalls(options?)`             | Stop when the same tool repeats `windowSize` times (default 3).          |
| `tokenBudget(maxTokens, options?)`         | Stop when cumulative token usage exceeds `maxTokens`.                    |
| `wallClockTimeout(milliseconds, options?)` | Stop when elapsed wall-clock time exceeds `milliseconds`.                |
| `costBudget(options)`                      | Stop when accumulated dollar cost exceeds `options.budget`.              |

---

### `@lostgradient/operative/guardrails` — Guardrails

Guardrails are the trust boundary between the agent loop and everything that can inject untrusted content into it — the user, retrieved memories, ingested documents, and skill resources. Detectors live in `armorer` (shared with the retrieval surfaces); `@lostgradient/operative/guardrails` wires them into the loop as `prepareStep`/`validateResponse` hooks. The same functions are also re-exported from the root `operative` entry point (see [Guardrails](#guardrails) under Public API) — import from either path, they're the same implementation.

#### The Tripwire Model (AB-40)

Every detector/validator returns a `DetectionResult`/`ValidationResult` carrying a `confidence` score. What happens when one triggers is governed by an `action`, configured per guardrail group — `InputGuardrailOptions.action` (`'block' | 'warn' | 'sanitize' | 'tripwire'`, using `DetectionResult.sanitized` for `'sanitize'`) and `OutputGuardrailOptions.action` (`'block' | 'warn' | 'redact' | 'tripwire'`, using `ValidationResult.redacted` for `'redact'`). `GuardrailsOptions.mode` sets both sides at once:

- **`mode: 'validate'`** (default) — a tripped detector/validator substitutes a blocked/sanitized/redacted response and the run continues, per each guardrail's own `action`.
- **`mode: 'tripwire'`** — overrides `input.action`/`output.action` to `'tripwire'` regardless of what they were set to. A tripped wire throws a `GuardrailTripwireError`, hard-halting the run with `finishReason: 'tripwire'` and a `run.tripwire` event identifying the guardrail, instead of substituting a blocked or redacted response. Use this where a false negative is unacceptable and a human should look at the transcript before the agent takes another step.

`withMinimumTripwireConfidence(detector, threshold)` wraps a detector so it only trips at or above a confidence floor, letting a broad detector stay quiet on low-confidence hits while still reaching the tripwire on high-confidence ones.

#### Detector and Validator Catalog

| Name                            | Kind             | Scans                             | Notes                                                                                                                                                                                                                                             |
| ------------------------------- | ---------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createPromptInjectionDetector` | Input detector   | Incoming content, any provenance  | Pattern + heuristic scoring; confidence scales with the number of matched signals.                                                                                                                                                                |
| `createInputLengthDetector`     | Input detector   | Incoming content                  | Blocks overlong inputs before they reach the model.                                                                                                                                                                                               |
| `createTopicBoundaryDetector`   | Input detector   | Incoming content                  | Restricts the conversation to an allow/block topic list.                                                                                                                                                                                          |
| `createOutputPIIValidator`      | Output validator | Model output                      | Detects and redacts email addresses, phone numbers, and API-key-shaped secrets in generated text.                                                                                                                                                 |
| `createGroundingValidator`      | Output validator | Model output vs. supplied context | Flags claims the output makes that aren't traceable to the provided context.                                                                                                                                                                      |
| `createCodeSafetyValidator`     | Output validator | Model output                      | Flags destructive shell patterns (`rm -rf`), code execution (`eval`/`exec`/`Function`/`subprocess`), dangerous SQL (`DROP TABLE`, unfiltered `DELETE FROM`), and pipe-to-shell (`curl \| bash`) in generated code. Extend with `blockedPatterns`. |
| `createSessionTaintTracker`     | Session state    | Cumulative session history        | Sticky escalation: once a high-confidence hit taints a session, escalated detectors/validators activate for its remainder.                                                                                                                        |

#### Provenance and the Three Retrieval Surfaces (AB-41)

Input detectors run against a `GuardrailProvenance` tag — every `DetectorContext.provenance` and every `GuardrailTriggeredEvent.provenance` on the input side carries one of:

- `'user-input'` — content typed directly by the session's user.
- `'recalled-memory'` — content pulled in by `memory`'s recall tool.
- `'ingested-document'` — content pulled in from an ingested document (e.g. a file or URL fetched into context).
- `'skill-resource'` — content pulled in from a skill's bundled resources.

The three retrieval tags mark a distinct trust boundary from `'user-input'`: that content was authored by someone (or something) other than the current session's user and may have been crafted specifically to manipulate the model. Callers that assemble context from memory, documents, or skills should tag detector calls with the matching provenance so guardrail triggers and audit logs can distinguish "the user asked for this" from "this arrived via retrieval." (Provenance is an input-side concept — output validators run against generated text with no retrieval source to tag; a taint raised from a retrieval surface can still carry its `provenance` through `SessionTaintedEvent.provenance` into `createSessionTaintTracker`.)

#### The Bureau Default Preset

`bureau` wires a guardrail preset automatically whenever `BureauOptions.guardrails` is left `undefined`:

- `mode: 'tripwire'` — any trigger hard-halts the run.
- **Input**: `createPromptInjectionDetector()` wrapped in `withMinimumTripwireConfidence(..., DEFAULT_PROMPT_INJECTION_TRIPWIRE_THRESHOLD)` — the threshold is `0.6`, so only medium-to-high-confidence injection matches trip the run.
- **Output**: `createOutputPIIValidator()` — output PII trips the run rather than being redacted.

Pass `guardrails: false` to `bureau`'s options to opt out entirely, or a `GuardrailsOptions` object to replace the preset with your own detectors/validators.

**Buffered-generation note:** the default preset's output PII validator only ever sees a complete response — it cannot inspect a stream mid-flight. `bureau` accounts for this: whenever the default preset is in effect (`options.guardrails === undefined`), it forces buffered (non-streaming) generation so the tripwire has a chance to fire before any output reaches the caller. A caller who supplies their own `GuardrailsOptions` (replacing the preset) has opted into managing that tradeoff themselves and keeps streaming enabled.

#### Usage

```typescript
import {
  createGuardrails,
  createPromptInjectionDetector,
  createOutputPIIValidator,
  withMinimumTripwireConfidence,
} from '@lostgradient/operative/guardrails';
import { createActiveRun, stopWhen } from '@lostgradient/operative';

const guardrails = createGuardrails({
  mode: 'tripwire',
  input: {
    detectors: [withMinimumTripwireConfidence(createPromptInjectionDetector(), 0.6)],
  },
  output: { validators: [createOutputPIIValidator()] },
});

const activeRun = createActiveRun({
  generate,
  toolbox,
  conversation,
  stopWhen: stopWhen.noToolCalls(),
  prepareStep: guardrails.prepareStep,
  validateResponse: guardrails.validateResponse,
});
```

**Exported functions:** `createGuardrails`, `createInputGuardrail`, `createOutputGuardrail`, `createSessionTaintTracker`, `createCodeSafetyValidator`, `createGroundingValidator`, `createOutputPIIValidator`, `createInputLengthDetector`, `createPromptInjectionDetector`, `createTopicBoundaryDetector`, `withMinimumTripwireConfidence`, `DEFAULT_PROMPT_INJECTION_TRIPWIRE_THRESHOLD`.

**Exported types:** `DetectionResult`, `DetectorContext`, `GuardrailHooks`, `GuardrailProvenance`, `GuardrailsOptions`, `GuardrailTriggeredEvent`, `InputDetector`, `InputGuardrailOptions`, `OutputGuardrailOptions`, `OutputGuardrailTriggeredEvent`, `OutputValidator`, `SessionTaintedEvent`, `SessionTaintOptions`, `SessionTaintTracker`, `ValidationResult`, `ValidatorContext`, `CodeSafetyValidatorOptions`, `GroundingValidatorOptions`, `InputLengthDetectorOptions`, `PromptInjectionDetectorOptions`, `TopicBoundaryDetectorOptions`.

---

### `@lostgradient/operative/store` — Run Store

Observes one or more `ActiveRun` instances, accumulating steps, usage, and the action log. Use this to build dashboards, replay UIs, or cross-run analytics.

```typescript
import { createStore } from '@lostgradient/operative/store';
import { createActiveRun, stopWhen } from '@lostgradient/operative';

const store = createStore({ maxActions: 500, maxSnapshots: 10 });

const activeRun = createActiveRun({
  generate,
  toolbox,
  conversation,
  stopWhen: stopWhen.noToolCalls(),
});
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

### `@lostgradient/operative/streaming` — Streaming Helpers

Wraps a streaming generate function into the standard `GenerateFunction` contract, and provides enhanced streaming primitives with state machines and backpressure buffers.

#### `withStreaming(fn)`

Adapts a `StreamingGenerateFunction` (one that receives a `StreamingHandle`) into a standard `GenerateFunction`. The helper manages `appendStreamingMessage → updateStreamingMessage → finalizeStreamingMessage` on the conversation so the loop never sees raw streaming state:

```typescript
import { createActiveRun, stopWhen } from '@lostgradient/operative';
import { withStreaming } from '@lostgradient/operative/streaming';
import type { StreamingGenerateFunction } from '@lostgradient/operative';

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
const activeRun = createActiveRun({
  generate,
  toolbox,
  conversation,
  stopWhen: stopWhen.noToolCalls(),
});
const result = await activeRun.result;
```

#### `withEnhancedStreaming(fn, options?)`

Wraps a `StreamingGenerateFunction` (like `withStreaming`, above) but also drives a `StreamStateMachine` internally and calls fine-grained callbacks as text and tool-call deltas arrive:

```typescript
import { withEnhancedStreaming } from '@lostgradient/operative/streaming';
import type { StreamingGenerateFunction } from '@lostgradient/operative';

declare const streamingGenerate: StreamingGenerateFunction;

const generate = withEnhancedStreaming(streamingGenerate, {
  onTextDelta: (delta, accumulated) => console.log('Text delta:', delta, accumulated),
  onToolCallStart: (toolName) => console.log('Tool call started:', toolName),
  onToolCallDelta: (_toolName, partialArgs) => console.log('Tool call args so far:', partialArgs),
});
```

#### `createBackpressureBuffer(options)`

Creates a backpressure-aware buffer for streaming events — queues, coalesces, and drops `StreamEvent`s under load:

```typescript
import { createBackpressureBuffer } from '@lostgradient/operative/streaming';

const buffer = createBackpressureBuffer({
  maxBufferSize: 100,
  coalesceDeltas: true,
  onOverflow: (droppedCount) => console.warn(`Dropped ${droppedCount} buffered events`),
  onEmit: (event) => console.log('Emit:', event.type),
});

buffer.push({ type: 'stream:text-delta', content: 'Hello', accumulated: 'Hello' });
```

#### `createStreamStateMachine()`

Parses a raw token stream into typed blocks (`text`, `tool-call`, `thinking`, `metadata`):

```typescript
import { createStreamStateMachine } from '@lostgradient/operative/streaming';

const machine = createStreamStateMachine();
const state = machine.process({ type: 'block-start', id: 'block-1', blockType: 'text' });
machine.process({ type: 'block-delta', id: 'block-1', delta: 'Hello' });
console.log(state.textContent);
```

**Exported types:** `StreamBlock`, `StreamCommand`, `StreamEvent`, `StreamEventMap`, `StreamState`, `StreamStateMachine`, `BlockType`, `EnhancedStreamingOptions`, `BackpressureBuffer`, `BackpressureBufferOptions`, `StreamCustomEvent`.

---

### `@lostgradient/operative/retry` — Retry Mutators

Transforms the generate context before each retry attempt—escalate temperature, drop bad tools, inject schema error feedback, or add jitter to delays.

```typescript
import {
  composeMutators,
  createTemperatureEscalationMutator,
  createSchemaErrorMutator,
  createToolRemovalMutator,
  createOverflowMutator,
  addJitter,
} from '@lostgradient/operative/retry';
import { createActiveRun, stopWhen } from '@lostgradient/operative';

// Increase by 0.2 per attempt (default), capped at 1.0
const escalate = createTemperatureEscalationMutator({
  increment: 0.2,
  max: 1.0,
});

// Re-inject a schema validation error as a user message
const schemaFeedback = createSchemaErrorMutator();

// Remove tools that caused errors on the previous attempt
const dropBadTools = createToolRemovalMutator();

// Handle context-window overflow by trimming early messages
const overflow = createOverflowMutator({
  summarize: async (messages) => `Summary of ${messages.length} trimmed messages.`,
  retainRecentMessages: 10,
});

// Compose into a single mutator
const mutator = composeMutators(escalate, schemaFeedback, dropBadTools, overflow);

const activeRun = createActiveRun({
  generate,
  toolbox,
  conversation,
  stopWhen: stopWhen.noToolCalls(),
  retry: {
    attempts: 3,
    // addJitter(delay, options) is a plain function, not a factory — apply it
    // inside your own delay function to jitter each computed backoff.
    delay: (attempt) => addJitter(1000 * attempt, { maxJitter: 200 }),
    mutate: mutator,
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

### `@lostgradient/operative/instrumentation` — OpenTelemetry

Attaches OpenTelemetry spans to an `ActiveRun`, mirroring the agent loop lifecycle as nested spans. Requires `@opentelemetry/api` (peer dependency, optional).

```typescript
import { instrument } from '@lostgradient/operative/instrumentation';
import { createActiveRun, stopWhen } from '@lostgradient/operative';
import { trace } from '@opentelemetry/api';

const activeRun = createActiveRun({
  generate,
  toolbox,
  conversation,
  stopWhen: stopWhen.noToolCalls(),
});

// Wire up OTel spans
const stopInstrumentation = instrument(activeRun, {
  tracer: trace.getTracer('my-app', '1.0.0'),
  // Or let instrument create a default tracer:
  // tracerName: 'operative',
  // tracerVersion: '0.0.0',
  agentName: 'Math Tutor', // optional — names the run span `invoke_agent Math Tutor`
});

await activeRun.result;
stopInstrumentation(); // Remove listeners and end any open spans
```

`instrument()` creates:

- `invoke_agent` (or `invoke_agent {agentName}`) span for the full run lifetime — the OTel GenAI "Invoke agent (internal)" span.
- `step` spans for each loop iteration, nested under the run span (`operative.step.index` carries the step number; the name is intentionally stable to avoid unbounded span-name cardinality).
- `generate` spans for each LLM call observed at the loop boundary, nested under their step.
- `tool_calls` spans grouping the tool calls issued in a step, nested under their step.

See [OTel GenAI Semantic Conventions](#otel-genai-semantic-conventions) below for the full attribute mapping and pinned conventions version.

**Exported:**

| Symbol                            | Description                                            |
| --------------------------------- | ------------------------------------------------------ |
| `instrument(activeRun, options?)` | Attach OTel spans; returns an unsubscribe function.    |
| `InstrumentationOptions`          | `{ tracer?, tracerName?, tracerVersion?, agentName? }` |

---

### `@lostgradient/operative/providers/instrumentation` — OpenTelemetry (Inference Calls)

Wraps a `GenerateFunction` with a single CLIENT span per call, following the OTel GenAI "Inference" (chat) span convention. Use this when you want the canonical, spec-compliant span for the actual LLM request — with model, provider, and token usage — as opposed to the loop-level `generate` span from `@lostgradient/operative/instrumentation`, which has no model/provider visibility.

```typescript
import { instrument } from '@lostgradient/operative/providers/instrumentation';
import { createAnthropicProvider } from '@lostgradient/operative/anthropic';
import { trace } from '@opentelemetry/api';

const rawGenerate = createAnthropicProvider({ model: 'claude-sonnet-5' });
const generate = instrument(rawGenerate, {
  provider: 'anthropic',
  model: 'claude-sonnet-5',
  tracer: trace.getTracer('my-app', '1.0.0'),
});
```

`instrument()` creates a `{operation} {model}` CLIENT span — `operation` is `chat` for turn-based chat completion providers (Anthropic, OpenAI, Voyage, Ollama) and `generate_content` for Gemini's native `generateContent` surface — with `gen_ai.operation.name`, `gen_ai.provider.name`, `gen_ai.request.model`, `gen_ai.request.max_tokens` (when supplied), and `gen_ai.usage.*` token attributes (including provider cache fields, when present).

**Exported:**

| Symbol                                  | Description                                                 |
| --------------------------------------- | ----------------------------------------------------------- |
| `instrument(generateFunction, options)` | Wrap a `GenerateFunction` with a CLIENT chat span.          |
| `InstrumentationOptions`                | `{ tracer?, tracerName?, tracerVersion? }`                  |
| `InstrumentableGenerateOptions`         | `{ provider: ProviderName, model: string, maximumTokens? }` |

---

### OTel GenAI Semantic Conventions

Spans and attributes across `@lostgradient/operative/instrumentation`, `@lostgradient/operative/providers/instrumentation`, and `armorer/instrumentation` follow the [OpenTelemetry GenAI semantic conventions](https://github.com/open-telemetry/semantic-conventions-genai) wherever a direct mapping exists. The conventions are still in **Development** status (no tagged release as of this writing) and can change — this table is pinned to:

- `open-telemetry/semantic-conventions-genai` commit [`63f8200`](https://github.com/open-telemetry/semantic-conventions-genai/commit/63f8200eee093730ce845d26ce2aafb621b0807e) (`docs/gen-ai/gen-ai-spans.md`, `docs/gen-ai/gen-ai-agent-spans.md`)
- general attributes (`error.*`, `server.*`) cross-referenced against semantic-conventions [v1.43.0](https://github.com/open-telemetry/semantic-conventions/tree/v1.43.0)

When the pinned spec revision changes, re-diff these two files against the new commit and update this table alongside the code.

| Our span (package)                                                                       | OTel GenAI span                                | Span name                         | Kind     | Key attributes                                                                                                                                                                    | Divergence                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------- | --------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invoke_agent` (`@lostgradient/operative/instrumentation`)                               | Invoke agent (internal)                        | `invoke_agent [{agentName}]`      | INTERNAL | `gen_ai.operation.name=invoke_agent`, `gen_ai.agent.name`, `gen_ai.usage.*`                                                                                                       | `operative.finish_reason`/`operative.total_steps`/`operative.abort_reason` are documented custom extensions. `event.finishReason` (`stop-condition`, `maximum-steps`, `budget-exceeded`, `aborted`, ...) is intentionally kept OFF `gen_ai.response.finish_reasons` — it is operative's own agent-loop control-flow reason, not a provider-reported model completion reason, and mapping it there would mislead OTel GenAI backends that expect well-known provider stop reasons. |
| `step` (`@lostgradient/operative/instrumentation`)                                       | _(none)_                                       | `step`                            | INTERNAL | `operative.step.index`                                                                                                                                                            | **Divergent.** No spec equivalent for a single loop iteration. Kept as a non-normative structural span; name held constant (not `step {n}`) to avoid unbounded span-name cardinality.                                                                                                                                                                                                                                                                                             |
| `generate` (`@lostgradient/operative/instrumentation`)                                   | _(none — see `providers/instrumentation` row)_ | `generate`                        | INTERNAL | `operative.usage.*`, `operative.generate.duration_ms`                                                                                                                             | **Divergent, intentionally.** Observes the loop's call boundary without model/provider visibility. NOT labeled `gen_ai.operation.name=chat` and usage is namespaced under `operative.*` (not `gen_ai.*`) so it never double-reports usage against the canonical chat span below when both instrumentation points are wired to the same call.                                                                                                                                      |
| `tool_calls` (`@lostgradient/operative/instrumentation`)                                 | _(none)_                                       | `tool_calls`                      | INTERNAL | `operative.tools.count`, `operative.tools.names`, `operative.tools.results_count`                                                                                                 | **Divergent.** The spec defines a per-call `execute_tool` span (see below), not a batch wrapper for the calls issued in one step.                                                                                                                                                                                                                                                                                                                                                 |
| `{chat\|generate_content} {model}` (`@lostgradient/operative/providers/instrumentation`) | Inference                                      | `{gen_ai.operation.name} {model}` | CLIENT   | `gen_ai.operation.name` (`chat`, or `generate_content` for Gemini), `gen_ai.provider.name`, `gen_ai.request.model`, `gen_ai.request.max_tokens`, `gen_ai.usage.*`                 | None — full compliance. This is the canonical span for a single LLM inference call.                                                                                                                                                                                                                                                                                                                                                                                               |
| `execute_tool {name}` (`armorer/instrumentation`)                                        | Execute tool                                   | `execute_tool {gen_ai.tool.name}` | INTERNAL | `gen_ai.operation.name=execute_tool`, `gen_ai.tool.name`, `gen_ai.tool.call.id`, `gen_ai.tool.call.arguments`, `gen_ai.tool.call.result`, `gen_ai.tool.description`, `error.type` | None — full compliance. `armorer.tool.*` carries duration/digest/status extensions the spec doesn't define.                                                                                                                                                                                                                                                                                                                                                                       |

`gen_ai.provider.name` values are mapped from operative's internal `ProviderName` to the conventions' well-known values where one is registered:

| `ProviderName` | `gen_ai.provider.name` | Note                                                                                                                                                                                                 |
| -------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `anthropic`    | `anthropic`            | Well-known value.                                                                                                                                                                                    |
| `openai`       | `openai`               | Well-known value.                                                                                                                                                                                    |
| `gemini`       | `gcp.gemini`           | operative's `gemini` provider talks to the AI Studio endpoint (`generativelanguage.googleapis.com`) via `@google/generative-ai`, which the conventions register as `gcp.gemini` (not bare `gemini`). |
| `voyage`       | `voyage`               | No well-known value registered — a custom value, as explicitly permitted by the conventions.                                                                                                         |
| `ollama`       | `ollama`               | No well-known value registered — a custom value, as explicitly permitted by the conventions.                                                                                                         |

`total_tokens` is intentionally not emitted as a `gen_ai.usage.*` attribute anywhere — it isn't a defined attribute in the conventions, and any GenAI-aware backend already sums `input_tokens` + `output_tokens` itself.

---

### `@lostgradient/operative/durable` — Durable Runs

Drives agent runs through the Weft durable execution engine—checkpointed, crash-recoverable, and resumable. The `ActiveRun` surface is identical to the in-memory path; only the second argument to `createActiveRun()` changes.

```typescript
import { createActiveRun } from '@lostgradient/operative';
import type { DurableRunRouting } from '@lostgradient/operative';
import {
  createCheckpointStore,
  createRunEngine,
  createRunWorkflow,
} from '@lostgradient/operative/durable';

// Build the durable substrate once at startup. createRunEngine returns
// { engine, checkpointStore } — `storage` is Weft's raw Storage backend;
// `checkpointStore` wraps a TextValueStore over that same backend.
const checkpointStore = createCheckpointStore(kvStore);
const runWorkflow = createRunWorkflow(checkpointStore);
const { engine } = await createRunEngine({ storage: rawStorage, runWorkflow, checkpointStore });

// Start a new durable run — survives crashes and resumes automatically
const durable: DurableRunRouting = {
  engine,
  checkpointStore,
  runId: 'run-2024-001',
  prompt: 'Summarize the annual report.',
};

const activeRun = createActiveRun({ generate, toolbox, conversation }, durable);
const result = await activeRun.result;
```

> [!NOTE] Reattaching after a restart
> `reattachDurableActiveRun` wraps a handle already returned by `engine.recoverAll()` — it does not take a `sessionId`/`options` bag. `createRunEngine`'s default `recover: true` runs recovery during construction and does not surface the handles, so observing a recovered run as a live `ActiveRun` requires `recover: false` plus calling `engine.recoverAll()` yourself and reattaching each returned handle. See `reattachDurableActiveRun`'s own JSDoc and `bureau`'s `create-bureau.ts` (`reattachRecoveredRun`) for the full recovery-driven flow.

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

### `@lostgradient/operative/test` — Test Utilities

Test helpers for the agent loop. Import in test files only.

```typescript
import {
  createMockGenerate,
  createMockGenerateOnce,
  createRunRecorder,
  createMockScratchpad,
  createMockRegistryAgent,
  createMockAgentRegistry,
  createTestStore,
} from '@lostgradient/operative/test';
import type { RunRecorder } from '@lostgradient/operative/test';
import { createActiveRun, stopWhen } from '@lostgradient/operative';

// Replay pre-canned responses in sequence
const generate = createMockGenerate([
  { content: 'Step 1 response', toolCalls: [] },
  { content: 'Step 2 response', toolCalls: [], usage: { prompt: 5, completion: 8, total: 13 } },
]);

const activeRun = createActiveRun({
  generate,
  toolbox,
  conversation,
  stopWhen: stopWhen.noToolCalls(),
});

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

// Mock RegistryAgent for createSupervisor / createAgentRegistry consumer tests
const mockAgent = createMockRegistryAgent('test-agent', {
  run: async () => 'custom',
});
```

**Exported:**

| Symbol                                      | Description                                                                                    |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `createMockGenerate(responses)`             | Replays `GenerateResponse[]` in sequence; exposes `.calls` and `.callCount`.                   |
| `createMockGenerateOnce(response)`          | Returns response once; throws on subsequent calls.                                             |
| `createRunRecorder(activeRun)`              | Records all events from an `ActiveRun` for assertion. Exposes `.events`, `.steps`, `.clear()`. |
| `createMockScratchpad(initialValues?)`      | In-memory `Scratchpad` for testing scratchpad-dependent agents.                                |
| `createMockRegistryAgent(name, overrides?)` | Minimal `RegistryAgent` with a stub `run`, for `createSupervisor`/registry consumer tests.     |
| `createMockAgentRegistry(entries?)`         | Pre-populated `AgentRegistry` for registry consumer tests.                                     |
| `createTestStore()`                         | In-memory `Store` instance from `@lostgradient/operative/store`.                               |

| `RunRecorder`

---

## Development

Run package checks from this directory:

```bash
bun run validate
bun run build
```
