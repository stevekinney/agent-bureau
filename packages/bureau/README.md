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
- [`bureau/builder` — the Typed Fleet Builder](#bureaubuilder--the-typed-fleet-builder)
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
- Provides a separate typed builder API (`bureau/builder`) for statically registering named agents and running them without the session/durability machinery.

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
function createBureau(options?: BureauOptions): Promise<Bureau>;
```

Composes and returns a `Bureau`. Safe to call with no options — the result has no generate function configured (`bureau.ready === false`) and `createRun` throws `BureauError('NOT_CONFIGURED')` until one is provided via `generate`, `provider`, or `providers` + `routing`.

### `BureauOptions`

All fields are optional.

| Field                                                                  | Type                                                                      | Purpose                                                                                                                                                                                |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `generate`                                                             | `GenerateFunction`                                                        | Escape hatch: supply your own generate function directly, bypassing provider resolution entirely.                                                                                      |
| `provider`                                                             | `ProviderConfiguration`                                                   | Resolve a single provider (`'anthropic' \| 'openai' \| 'gemini'`) to a generate function.                                                                                              |
| `providers` / `routing`                                                | `ProviderRouteConfiguration[]` / `RoutingConfiguration`                   | Resolve multiple named providers with fallover or step-based routing between them.                                                                                                     |
| `toolbox`                                                              | `Toolbox`                                                                 | The bureau-level toolbox available to every run.                                                                                                                                       |
| `store`                                                                | `Store`                                                                   | Supply your own `@lostgradient/operative/store` `Store` instead of letting `bureau` create one.                                                                                        |
| `persistence` / `storage`                                              | `PersistenceOptions \| StorageConfiguration \| ConditionalTextValueStore` | Configure session and key-value persistence. `storage` is shorthand for the common case; `persistence` is the full options-object form.                                                |
| `durableExecution`                                                     | `boolean`                                                                 | Override the default (on for persistent `storage`, off for `memory`) for Weft-backed crash-and-resume execution.                                                                       |
| `memory`                                                               | `CreateMemoryOptions \| Memory`                                           | Attach recall/persistence hooks backed by the `memory` package.                                                                                                                        |
| `cache`                                                                | `CacheConfiguration`                                                      | Wrap the resolved generate function with response caching.                                                                                                                             |
| `guardrails`                                                           | `GuardrailsOptions`                                                       | Attach `operative` guardrail detectors to every run.                                                                                                                                   |
| `identity`                                                             | `IdentityConfiguration`                                                   | Configure identity resolution for memory and session ownership.                                                                                                                        |
| `skills`                                                               | `SkillRuntimeConfiguration`                                               | Attach a skill catalog; injects an `<available_skills>` system block on step 0 of every run.                                                                                           |
| `streaming`                                                            | `StreamingConfiguration`                                                  | Enable enhanced streaming and expose a `streamEventTarget` on run runtime.                                                                                                             |
| `scheduler`                                                            | `SchedulerConfiguration`                                                  | Attach an in-process priority scheduler (`submitSchedulerTask`).                                                                                                                       |
| `stopWhen`                                                             | `StopCondition \| StopCondition[]`                                        | Default stop condition(s) applied to every run.                                                                                                                                        |
| `maximumSteps` / `systemPrompt`                                        | `number` / `string`                                                       | Default step cap and system prompt for runs that don't specify their own.                                                                                                              |
| `observability`                                                        | `boolean \| Omit<ObservabilityOptions, 'eventTarget'>`                    | Opt into OpenTelemetry spans/metrics for durable runs. No-op without `@opentelemetry/api` installed.                                                                                   |
| `onLog`                                                                | `(record: WorkflowLogRecord) => void`                                     | Sink for `ctx.log` records emitted by durable workflows.                                                                                                                               |
| `onDiagnostic`                                                         | `(diagnostic: BureauDiagnostic) => void`                                  | Sink for bureau's own operational diagnostics — recovery failures, live-frame listener exceptions, dispose errors, persistence failures. Omit to log to the console exactly as before. |
| `durableGuardrails`                                                    | `DurableGuardrailsConfiguration`                                          | History/checkpoint guardrails (max events, checkpoint size warnings) for durable runs.                                                                                                 |
| `sessionPersistenceRetryDelayMilliseconds` / `sessionPersistenceSleep` | `number` / `(ms: number) => Promise<void>`                                | Tune the bounded retry used when persisting terminal session state.                                                                                                                    |

`durableExecution: true` cannot be combined with a custom `persistence` value — `persistence` shadows `storage`, and the durable engine needs a raw `Storage` backend to checkpoint against. Provide `storage` without `persistence` for durable runs.

`onLog` and `onDiagnostic` cover different sources: `onLog` carries only `ctx.log` records emitted _by durable workflow code itself_, while `onDiagnostic` carries bureau's own operational diagnostics — the sites that write to `console.error`/`console.warn` today (recovery failures, live-frame listener exceptions, dispose errors, persistence failures). Route `onDiagnostic` into a structured logger to capture those without monkeypatching `console`:

```ts
import pino from 'pino';

const logger = pino();

const bureau = await createBureau({
  onDiagnostic: ({ level, scope, message, cause }) => logger[level]({ scope, cause }, message),
});
```

### The `Bureau` Object

The most commonly used members:

| Member                                                                                                                                          | Returns                                                                                                  | Purpose                                                                             |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `createRun(request)`                                                                                                                            | `Promise<RunSummary>`                                                                                    | Create and start a run against a session.                                           |
| `submitSchedulerTask(request)`                                                                                                                  | `Promise<SubmitSchedulerTaskResponse>`                                                                   | Queue a task on the in-process scheduler.                                           |
| `listRuns(status?)`                                                                                                                             | `RunSummary[]`                                                                                           | List tracked runs, optionally filtered by status.                                   |
| `getRun(id)` / `abortRun(id)` / `deleteRun(id)`                                                                                                 | `RunDetail \| undefined` / `RunSummary` / `void`                                                         | Read, abort, or remove a tracked run.                                               |
| `getDurableRun(runId)` / `listDurableRuns(...)`                                                                                                 | `Promise<WorkflowState \| null \| undefined>` / `Promise<PaginatedResult<WorkflowSummary> \| undefined>` | Read the durable engine's own view of a run. `undefined` without a durable engine.  |
| `listSessions()` / `getSession(id)` / `deleteSession(id)`                                                                                       | `Promise<SessionSummary[]>` / `Promise<AgentSession \| undefined>` / `Promise<void>`                     | Session CRUD through the configured `SessionStore`.                                 |
| `signalSession(id, name, payload?)`                                                                                                             | `Promise<void>`                                                                                          | Fire-and-forget signal to a session's in-flight durable run.                        |
| `updateSession(id, name, payload?)`                                                                                                             | `Promise<unknown>`                                                                                       | Validated request/response update to a session's in-flight run.                     |
| `querySession(id, name, input?)`                                                                                                                | `Promise<unknown>`                                                                                       | Read live state from a session's in-flight run without mutating it.                 |
| `createSchedule(definition)` / `getSchedule(id)` / `listSchedules(filter?)` / `pauseSchedule(id)` / `resumeSchedule(id)` / `cancelSchedule(id)` | various                                                                                                  | Durable recurring schedule CRUD, backed by the Weft engine.                         |
| `getConfiguration()` / `getTools()`                                                                                                             | `ConfigurationResponse` / `ToolSummary[]`                                                                | Introspect the resolved provider/tool configuration.                                |
| `subscribeLiveFrames(listener)`                                                                                                                 | `() => void`                                                                                             | Subscribe to every `ServerFrame` the bureau emits; returns an unsubscribe function. |
| `addEventListener` / `on` / `once` / `subscribe` / `toObservable` / `events`                                                                    | —                                                                                                        | The full `lifecycle`-style event surface over `BureauEventMap`.                     |
| `ready`                                                                                                                                         | `boolean`                                                                                                | Whether a generate function is configured.                                          |
| `sessionStore` / `kv` / `auditTrail`                                                                                                            | `SessionStore \| undefined` / `ConditionalTextValueStore \| undefined` / `AuditTrail \| undefined`       | The underlying persistence handles, when configured.                                |
| `dispose()`                                                                                                                                     | `void`                                                                                                   | Tear down subscriptions and close owned storage handles.                            |

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

## `bureau/builder` — the Typed Fleet Builder

`bureau/builder` exports a second `createBureau()` — a synchronous, typed registry/table API for statically declaring a small set of named agents and running them without session persistence, durable execution, or a `Store`. It's a lighter-weight alternative to the main `createBureau()` for callers who just want to route a request to one of a few known agents.

```typescript
import { createBureau } from 'bureau/builder';

const bureau = createBureau({
  agents: {
    researcher: { instructions: 'You are a research assistant.' },
    writer: {},
  },
});

// Tier 2 — chained accretion; the return MUST be captured to widen the type.
const bureau2 = bureau.agent({ name: 'editor', instructions: 'You edit prose for clarity.' });

const run = bureau2.run('researcher', 'Summarize the Q3 report.');
for await (const event of run) {
  // ...
}
const result = await run.result();
```

Three tiers of agent registration compose the same underlying state:

1. **Construction-time seed** — pass an `agents` map to `createBureau({ agents })`.
2. **Chained accretion** — `bureau.agent({ name, ... })` returns a wider-typed builder; reassign the result to keep the new agent's static name available to `.run()`.
3. **Per-call widening** — `bureau.run<AgentTable>('dynamic-name', input)` for agent names resolved at runtime rather than statically declared.

`.tools()` registers bureau-level tools (merged into every agent's toolbox, agent tools winning on name collision); `.generate()` sets a bureau-level default `GenerateFunction` (an agent's own `generate` overrides it); `.skills()` attaches a skill catalog provider with the same `<available_skills>` injection behavior as the main `createBureau()`. Each `.agent()` call accepts its own `instructions`, `tools`, `generate`, and `skillPolicy`.

This builder is a distinct export (`bureau/builder`, not `bureau`'s top-level `createBureau`) — the two are not interchangeable. Use the main `createBureau()` when you need sessions, durability, or a single generate/provider configuration shared across the whole bureau; use `bureau/builder`'s `createBureau()` when you need a small, statically-typed table of named agents with independent generate functions and no persistence.

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
