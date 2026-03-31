# Agent Bureau

Agent Bureau is a Bun-first monorepo for building, running, and operating agent systems. The workspace now ships both the low-level libraries and a gateway-first product surface: runtime composition, persistent sessions, live run streaming, scheduler administration, and a browser UI.

## What Ships

- **Runtime composition**: `gateway` and `bureau` now assemble providers, fallover, routing, cache, guardrails, memory, identity, skills, and scheduler behavior from one configuration surface.
- **Session-first persistence**: gateway APIs and UI state use sessions as the canonical product concept, backed by `AgentSession` and `SessionStore`.
- **Live transport**: Bun WebSocket remains the fast path, and server-sent events provide Node-compatible live updates for run state and streaming deltas.
- **Operational controls**: the gateway exposes scheduler state, task submission, cancellation, recent history, managed API keys, and store-backed rate limiting.
- **Evaluation and utilities**: the workspace includes evaluation tooling, state tracking, cross-platform storage, vector search, and reusable lifecycle primitives.

## Gateway-First Flow

The simplest way to use the workspace is to start with `createGateway()` and let it compose the runtime for you.

```ts
import { createGateway } from 'gateway';

const gateway = await createGateway({
  storage: { type: 'auto' },
  providers: [
    {
      name: 'fast',
      provider: { provider: 'openai', model: 'gpt-5.4-mini' },
    },
    {
      name: 'frontier',
      provider: { provider: 'anthropic', model: 'claude-sonnet-4.5' },
    },
  ],
  routing: {
    type: 'step-based',
    first: 'fast',
    middle: 'fast',
    last: 'frontier',
  },
  scheduler: { enabled: true },
});

const server = await gateway.start();
```

That composition path gives you:

- provider resolution with single-provider, fallover, or routing behavior
- persistent sessions through `storage` or an explicit key-value store
- memory recall and persistence hooks when memory is configured
- skill catalog injection and skill management tools when skills are configured
- live event delivery through WebSocket and server-sent events

If you need full control, `BureauOptions.generate` still acts as the advanced escape hatch.

## Workspace Packages

- [`packages/armorer`](packages/armorer/): validated tools, toolboxes, execution, MCP adapters, and test helpers.
- [`packages/conversationalist`](packages/conversationalist/): immutable conversation state, history, serialization, and provider message adapters.
- [`packages/evaluation`](packages/evaluation/): evaluation runners, matchers, metrics, and report comparison.
- [`packages/gateway`](packages/gateway): HTTP gateway, session API, live transport, scheduler routes, and the browser UI.
- [`packages/herald`](packages/herald): provider factories, fallover, structured output, routing, and streaming adapters.
- [`packages/integration`](packages/integration): cross-package integration coverage for the published surfaces.
- [`packages/interoperability`](packages/interoperability): shared materialization and interoperability types.
- [`packages/lifecycle`](packages/lifecycle): typed event targets, observables, async iterators, and lifecycle primitives.
- [`packages/memory`](packages/memory): memory ranking, decay, BM25 search, hybrid retrieval, and utilities.
- [`packages/operative`](packages/operative): the agent loop, sessions, scheduler, hooks, retry, guardrails, and streaming.
- [`packages/sentinel`](packages/sentinel): run state tracking, ordered action logs, and snapshots.
- [`packages/skills`](packages/skills): skill discovery, loading, storage, and self-improvement primitives.
- [`packages/storage`](packages/storage): the canonical cross-platform key-value storage surface and adapters.
- [`packages/vector-frankl`](packages/vector-frankl): vector storage and similarity search.

## Quality Gates

Run these from the repository root:

```bash
bun run build
bun run test
bun run coverage:check
bun run integration
bun run validate
```

`bun run coverage:check` is the strict package-level coverage gate for the scoped public packages. `bun run validate` runs formatting, linting, type-checking, and tests through Turbo.

## Roadmap

The current release roadmap lives in [`ROADMAP.md`](ROADMAP.md). Deferred next-generation tracks are documented under [`reference/future/`](reference/future/).
