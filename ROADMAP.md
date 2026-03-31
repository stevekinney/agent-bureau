# Roadmap

This roadmap now reflects the current workspace reality instead of the historical backlog. Agent Bureau already contains most of the core runtime primitives; the remaining work is about productizing them coherently and then expanding into higher-level operating surfaces.

## Implemented Capabilities

- **Tooling and conversation foundations**: `armorer`, `conversationalist`, `interoperability`, and `lifecycle` provide the validated tool surface, conversation model, interoperability types, and event primitives the rest of the workspace builds on.
- **Provider and loop runtime**: `herald` and `operative` already ship provider factories, fallover, routing, structured output, cache wrappers, retries, hook expansion, guardrails, sessions, scheduler support, and enhanced streaming.
- **State, skills, memory, and storage**: `sentinel`, `skills`, `memory`, `storage`, and `vector-frankl` cover run tracking, skill loading, memory ranking, key-value persistence, and vector search.
- **Gateway product surface**: `gateway` now exposes session-first APIs, run detail payloads, live streaming over WebSocket and server-sent events, scheduler administration, managed API keys, and a browser UI wired to the same runtime.
- **Evaluation**: `evaluation` provides runners, reports, metrics, and comparison tooling for agent behavior validation.

## Current Core Program

The current release program is the gateway-first productization pass. Its job is to make the existing package surface feel like one system instead of a loose collection of strong libraries.

- **Canonical runtime composition**: `createBureau()` and `createGateway()` compose providers, fallover, routing, cache, guardrails, identity, memory, skills, sessions, and scheduler behavior from one configuration surface.
- **Session-first persistence**: gateway request and response shapes use `sessionId`, and session lifecycle is backed by `AgentSession` plus `SessionStore`.
- **Live transport completion**: the runtime emits normalized live frames, Bun uses WebSocket as the preferred transport, and Node uses server-sent events as the parity path.
- **Operational hardening**: rate limiting is keyed by authenticated principal and can persist through the shared key-value store, scheduler routes support real submission and cancellation, and gateway storage configuration uses the canonical storage package surface.
- **Documentation reset**: the root docs describe the actual 14-package workspace and separate shipped capabilities from deferred next-generation work.

The release gates for this program are:

```bash
bun run coverage:check
bun run test
bun run validate
```

## Deferred Next-Generation Tracks

These tracks are intentionally deferred from the current core program. They need their own product decisions, UX work, and verification plans.

- [**Multi-agent task orchestration and workbench UX**](reference/future/multi-agent-workbench.md): delegated work, supervisor flows, task graphs, and a visual workbench.
- [**Automation and recurring runs**](reference/future/automation-and-recurring-runs.md): schedules, recurring jobs, retries, notifications, and operator controls for long-lived automation.
- [**IDE, LSP, and worktree-assisted workflows**](reference/future/ide-and-worktree-workflows.md): codebase-aware developer workflows, worktree management, and local editing orchestration.
- [**Plugin, connector, and tool-search ecosystem**](reference/future/plugin-and-connector-ecosystem.md): discoverable connectors, plugin packaging, policy controls, and tool-search infrastructure.
- [**Evaluation operations and release gates**](reference/future/evaluation-operations.md): dataset management, regression dashboards, CI gating, and release promotion signals.
- [**Notifications, review workflows, and human-in-the-loop controls**](reference/future/human-in-the-loop-controls.md): approvals, review queues, notifications, and audit-friendly operator workflows.
