# Bureau

`bureau` is the fleet composition layer for Agent Bureau. `createBureau()` assembles providers, tools, memory, skills, session persistence, durable execution, guardrails, and multi-agent behavior from one configuration surface, and exposes the resulting runtime through a single `Bureau` object.

## Table of Contents

- [Overview](#overview)
- [What It Does](#what-it-does)
- [How It Works](#how-it-works)
- [Project Role](#project-role)
- [Quick Start](#quick-start)
- [Public API](#public-api)
  - [`createBureau(options)`](#createbureauoptions)
  - [`BureauOptions`](#bureauoptions)
  - [The `Bureau` Object](#the-bureau-object)
  - [`streamEventToFrame`](#streameventtoframe)
  - [The Audit Trail](#the-audit-trail)
- [`AgentDefinitions` and the Agent Catalog](#agentdefinitions-and-the-agent-catalog)
  - [`createSupervisor` and `createAgentDiscoveryTool`](#createsupervisor-and-createagentdiscoverytool)
- [`bureau/test`](#bureautest)
- [Development](#development)

## Overview

Everything else in the workspace is a library: `operative` runs one agent loop, `armorer` executes tools, `memory` recalls facts, `skills` catalogs procedures. `bureau` is where those libraries become a fleet — a runtime that can create runs, resume them across a crash, hold live sessions, run scheduled and durable schedules, and route requests to more than one named agent.

`gateway` is the only consumer that turns `bureau`'s runtime into an HTTP/browser product, but `createBureau()` itself has no HTTP dependency — it is usable directly from any Bun/Node process.

## What It Does

- Composes a runtime from `BureauOptions`: a single provider, a fallover/routing provider set, tools, memory, skills, session persistence, durable execution, guardrails, cache, identity, and scheduler configuration.
- Creates and tracks runs (`createRun`), aborts and deletes them, and lists them by status.
- Persists sessions through a `SessionStore` and recovers in-flight durable runs after a process restart (`engine.recoverAll()`), reattaching bureau-owned runs and monitoring native scheduled fires.
- Exposes durable primitives when a durable engine is composed: `signalSession`, `updateSession`, `querySession`, and full CRUD over durable schedules (`createSchedule`, `getSchedule`, `listSchedules`, `pauseSchedule`, `resumeSchedule`, `cancelSchedule`).
- Emits a typed event surface (`BureauEventMap`) and live WebSocket/SSE-ready frames (`ServerFrame`) via `subscribeLiveFrames` and `streamEventToFrame`.
- Records a durable, append-only audit trail of tool, run, and step lifecycle events when persistence is configured.
- Exposes a typed `AgentDefinitions` catalog (`bureau.agents`) and a synchronous `bureau.run(name, input, options?)` for dispatching to a statically named agent, alongside the session/durability-backed `createRun`.

## How It Works

`createBureau(options)` is async because composing the runtime may involve resolving a Weft storage backend, building a durable engine, and loading a session store. The returned `Bureau` object wraps an `@lostgradient/operative/store` `Store` (the live run/action registry), an optional `Memory`, an optional `Scheduler`, and the resolved runtime composition (generate function, toolbox, session store, durable engine).

`createRun(request)` loads or creates a session, appends the request message to its conversation, builds an `ActiveRun` via `operative`'s `createActiveRun`, and registers it with the store. If a durable engine is composed, the run is routed through it instead of the in-memory loop, so it can crash and resume from its last completed step. Terminal run events (`run.completed`, `run.aborted`) persist the session's status with a bounded retry.

On boot, if durable execution is configured, `bureau` sweeps suspended scheduler-origin residue and calls `engine.recoverAll()`. Each recovered handle is classified — `reattach` (a bureau-owned, in-flight, session-confirmed run becomes a live `ActiveRun` again), `monitor` (a native scheduled fire gets a detached result monitor but no live run surface), `cancel` (a positively unowned or unidentifiable run is terminalized), or `skip` (ownership can't be confirmed, so recovery leaves it alone rather than risk cancelling a legitimate resume).

## Project Role

`bureau` sits directly below `gateway` in the dependency graph and directly above `operative`, `armorer`, `conversationalist`, `memory`, and `skills`. It depends on all five and composes them; nothing below it depends on `bureau`. `gateway` calls `createBureau()` once per server instance and layers HTTP routes, a browser UI, and live transport on top of the object it returns.

## Quick Start

```typescript
import { createBureau } from 'bureau';

const bureau = await createBureau({
  agents: {},
  provider: { provider: 'anthropic', model: 'claude-sonnet-4.5' },
  storage: { type: 'sqlite', path: 'agent-bureau.sqlite' },
});

const run = await bureau.createRun({ message: 'Summarize the Q3 report.' });
console.log(run.status); // "running"

// Wait for completion via the live event surface.
await new Promise<void>((resolve) => {
  bureau.once('action', (event) => {
    if (event.action.runId === run.id && event.action.type === 'run.completed') {
      resolve();
    }
  });
});

const detail = bureau.getRun(run.id);
console.log(detail?.finishReason); // "stop-condition" | "maximum-steps" | …

await bureau.dispose();
```

Without `storage`, runs are ephemeral: nothing is persisted, and a crash loses in-flight work. Pass a `sqlite` or `lmdb` `storage` configuration to get session persistence and, by default, durable crash-and-resume execution.

## Public API

### `createBureau(options)`

```typescript
function createBureau<const D extends AgentDefinitions = AgentDefinitions>(
  options: BureauOptions<D>,
): Promise<Bureau<D>>;
```

Composes and returns a `Bureau`. `agents` is the only required field — pass `{}` for a bureau that only uses the session/durability-backed `createRun` surface below and doesn't dispatch through the typed catalog at all. Without a `generate`/`provider`/`providers` + `routing`, the result has no generate function configured (`bureau.ready === false`) and `createRun` throws `BureauError('NOT_CONFIGURED')` until one is provided.

### `BureauOptions`

Every field except `agents` is optional.

| Field                                                                  | Type                                                                                                  | Purpose                                                                                                                                                                                |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agents`                                                               | `AgentDefinitions` (`D`)                                                                              | **Required.** The typed agent catalog, exposed as `bureau.agents` and dispatched by name through `bureau.run`. Pass `{}` for a bureau that doesn't use it.                             |
| `generate`                                                             | `GenerateFunction`                                                                                    | Escape hatch: supply your own generate function directly, bypassing provider resolution entirely.                                                                                      |
| `provider`                                                             | `ProviderConfiguration`                                                                               | Resolve a single provider (`'anthropic' \| 'openai' \| 'gemini'`) to a generate function.                                                                                              |
| `providers` / `routing`                                                | `ProviderRouteConfiguration[]` / `RoutingConfiguration`                                               | Resolve multiple named providers with fallover or step-based routing between them.                                                                                                     |
| `toolbox`                                                              | `Toolbox`                                                                                             | The bureau-level toolbox available to every run.                                                                                                                                       |
| `store`                                                                | `Store`                                                                                               | Supply your own `@lostgradient/operative/store` `Store` instead of letting `bureau` create one.                                                                                        |
| `persistence` / `storage`                                              | `PersistenceOptions \| StorageConfiguration \| ConditionalTextValueStore`                             | Configure session and key-value persistence. `storage` is shorthand for the common case; `persistence` is the full options-object form.                                                |
| `durableExecution`                                                     | `boolean`                                                                                             | Override the default (on for persistent `storage`, off for `memory`) for Weft-backed crash-and-resume execution.                                                                       |
| `memory`                                                               | `CreateMemoryOptions \| Memory`                                                                       | Attach recall/persistence hooks backed by the `memory` package.                                                                                                                        |
| `cache`                                                                | `CacheConfiguration`                                                                                  | Wrap the resolved generate function with response caching.                                                                                                                             |
| `guardrails`                                                           | `GuardrailsOptions`                                                                                   | Attach `operative` guardrail detectors to every run.                                                                                                                                   |
| `identity`                                                             | `IdentityConfiguration`                                                                               | Configure identity resolution for memory and session ownership.                                                                                                                        |
| `skills`                                                               | `SkillRuntimeConfiguration`                                                                           | Attach a skill catalog; injects an `<available_skills>` system block on step 0 of every run.                                                                                           |
| `streaming`                                                            | `StreamingConfiguration`                                                                              | Enable enhanced streaming and expose a `streamEventTarget` on run runtime.                                                                                                             |
| `scheduler`                                                            | `SchedulerConfiguration`                                                                              | Attach an in-process priority scheduler (`submitSchedulerTask`).                                                                                                                       |
| `stopWhen`                                                             | `StopCondition \| StopCondition[]`                                                                    | Default stop condition(s) applied to every run.                                                                                                                                        |
| `maximumSteps` / `systemPrompt`                                        | `number` / `string`                                                                                   | Default step cap and system prompt for runs that don't specify their own.                                                                                                              |
| `observability`                                                        | `boolean \| Omit<ObservabilityOptions, 'eventTarget'>`                                                | Opt into OpenTelemetry spans/metrics for durable runs. No-op without `@opentelemetry/api` installed.                                                                                   |
| `onLog`                                                                | `(record: WorkflowLogRecord) => void`                                                                 | Sink for `ctx.log` records emitted by durable workflows.                                                                                                                               |
| `onDiagnostic`                                                         | `(diagnostic: BureauDiagnostic) => void`                                                              | Sink for bureau's own operational diagnostics — recovery failures, live-frame listener exceptions, dispose errors, persistence failures. Omit to log to the console exactly as before. |
| `durableGuardrails`                                                    | `DurableGuardrailsConfiguration`                                                                      | History/checkpoint guardrails (max events, checkpoint size warnings) for durable runs.                                                                                                 |
| `durableOwnership`                                                     | `Pick<CreateRunEngineOptions, 'ownership' \| 'workflowClaimTtlMs' \| 'workflowClaimRenewIntervalMs'>` | Multi-process ownership posture (AB-178). Omit for the default `'none'` — unchanged, one bureau process per store. See the caveat below before passing `'workflow-lease'`.             |
| `sessionPersistenceRetryDelayMilliseconds` / `sessionPersistenceSleep` | `number` / `(ms: number) => Promise<void>`                                                            | Tune the bounded retry used when persisting terminal session state.                                                                                                                    |

`durableExecution: true` cannot be combined with a custom `persistence` value — `persistence` shadows `storage`, and the durable engine needs a raw `Storage` backend to checkpoint against. Provide `storage` without `persistence` for durable runs.

> [!WARNING] `durableOwnership: { ownership: 'workflow-lease' }` and scheduler preemption
> Do not enable `'workflow-lease'` if you rely on the `scheduler` option's preemption behavior — a background task that gets suspended and later resumed. A reproduced weft 0.23.1 defect makes `'workflow-lease'` incompatible with same-engine `engine.suspend()`/`engine.resume()`, which Bureau's scheduler uses internally for that exact suspend-and-resume flow. Enabling it on a bureau that also configures `scheduler` can cause a preempted background task to fail on resume instead of continuing. See `CreateRunEngineOptions.ownership`'s JSDoc in `@lostgradient/operative/durable` for the full repro and root cause.

`onLog` and `onDiagnostic` cover different sources: `onLog` carries only `ctx.log` records emitted _by durable workflow code itself_, while `onDiagnostic` carries bureau's own operational diagnostics — the sites that write to `console.error`/`console.warn` today (recovery failures, live-frame listener exceptions, dispose errors, persistence failures). Route `onDiagnostic` into a structured logger to capture those without monkeypatching `console`:

```ts
import pino from 'pino';

const logger = pino();

const bureau = await createBureau({
  agents: {},
  onDiagnostic: ({ level, scope, message, cause }) => logger[level]({ scope, cause }, message),
});
```

### The `Bureau` Object

The most commonly used members:

| Member                                                                                                                                          | Returns                                                                                                  | Purpose                                                                                                                      |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `agents`                                                                                                                                        | `BureauAgentCatalog<D>`                                                                                  | The typed, read-only agent catalog. See [`AgentDefinitions` and the Agent Catalog](#agentdefinitions-and-the-agent-catalog). |
| `run(name, input, options?)`                                                                                                                    | `AgentRun<...>`                                                                                          | Synchronous dispatch to a named catalog agent.                                                                               |
| `createRun(request)`                                                                                                                            | `Promise<RunSummary>`                                                                                    | Create and start a run against a session.                                                                                    |
| `submitSchedulerTask(request)`                                                                                                                  | `Promise<SubmitSchedulerTaskResponse>`                                                                   | Queue a task on the in-process scheduler.                                                                                    |
| `listRuns(status?)`                                                                                                                             | `RunSummary[]`                                                                                           | List tracked runs, optionally filtered by status.                                                                            |
| `getRun(id)` / `abortRun(id)` / `deleteRun(id)`                                                                                                 | `RunDetail \| undefined` / `RunSummary` / `void`                                                         | Read, abort, or remove a tracked run.                                                                                        |
| `getDurableRun(runId)` / `listDurableRuns(...)`                                                                                                 | `Promise<WorkflowState \| null \| undefined>` / `Promise<PaginatedResult<WorkflowSummary> \| undefined>` | Read the durable engine's own view of a run. `undefined` without a durable engine.                                           |
| `listSessions()` / `getSession(id)` / `deleteSession(id)`                                                                                       | `Promise<SessionSummary[]>` / `Promise<AgentSession \| undefined>` / `Promise<void>`                     | Session CRUD through the configured `SessionStore`.                                                                          |
| `signalSession(id, name, payload?)`                                                                                                             | `Promise<void>`                                                                                          | Fire-and-forget signal to a session's in-flight durable run.                                                                 |
| `updateSession(id, name, payload?)`                                                                                                             | `Promise<unknown>`                                                                                       | Validated request/response update to a session's in-flight run.                                                              |
| `querySession(id, name, input?)`                                                                                                                | `Promise<unknown>`                                                                                       | Read live state from a session's in-flight run without mutating it.                                                          |
| `createSchedule(definition)` / `getSchedule(id)` / `listSchedules(filter?)` / `pauseSchedule(id)` / `resumeSchedule(id)` / `cancelSchedule(id)` | various                                                                                                  | Durable recurring schedule CRUD, backed by the Weft engine.                                                                  |
| `getConfiguration()` / `getTools()`                                                                                                             | `ConfigurationResponse` / `ToolSummary[]`                                                                | Introspect the resolved provider/tool configuration.                                                                         |
| `subscribeLiveFrames(listener)`                                                                                                                 | `() => void`                                                                                             | Subscribe to every `ServerFrame` the bureau emits; returns an unsubscribe function.                                          |
| `addEventListener` / `on` / `once` / `subscribe` / `toObservable` / `events`                                                                    | —                                                                                                        | The full `lifecycle`-style event surface over `BureauEventMap`.                                                              |
| `ready`                                                                                                                                         | `boolean`                                                                                                | Whether a generate function is configured.                                                                                   |
| `sessionStore` / `kv` / `auditTrail`                                                                                                            | `SessionStore \| undefined` / `ConditionalTextValueStore \| undefined` / `AuditTrail \| undefined`       | The underlying persistence handles, when configured.                                                                         |
| `dispose()`                                                                                                                                     | `void`                                                                                                   | Tear down subscriptions and close owned storage handles.                                                                     |

`bureau.dispose()` is safe to call more than once; it no-ops after the first call.

### `streamEventToFrame`

```typescript
function streamEventToFrame(runId: string, event: StreamEvent): ServerFrame | undefined;
```

Converts an `operative` `StreamEvent` (`stream:text-delta`, `stream:tool-call-start`, `stream:tool-call-delta`, `stream:tool-call-complete`, `stream:complete`, `stream:error`) into the matching typed `ServerFrame`, stamped with the owning `runId`. Returns `undefined` for event types with no frame equivalent. `bureau` uses this internally to translate a run's `streaming` output into the frames delivered by `subscribeLiveFrames`; a WebSocket or SSE transport layer (like `gateway`'s) can use it the same way.

### The Audit Trail

```typescript
import { createAuditTrail } from 'bureau';

const trail = createAuditTrail(bureau, kv);
const records = await trail.query({ runId, since: Date.now() - 3_600_000, limit: 100 });
trail.dispose();
```

`createBureau()` builds an audit trail automatically whenever persistence is configured — it's exposed as `bureau.auditTrail`. It listens to the bureau's `action` events and, for a fixed set of event types (`tool.started`, `tool.settled`, `tool.error`, `run.completed`, `run.error`, `run.aborted`, `step.completed` — see `AUDIT_EVENT_TYPES`), writes an append-only `AuditRecord` into the key-value store under an `audit:v1:` prefix, key-encoded so natural sort order is chronological.

This is a second, durable layer alongside the in-memory `@lostgradient/operative/store` ring buffer (which is bounded by `maxActions` and lost on restart): the operative store is the live/glass-box view, the audit trail is the durable/queryable one. `trail.query(options)` filters by `since`, `runId`, and `type`, returning up to `limit` records (default 500) oldest-first. Without a `kv` store, the trail still subscribes (so `dispose()` is always safe) but writes nothing.

## `AgentDefinitions` and the Agent Catalog

`AgentDefinitions` (AB-15, AB-22) is a plain literal object — the `agents` map passed to `createBureau({ agents })` — of agent name to `RunnableAgent` (an `@lostgradient/operative` `createAgent()` or `createLazyAgent()` result). There is no register/unregister lifecycle: the map is fixed for the bureau's lifetime. `bureau.agents` exposes an immutable, read-only `BureauAgentCatalog` view over it (`get`/`find`/`has`/`names`/`entries`/`query`), and `bureau.run(name, input, options?)` dispatches to a named entry synchronously — like `RunnableAgent.run`, it returns the `AgentRun` handle immediately, never `Promise<AgentRun>`.

```typescript
import { createAgent } from '@lostgradient/operative';
import { createBureau } from 'bureau';

const bureau = await createBureau({
  agents: {
    researcher: createAgent({ generate, instructions: 'You are a research assistant.' }),
    writer: createAgent({ generate }),
  },
});

bureau.agents.has('researcher'); // narrows to a known agent name where TypeScript permits it
bureau.agents.names(); // ['researcher', 'writer'] — definition order

const run = bureau.run('researcher', 'Summarize the Q3 report.');
for await (const event of run) {
  // ...
}
const result = await run.result();
```

`run`'s synchronous throws are limited to an unknown `name`, a disposed bureau, and malformed `input`/`options`; everything else (session, provider, tool, policy, or abort failures) settles through the returned `AgentRun` handle. `BureauRunOptions` (`sessionId?`, `signal?`, `traceContext?`, `withTraceContext?`, `principal?`) carries only call-scoped concerns — there is no per-call `systemPrompt`/`maximumSteps`/`maximumTokens` override; anything that shapes how an agent runs is fixed on its own definition (`createAgent({ instructions, maximumSteps, ... })`). `sessionId` correlates a durable dispatch to the engine's own session/recovery bookkeeping (a no-op when the run is dispatched in-memory); `principal` is not yet honored at all — a bare `RunnableAgent.run()` has no attribution surface to record it against — and `bureau.run()` throws synchronously if it is supplied.

`run` is independent of, and additive to, `createRun` below: `run` dispatches to a catalog `RunnableAgent` (agent-owned generate/tools/durability by construction), while `createRun` keeps driving bureau-level `generate`/`provider` through the session/durable-execution machinery documented above. A bureau may use either, both, or neither — pass `agents: {}` for a bureau that only uses `createRun`. When a durable engine is composed (a persistent `storage` backend, or `durableExecution: true`) and the named agent supports AB-21's definition-resolution capability (every `createAgent`/`createLazyAgent` result does), `run` drives the dispatch through that same durable engine so it survives a crash and resumes; otherwise the agent's own in-memory `run()` is used directly.

### `createSupervisor` and `createAgentDiscoveryTool`

Both moved here from `operative` (AB-22), rebuilt against `BureauAgentCatalog<D>` in place of the deleted `AgentRegistry`.

```typescript
import { createAgentDiscoveryTool, createFanOutRouting, createSupervisor } from 'bureau';

const supervisor = createSupervisor({
  agents: bureau.agents,
  routing: createFanOutRouting(), // or a custom `RoutingStrategy<D>`
});

const { agentResults, synthesis } = await supervisor.delegate('Draft a Q3 summary.');

const discoveryTool = createAgentDiscoveryTool(bureau.agents);
```

`createSupervisor` delegates a task to one or more catalog agents chosen by a pluggable `RoutingStrategy<D>` (`(task, descriptors) => name | name[] | Promise<...>`; built-ins `createRoundRobinRouting`/`createFanOutRouting` only load the agents they actually select) and synthesizes their results — `delegate` (one task), `delegateAll` (many, sequential or parallel), and `pipeline` (chain each stage's output into the next stage's input). `createAgentDiscoveryTool` exposes a tool an orchestrating agent can call to search catalog agent names (case-insensitive substring match) — metadata only, since `RunnableAgent` carries no description/capabilities/tags to search beyond its name.

## `bureau/test`

```typescript
import { createBureau, waitForCondition, waitForRunState } from 'bureau/test';
```

Re-exports `createBureau` (identical to the top-level export — useful when a test file already imports other test utilities from this subpath) alongside `@lostgradient/operative/test`'s `waitForCondition` and `waitForRunState`, which poll a run/condition without a fixed sleep.

## Development

Run package checks from this directory:

```bash
bun run validate
bun run build
```
