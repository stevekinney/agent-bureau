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

`createBureau()` is the runtime composition point behind the gateway. It resolves providers through `herald`, tools through `armorer`, conversation state through `conversationalist`, run execution through `operative`, state tracking through `operative/store`, memory through `memory`, and skills through `skills`. It also owns session persistence and recovered-run classification when durable execution is configured.

## Project Role

The other packages can be used as libraries. `gateway` is the integrated application surface that proves those libraries work together as a service. Product features such as live runs, session history, scheduler controls, and browser navigation belong here, while reusable runtime logic stays in the lower-level packages.

## Public Entry Points

- `createGateway(options)`: create the HTTP application and startable server.
- `createBureau(options)`: compose the runtime without starting the HTTP server.
- `resolveGenerate(configuration)`: resolve provider configuration into a generate function.
- `serializeRunState()`: convert internal run state into API-safe state.
- Gateway and Bureau types from `gateway`.

## Development

Run package checks from this directory:

```bash
bun run validate
bun run build
bun run dev
```

When type-aware linting reports broad unsafe-import errors after workspace changes, rebuild the workspace from the repository root with `bun run build` before retrying package-local validation.
