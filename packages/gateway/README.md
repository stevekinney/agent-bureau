# Gateway

`gateway` is the HTTP and browser product surface for Agent Bureau. It composes the lower-level packages into a running service with APIs, server-rendered pages, live run updates, scheduler administration, session persistence, authentication, and rate limiting.

## What It Does

- Wraps an already-constructed `Bureau` (built with `createBureau()` from the `bureau` package) in a Hono application through `createGateway(bureau, options)`.
- Mounts routes for health, configuration, runs, sessions, events, scheduler operations, and managed API keys.
- Streams live run state over Bun WebSocket and server-sent events.
- Renders the Svelte browser UI for dashboards, chat, run detail, configuration, and evaluation-report trend pages.
- Reuses the runtime key-value store for API keys and rate-limit state when available.

## How It Works

`createGateway(bureau, options)` is the outer composition point, but it does **not** build the runtime itself — it takes an already-constructed `Bureau` as its first argument and wraps it: creates a live-frame broker, mounts Hono middleware, attaches API routes, renders UI pages, serves built assets, and chooses a Bun or Node server adapter at runtime. `options` (`GatewayOptions`) is transport-only (port, host, auth, runtime) — it carries no brain/runtime configuration.

`createBureau()`, imported from the `bureau` package, is the runtime composition point — the caller builds this first and passes it to `createGateway()`. It resolves providers through `operative`'s provider factories (`operative/anthropic`, `operative/openai`, `operative/gemini`, plus fallover, routing, and embeddings under `operative/providers/*`), tools through `armorer`, conversation state through `conversationalist`, run execution through `operative`, state tracking through `operative/store`, memory through `memory`, and skills through `skills`. It also owns session persistence and recovered-run classification when durable execution is configured.

## Project Role

The other packages can be used as libraries. `gateway` is the integrated application surface that proves those libraries work together as a service. Product features such as live runs, session history, scheduler controls, and browser navigation belong here, while reusable runtime logic stays in the lower-level packages.

## Quick Start

> [!NOTE]
> `gateway` is a private application package (`"private": true`, no `exports` map). The `gateway` import specifier in these examples is the monorepo workspace name, resolved via `workspace:*` — it is not published to npm and is not importable outside this repository.

### Starting the HTTP server

`createGateway()` takes an already-constructed `Bureau` as its first argument — the bureau is the brain, the gateway is the door over it. Build the bureau with `createBureau()` from the `bureau` package, then wrap it.

```typescript
import { createBureau } from 'bureau';
import { createGateway } from 'gateway';

const bureau = await createBureau({
  provider: {
    provider: 'anthropic',
    model: 'claude-opus-4-5',
    apiKey: process.env.ANTHROPIC_API_KEY,
  },
  systemPrompt: 'You are a helpful assistant.',
});

const gateway = await createGateway(bureau, { port: 5555 });
const server = await gateway.start();

// Shut down cleanly
server.stop();
bureau.dispose();
```

`createGateway()` auto-detects the runtime (`'bun'` when `typeof Bun !== 'undefined'`, `'node'` otherwise). The default port is `5555`. Pass `authToken` to require a bearer token on every request. See `src/start.ts` for the reference process entrypoint that reads this configuration from the environment (used by `bun run start` and the Dockerfile — documented in `documentation/deployment.md`).

### Running the bureau without HTTP

Use `createBureau()` (from the `bureau` package) directly when you want the runtime but not the HTTP layer—useful for embedding in another server or running offline.

```typescript
import { createBureau } from 'bureau';

const bureau = await createBureau({
  provider: { provider: 'openai', model: 'gpt-4o', apiKey: process.env.OPENAI_API_KEY },
  maximumSteps: 10,
  systemPrompt: 'You are a coding assistant.',
});

// Dispatch a run
const summary = await bureau.createRun({ message: 'Explain closures in JavaScript.' });
// summary: { id, sessionId, status, steps, usage, finishReason, ... }

// Subscribe to live frames
const unsubscribe = bureau.subscribeLiveFrames((frame) => {
  // frame.type: 'event' | 'stream:text-delta' | 'scheduler.state' | ...
  void frame;
});

bureau.dispose();
```

### Resolving a generate function from provider config

`resolveGenerate()` is the thin bridge between a `ProviderConfiguration` object and a `GenerateFunction`. The gateway uses it internally; call it directly when you need a bare generate function outside of a full bureau composition.

```typescript
import { resolveGenerate } from 'gateway';

const generate = resolveGenerate({
  provider: 'gemini',
  model: 'gemini-2.0-flash',
  apiKey: process.env.GEMINI_API_KEY,
});
```

### Serializing run state

`serializeRunState()` converts an internal `RunState` (which holds live objects) into the JSON-safe `RunSummary` DTO used by the REST API. It lives in the `bureau` package — call it when you hold a `RunState` from `operative/store` and need a wire-safe representation.

```typescript
import { serializeRunState } from 'bureau';

const summary = serializeRunState(runState, sessionId);
// { id, sessionId, status, steps, usage, finishReason, error, actionCount }
```

### Durable execution with SQLite

Pass `storage` to `createBureau()` to enable checkpoint-based recovery. Durable execution is on by default whenever a persistent backend is configured.

```typescript
import { createBureau } from 'bureau';
import { createGateway } from 'gateway';

const bureau = await createBureau({
  provider: { provider: 'anthropic', model: 'claude-opus-4-5' },
  storage: { type: 'sqlite', path: './bureau.db' },
  // durableExecution defaults to true for sqlite/lmdb; override with false to disable
});

const gateway = await createGateway(bureau);
const server = await gateway.start();
```

## Public API

### `createGateway(bureau, options?): Promise<Gateway>`

Wraps an already-constructed `Bureau` (see `createBureau()` in the `bureau` package) in an HTTP door: creates the Hono application, wires all middleware and routes, and returns a `Gateway` handle. The server is **not** started until you call `gateway.start()`. `GatewayOptions` is transport-only — it does not carry any brain/runtime configuration, which lives entirely on the `Bureau` passed as the first argument.

```typescript
interface GatewayOptions {
  port?: number; // default: 5555
  hostname?: string;
  authToken?: string; // bearer token required on every request when set
  runtime?: 'bun' | 'node'; // default: auto-detected
  allowedOrigins?: string[]; // WebSocket upgrade origin allowlist
  enableCsp?: boolean; // default: true
  idleTimeout?: number; // seconds; Bun default: 10
  evaluationReportsDirectory?: string; // backs the read-only /evaluations trend page
}

interface Gateway {
  readonly app: Hono;
  readonly bureau: Bureau;
  readonly store: Store;
  readonly port: number;
  start(): Promise<{ stop(): void }>;
}
```

### `/evaluations` — evaluation report trend page

A read-only, server-rendered page listing evaluation reports over time (pass rate, cost). Set `evaluationReportsDirectory` to the directory `runEvaluationSuite`'s `output` option writes reports into — `GET /evaluations` reads it via `listEvaluationReports()` (from the `evaluation` package) on every request and renders a pass-rate trend chart, an average-token-cost trend chart, and a table of every report. When unset, the page renders an empty state; there is no write path from the UI in this v1.

```typescript
import { createBureau } from 'bureau';
import { createGateway } from 'gateway';

const bureau = await createBureau();
const gateway = await createGateway(bureau, {
  evaluationReportsDirectory: 'reports/evaluations',
});
await gateway.start();
// Visit http://localhost:5555/evaluations
```

### `createBureau(options?): Promise<Bureau>` (from `bureau`, not `gateway`)

Composes the runtime without the HTTP layer. `gateway` does not re-export this — import it from the `bureau` package (`createGateway`'s first argument is a `Bureau` built this way). All `BureauOptions` fields are optional—the bureau starts with no provider configured when `generate`, `provider`, and `providers` are all omitted (`bureau.ready` returns `false`).

```typescript
interface BureauOptions {
  generate?: GenerateFunction;
  provider?: ProviderConfiguration; // single provider
  providers?: ProviderRouteConfiguration[]; // multi-provider routing
  routing?: RoutingConfiguration; // step-based, complexity, or cost-aware
  toolbox?: Toolbox;
  store?: Store; // default: in-memory store
  persistence?: TextValueStore; // KV-only session storage
  storage?: StorageConfiguration; // sqlite | lmdb | memory (+ durable engine)
  durableExecution?: boolean; // default: true for sqlite/lmdb, false otherwise
  memory?: CreateMemoryOptions | Memory;
  cache?: CacheConfiguration;
  guardrails?: GuardrailsOptions;
  skills?: SkillRuntimeConfiguration;
  streaming?: StreamingConfiguration;
  scheduler?: SchedulerConfiguration;
  systemPrompt?: string;
  maximumSteps?: number; // default: 10
  stopWhen?: StopCondition | StopCondition[];
  observability?: boolean | Omit<ObservabilityOptions, 'eventTarget'>; // eventTarget is injected by the engine
  onLog?: (record: WorkflowLogRecord) => void;
  durableGuardrails?: DurableGuardrailsConfiguration;
}
```

Key `Bureau` methods:

| Method                     | Returns                                       | Description                        |
| -------------------------- | --------------------------------------------- | ---------------------------------- |
| `createRun(request)`       | `Promise<RunSummary>`                         | Dispatch a new agent run           |
| `listRuns(status?)`        | `RunSummary[]`                                | List active or filtered runs       |
| `getRun(id)`               | `RunDetail \| undefined`                      | Fetch full run detail              |
| `abortRun(id)`             | `RunSummary`                                  | Abort an in-flight run             |
| `deleteRun(id)`            | `void`                                        | Remove a completed run             |
| `listSessions()`           | `Promise<SessionSummary[]>`                   | List persisted sessions            |
| `getSession(id)`           | `Promise<AgentSession \| undefined>`          | Load a session by id               |
| `getConfiguration()`       | `ConfigurationResponse`                       | Current provider and tool config   |
| `submitSchedulerTask(req)` | `Promise<SubmitSchedulerTaskResponse>`        | Queue a background scheduler task  |
| `deleteSession(id)`        | `Promise<void>`                               | Remove a persisted session         |
| `getDurableRun(runId)`     | `Promise<WorkflowState \| null \| undefined>` | Fetch durable run state            |
| `listDurableRuns(...)`     | `Promise<...>`                                | List durable runs                  |
| `getTools()`               | `ToolSummary[]`                               | List the configured tools          |
| `subscribeLiveFrames(fn)`  | `() => void`                                  | Subscribe to live WebSocket frames |
| `ready`                    | `boolean`                                     | Whether the runtime is initialized |
| `dispose()`                | `void`                                        | Tear down the runtime              |

### `resolveGenerate(configuration): GenerateFunction`

Maps a `ProviderConfiguration` to a generate function from `operative`'s provider factories. Gateway's `ProviderConfiguration` (re-exported from `bureau`) is the generate-capable subset of `operative`'s full `ProviderName` union — `'anthropic'`, `'openai'`, or `'gemini'`. `'voyage'` and `'ollama'` are embedding-only in `operative` and are not accepted here.

```typescript
interface ProviderConfiguration {
  provider: 'anthropic' | 'openai' | 'gemini';
  model: string;
  maximumTokens?: number;
  temperature?: number;
  apiKey?: string;
}
```

### `serializeRunState(runState, sessionId?): RunSummary` (from `bureau`, not `gateway`)

Converts a live `RunState` to the JSON-safe `RunSummary` DTO. Strips non-serializable objects (`Conversation`, `ActiveRun`) and normalizes errors to strings.

```typescript
interface RunSummary {
  id: string;
  sessionId: string;
  status: string;
  steps: number;
  usage: { prompt: number; completion: number; total: number };
  finishReason: string | undefined;
  error: string | undefined;
  actionCount: number;
}
```

### Constants

| Export                                                              | Value  | Description                   |
| ------------------------------------------------------------------- | ------ | ----------------------------- |
| `DEFAULT_PORT`                                                      | `5555` | Default HTTP port             |
| `DEFAULT_MAXIMUM_STEPS` (from `operative`, re-exported by `bureau`) | `25`   | Default agentic loop step cap |

### Events

The `Bureau` emits typed events through its `CompletableEventTarget` interface.

| Event class           | Fires when                                             |
| --------------------- | ------------------------------------------------------ |
| `ActionEvent`         | A run action (step, tool call, completion) is recorded |
| `RunRegisteredEvent`  | A new run is registered with the store                 |
| `RunRemovedEvent`     | A run is removed from the store                        |
| `BureauDisposedEvent` | `bureau.dispose()` is called                           |

## Development

Run package checks from this directory:

```bash
bun run validate
bun run build
bun run dev
```

When type-aware linting reports broad unsafe-import errors after workspace changes, rebuild the workspace from the repository root with `bun run build` before retrying package-local validation.
