# Roadmap

This roadmap reflects the current repository, not the historical backlog. The gateway-first productization pass is now shipped, which changes the question from _"can these packages do the job?"_ to _"what higher-level product surface should come next?"_

## Implemented Capabilities

- **Tooling and conversation foundations**: `armorer`, `conversationalist`, `interoperability`, and `lifecycle` provide the validated tool surface, conversation model, provider-format interoperability, and event primitives the rest of the workspace builds on.
- **Provider and loop runtime**: `herald` and `operative` ship provider factories, fallover, routing, structured output, cache wrappers, retries, hook expansion, guardrails, sessions, scheduler support, and enhanced streaming.
- **State, skills, memory, and storage**: `sentinel`, `skills`, `memory`, `storage`, and `vector-frankl` cover run tracking, skill loading, memory ranking, key-value persistence, and vector search.
- **Gateway product surface**: `gateway` now exposes session-first APIs, run detail payloads, live updates over WebSocket and server-sent events, scheduler administration, managed API keys, and a browser UI wired to the same runtime.
- **Evaluation**: `evaluation` provides runners, reports, metrics, and comparison tooling for agent behavior validation.

## Recently Delivered

The work on this branch completed the core gateway-first productization pass.

- **Canonical runtime composition**: `createBureau()` and `createGateway()` compose providers, fallover, routing, cache, guardrails, identity, memory, skills, sessions, and scheduler behavior from one configuration surface.
- **Session-first persistence**: gateway request and response shapes use `sessionId`, session lifecycle is backed by `AgentSession` plus `SessionStore`, and the gateway no longer treats `Conversation` auto-persistence as the product source of truth.
- **Live transport completion**: the runtime emits normalized live frames, Bun uses WebSocket as the preferred transport, Node uses server-sent events as the parity path, and the browser client restores desired subscriptions after reconnect.
- **Operational hardening**: rate limiting is keyed by authenticated principal and can persist through the shared key-value store, scheduler routes support submission and cancellation, and gateway storage configuration uses the canonical storage package surface.
- **Documentation reset**: the root docs now describe the actual 14-package workspace and separate shipped behavior from deferred next-generation tracks.

The standing quality gates for this shipped surface are:

```bash
bun run coverage:check
bun run test
bun run validate
```

## Current Reference Notes

These reference files now describe the delivered architecture instead of pending design work:

- [**Session persistence**](reference/session-persistence.md): canonical `SessionStore` usage, `sessionId` APIs, and gateway session routes.
- [**Streaming pipeline**](reference/streaming-pipeline.md): normalized streaming events, live frame brokering, WebSocket plus SSE transport, and reconnect behavior.
- [**Gateway authentication**](reference/gateway-authentication.md): managed API keys, principal-aware rate limiting, static-token fallback, and EventSource-compatible token handling.

## Deferred Next-Generation Tracks

These tracks are intentionally deferred from the work that shipped here. They need their own product decisions, UX work, and verification plans.

- [**Multi-agent task orchestration and workbench UX**](reference/future/multi-agent-workbench.md): delegated work, supervisor flows, task graphs, and a visual workbench.
- [**Automation and recurring runs**](reference/future/automation-and-recurring-runs.md): schedules, recurring jobs, retries, notifications, and operator controls for long-lived automation.
- [**IDE, LSP, and worktree-assisted workflows**](reference/future/ide-and-worktree-workflows.md): codebase-aware developer workflows, worktree management, and local editing orchestration.
- [**Plugin, connector, and tool-search ecosystem**](reference/future/plugin-and-connector-ecosystem.md): discoverable connectors, plugin packaging, policy controls, and tool-search infrastructure.
- [**Evaluation operations and release gates**](reference/future/evaluation-operations.md): dataset management, regression dashboards, CI gating, and release promotion signals.
- [**Notifications, review workflows, and human-in-the-loop controls**](reference/future/human-in-the-loop-controls.md): approvals, review queues, notifications, and audit-friendly operator workflows.
