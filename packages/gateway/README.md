# Gateway

`gateway` is the HTTP and browser product surface for Agent Bureau. It composes the lower-level packages into a running service with APIs, server-rendered pages, live run updates, scheduler administration, session persistence, authentication, and rate limiting.

## What It Does

- Creates a `Bureau` runtime through `createBureau()`.
- Starts a Hono application through `createGateway()`.
- Mounts routes for health, configuration, runs, sessions, events, scheduler operations, and managed API keys.
- Streams live run state over Bun WebSocket and server-sent events.
- Renders the Svelte browser UI for dashboards, chat, run detail, and configuration pages.
- Reuses the runtime key-value store for API keys and rate-limit state when available.

## How It Works

`createGateway()` is the outer composition point. It calls `createBureau()`, creates a live-frame broker, mounts Hono middleware, attaches API routes, renders UI pages, serves built assets, and chooses a Bun or Node server adapter at runtime.

`createBureau()`, imported from the `bureau` package, is the runtime composition point behind the gateway. It resolves providers through `operative`'s provider factories (`operative/anthropic`, `operative/openai`, `operative/gemini`, plus fallover, routing, and embeddings under `operative/providers/*`), tools through `armorer`, conversation state through `conversationalist`, run execution through `operative`, state tracking through `operative/store`, memory through `memory`, and skills through `skills`. It also owns session persistence and recovered-run classification when durable execution is configured.

## Project Role

The other packages can be used as libraries. `gateway` is the integrated application surface that proves those libraries work together as a service. Product features such as live runs, session history, scheduler controls, and browser navigation belong here, while reusable runtime logic stays in the lower-level packages.

## Quick Start

> [!NOTE]
> `gateway` is a private application package (`"private": true`, no `exports` map). The `gateway` import specifier in these examples is the monorepo workspace name, resolved via `workspace:*` — it is not published to npm and is not importable outside this repository.

### Starting the HTTP server

```typescript
import { createGateway } from 'gateway';

const gateway = await createGateway({
  provider: {
    provider: 'anthropic',
    model: 'claude-opus-4-5',
    apiKey: process.env.ANTHROPIC_API_KEY,
  },
  systemPrompt: 'You are a helpful assistant.',
  port: 5555,
});

const server = await gateway.start();

// Shut down cleanly
server.stop();
```

`createGateway()` auto-detects the runtime (`'bun'` when `typeof Bun !== 'undefined'`, `'node'` otherwise). The default port is `5555`. Pass `authToken` to require a bearer token on every request.

### Running the bureau without HTTP

Use `createBureau()` directly when you want the runtime but not the HTTP layer—useful for embedding in another server or running offline.

```typescript
import { createBureau } from 'gateway';

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

`serializeRunState()` converts an internal `RunState` (which holds live objects) into the JSON-safe `RunSummary` DTO used by the REST API. Call it when you hold a `RunState` from `operative/store` and need a wire-safe representation.

```typescript
import { serializeRunState } from 'gateway';

const summary = serializeRunState(runState, sessionId);
// { id, sessionId, status, steps, usage, finishReason, error, actionCount }
```

### Durable execution with SQLite

Pass `storage` to enable checkpoint-based recovery. Durable execution is on by default whenever a persistent backend is configured.

```typescript
import { createGateway } from 'gateway';

const gateway = await createGateway({
  provider: { provider: 'anthropic', model: 'claude-opus-4-5' },
  storage: { type: 'sqlite', path: './bureau.db' },
  // durableExecution defaults to true for sqlite/lmdb; override with false to disable
});

const server = await gateway.start();
```

## Public API

### `createGateway(options?): Promise<Gateway>`

Creates the Hono application, wires all middleware and routes, and returns a `Gateway` handle. The server is **not** started until you call `gateway.start()`.

```typescript
interface GatewayOptions extends BureauOptions {
  port?: number; // default: 5555
  hostname?: string;
  authToken?: string; // bearer token required on every request when set
  runtime?: 'bun' | 'node'; // default: auto-detected
}

interface Gateway {
  readonly app: Hono;
  readonly bureau: Bureau;
  readonly store: Store;
  readonly port: number;
  start(): Promise<{ stop(): void }>;
}
```

### `createBureau(options?): Promise<Bureau>`

Composes the runtime without the HTTP layer. All `BureauOptions` fields are optional—the bureau starts with no provider configured when `generate`, `provider`, and `providers` are all omitted (`bureau.ready` returns `false`).

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

Maps a `ProviderConfiguration` to a generate function from `operative`'s provider factories. Supports `'anthropic'`, `'openai'`, `'gemini'`, `'voyage'`, and `'ollama'` (`operative`'s full `ProviderName` set).

```typescript
interface ProviderConfiguration {
  provider: 'anthropic' | 'openai' | 'gemini' | 'voyage' | 'ollama';
  model: string;
  maximumTokens?: number;
  temperature?: number;
  apiKey?: string;
}
```

### `serializeRunState(runState, sessionId?): RunSummary`

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

| Export                  | Value  | Description                   |
| ----------------------- | ------ | ----------------------------- |
| `DEFAULT_PORT`          | `5555` | Default HTTP port             |
| `DEFAULT_MAXIMUM_STEPS` | `10`   | Default agentic loop step cap |

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
