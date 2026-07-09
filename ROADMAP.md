# Roadmap

This roadmap reflects the current repository, not the historical backlog. The gateway-first productization pass, durable execution, multi-agent orchestration, and durable human-in-the-loop primitives are now shipped, which changes the question from _"can these packages do the job?"_ to _"what higher-level product surface should come next?"_

## Implemented Capabilities

- **Tooling and conversation foundations**: `armorer`, `conversationalist`, `interoperability`, and `lifecycle` provide the validated tool surface, conversation model, provider-format interoperability, and event primitives the rest of the workspace builds on.
- **Provider and loop runtime**: `operative` ships provider factories (`operative/anthropic`, `operative/openai`, `operative/gemini`), fallover, routing, structured output, cache wrappers, retries, hook expansion, guardrails, sessions, scheduler support, and enhanced streaming.
- **Durable execution**: `operative/durable` provides Weft-backed crash-and-resume runs (`createRunEngine`, `reattachDurableActiveRun`), and `bureau` wires boot-time recovery (`recoverAll`) plus durable signals, updates, queries, and schedules on top.
- **Durable human-in-the-loop**: `ctx.review`, `createRequestHumanInputTool`, and durable signals let a run suspend for a human decision and resume from the same checkpoint after a restart — no separate approval-queue service.
- **Multi-agent orchestration**: subagent tools (`createSubagentTool`), handoffs (`createHandoffTool`), a supervisor (`createSupervisor`), and an agent registry (`createAgentRegistry`) let one run delegate to or hand off to another agent.
- **Guardrails**: `operative`'s guardrail detectors validate and constrain run behavior (content, budget, and loop-detection policies).
- **Composition**: `bureau` (`createBureau()`) assembles providers, tools, memory, skills, session persistence, durable execution, guardrails, and multi-agent behavior from one configuration surface, plus a typed builder API (`bureau/builder`) for static agent registries and a durable audit trail.
- **State, skills, memory, and storage**: `operative/store`, `skills`, and `memory` cover run tracking, skill loading, and hybrid (BM25 + embedding) memory ranking; key-value persistence is backed by Weft's durable storage (`@lostgradient/weft`).
- **Gateway product surface**: `gateway` exposes session-first APIs, run detail payloads, live updates over WebSocket and server-sent events, scheduler administration, managed API keys, and a Svelte 5 browser UI wired to the same runtime.
- **Observability**: optional OpenTelemetry spans and metrics for durable runs (`observability` on `BureauOptions`), off by default and a no-op without `@opentelemetry/api`.
- **Evaluation**: `evaluation` provides runners, matchers, metrics, an LLM-judge, dataset loading, and report comparison for agent behavior validation as a library — see [Deferred Tracks](#deferred-tracks) for the CI/release layer that doesn't exist yet.

The standing quality gates for this shipped surface are:

```bash
bun run coverage:check
bun run test
bun run validate
```

## Current Reference Notes

These reference files describe delivered architecture:

- [**Session persistence**](reference/session-persistence.md): canonical `SessionStore` usage, `sessionId` APIs, and gateway session routes.
- [**Streaming pipeline**](reference/streaming-pipeline.md): normalized streaming events, live frame brokering, WebSocket plus SSE transport, and reconnect behavior.
- [**Gateway authentication**](reference/gateway-authentication.md): managed API keys, principal-aware rate limiting, static-token fallback, and EventSource-compatible token handling.
- [**Durable execution**](reference/durable-execution.md): the Weft-backed crash-and-resume run model.
- [**Approval workflows**](reference/approval-workflows.md): durable human-in-the-loop review via `ctx.review` and signals.
- [**Model fallover**](reference/model-fallover.md) and [**model routing**](reference/model-routing.md): provider health tracking, fallover ordering, and step-based routing.
- [**Guardrails**](reference/guardrails.md): the guardrail detector model.
- [**Evaluation framework**](reference/evaluation-framework.md): the `evaluation` package's runner, matchers, and judge model.

## Deferred Tracks

These tracks remain genuinely unbuilt. They need their own product decisions, UX work, and verification plans — the runtime primitives above (durable execution, multi-agent, HITL) are available to build them on top of, but none of the following exists yet.

- **Evaluation operations and release gates**: CI-integrated regression gating, historical dashboards, and release-promotion signals built on top of `evaluation`'s existing runner and dataset primitives. Today `evaluation` runs as a library; nothing wires it into CI as a merge gate.
- **IDE, LSP, and worktree-assisted workflows**: codebase-aware developer workflows, worktree management, and local editing orchestration. No package in this workspace touches an editor, a language server, or git worktrees.
- **Plugin, connector, and tool-search ecosystem**: discoverable third-party connectors, a plugin packaging format, policy controls for installed plugins, and tool-search infrastructure beyond `armorer`'s in-process registry queries. Nothing in the workspace publishes or discovers tools across process boundaries.
- **Review-queue product surface**: a standalone reviewer-facing queue UI/API (triage, assignment, SLA tracking) built on top of the `ctx.review` primitive. The primitive exists and is durable; the product surface around it — a dashboard for humans to work through pending reviews — does not.
- **Multi-agent workbench UX**: a visual, gateway-hosted UI for composing and observing multi-agent task graphs. The runtime primitives (subagents, handoffs, supervisor, registry) are implemented and usable from code; there is no browser UI for building or visualizing agent topologies yet.
