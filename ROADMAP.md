# Roadmap

Production-readiness work for agent-bureau. Each item links to a detailed reference document with product requirements, TDD phases, and acceptance criteria. All documents are optimized for automated execution via Ralph pipeline.

## Execution Plan

17 items organized into 7 waves. Each wave lists items that can run **in parallel**. A wave starts only after all items it depends on have merged.

### Dependency Graph

```
Wave 1 (6 parallel)
├── Cross-Platform Crypto          interoperability, armorer, skills, memory
├── Model Fallover                 herald
├── Session Persistence            operative, gateway
├── Gateway Authentication         gateway
├── Structured Output              herald, operative
└── Context Engine                 operative

Wave 2 (4 parallel, after Wave 1)
├── Environment Compatibility      ← Cross-Platform Crypto
├── Streaming Pipeline             ← Context Engine
├── Hook Expansion                 ← Context Engine
└── Evaluation Framework           new package, no deps

Wave 3 (5 parallel, after Wave 2)
├── Smart Retry                    ← (benefits from Model Fallover)
├── Response Caching               operative, standalone
├── Guardrails                     ← (benefits from Hook Expansion)
├── Idempotent Tools               armorer, standalone
└── Model Routing                  herald, standalone

Wave 4 (2 parallel, after Wave 3)
├── Durable Execution              ← Idempotent Tools
└── Approval Workflows             operative, standalone
```

### Wave 1: Foundation (all 6 in parallel)

| Item | Package(s) | Why first |
|---|---|---|
| [Cross-Platform Crypto](reference/cross-platform-crypto.md) | interoperability, armorer, skills, memory | Touches the lowest-level shared package. Environment Compatibility depends on it. |
| [Model Fallover](reference/model-fallover.md) | herald | Standalone. Smart Retry benefits from its `classifyProviderError()`. |
| [Session Persistence](reference/session-persistence.md) | operative, gateway | Standalone. Wires existing primitives together. |
| [Gateway Authentication](reference/gateway-authentication.md) | gateway | Standalone. No other item touches gateway middleware. |
| [Structured Output](reference/structured-output.md) | herald, operative | Standalone. Touches different files than other herald/operative items. |
| [Context Engine](reference/context-engine.md) | operative | Streaming Pipeline and Hook Expansion both build on top of it. |

No conflicts: Cross-Platform Crypto modifies `interoperability` and `armorer/src/create-tool.ts` + `armorer/src/core/loop-detection.ts`. No other Wave 1 item touches those files. Context Engine adds new files under `operative/src/context/`. Session Persistence adds under `operative/src/session/`. No overlap.

### Wave 2: Build on Foundation (all 4 in parallel)

| Item | Depends on | Why this wave |
|---|---|---|
| [Environment Compatibility](reference/environment-compatibility.md) | Cross-Platform Crypto | Can't add `browser` exports until `node:crypto` is removed from armorer. |
| [Streaming Pipeline](reference/streaming-pipeline.md) | Context Engine | Needs context assembly to know what to stream. Adds `operative/src/streaming/` and `herald/src/streaming/`. |
| [Hook Expansion](reference/hook-system-expansion.md) | Context Engine | Adds hooks around context assembly lifecycle. Extends `operative/src/hooks/`. |
| [Evaluation Framework](reference/evaluation-framework.md) | None (but benefits from Wave 1 being stable) | New package, no file conflicts. Can start in Wave 1 if desired, but Wave 2 gives a stable foundation to eval against. |

### Wave 3: Production Hardening (all 5 in parallel)

| Item | Benefits from | Why this wave |
|---|---|---|
| [Smart Retry](reference/smart-retry.md) | Model Fallover | Uses `classifyProviderError()` for overflow detection. Can stub if needed. |
| [Response Caching](reference/response-caching.md) | — | Standalone. Adds `operative/src/cache/`. |
| [Guardrails](reference/guardrails.md) | Hook Expansion | Integrates as `PrepareStepHook` and `ValidateResponseHook`. Richer hooks = richer guardrails. |
| [Idempotent Tools](reference/idempotent-tools.md) | — | Standalone. Adds `armorer/src/idempotency/`. Prerequisite for Durable Execution. |
| [Model Routing](reference/model-routing.md) | — | Standalone. Adds `herald/src/routing/`. |

### Wave 4: Final (2 in parallel)

| Item | Depends on | Why last |
|---|---|---|
| [Durable Execution](reference/durable-execution.md) | Idempotent Tools | Tools must be safe to retry before crash recovery can re-execute them. |
| [Approval Workflows](reference/approval-workflows.md) | — | Standalone but benefits from everything else being stable. |

### Aggressive Schedule (skip waves, maximize parallelism)

If you want maximum throughput, most Wave 2-3 items can start as soon as their specific dependency merges rather than waiting for the full wave:

- **Environment Compatibility** can start the moment Cross-Platform Crypto merges
- **Streaming Pipeline** and **Hook Expansion** can start the moment Context Engine merges
- **Smart Retry** can start the moment Model Fallover merges (or immediately, stubbing the classifier)
- **Guardrails** can start the moment Hook Expansion merges (or immediately, using existing 7 hooks)
- **Durable Execution** can start the moment Idempotent Tools merges
- **Evaluation Framework**, **Response Caching**, **Idempotent Tools**, **Model Routing**, and **Approval Workflows** have no hard blockers and can start anytime

## Tier 1: Core Runtime

- [ ] **[Context Engine](reference/context-engine.md)** — Token budgeting, pluggable context assembly, compaction strategies, and subagent context isolation for the operative package. This is the difference between "demo agent" and "agent that handles long conversations." Adds `createTokenBudget()`, `createContextAssembler()`, sliding window / selective pruning / hybrid compaction strategies, and `prepareSubagentContext()`. Extends `OperativeHookMap` with context assembly and compaction hooks. All in `packages/operative/src/context/`.

- [ ] **[Model Fallover](reference/model-fallover.md)** — Cascading failure recovery across LLM providers in the herald package. When a provider is down, rate-limited, or returns an auth error, the agent cascades to the next provider instead of dying. Adds `createFalloverGenerate()`, `classifyProviderError()`, provider health tracking with cooldown periods, and `FalloverExhaustedError`. Error-type-aware behavior: auth errors skip immediately, server errors retry then skip, overflow errors never cascade. All in `packages/herald/src/fallover/`.

- [ ] **[Session Persistence](reference/session-persistence.md)** — Wires operative's existing `AgentSession` system to the storage package's `KeyValueStore`. Adds `createSessionStore()` with list/search/cleanup, session resume (pick up where you left off), auto-save integration with the agent loop, and session lifecycle hooks. Connects to the gateway's conversation routes so `GET /conversations` and `POST /runs` with `conversationId` use persistent storage. All in `packages/operative/src/session/` with gateway route updates.

- [ ] **[Gateway Authentication](reference/gateway-authentication.md)** — Upgrades the gateway from a single static Bearer token to managed API keys stored in `KeyValueStore`. Adds `createApiKeyStore()` with hashed key storage, per-key rate limiting (sliding window), scope-based access control on all routes, key management API (`POST /keys`, `GET /keys`, `DELETE /keys/:id`, rotation), and bootstrap key creation on first startup. Backward compatible with existing `authToken` option. All in `packages/gateway/src/keys/` and `packages/gateway/src/middleware/`.

- [ ] **[Streaming Pipeline](reference/streaming-pipeline.md)** — Block-level stream state tracking, provider-agnostic stream normalization, structured partial events, client backpressure handling, and gateway WebSocket integration. Adds `createStreamStateMachine()`, `normalizeAnthropicStream()`, `normalizeOpenAIStream()`, `withEnhancedStreaming()`, and `createBackpressureBuffer()`. Extends gateway `ServerFrame` with streaming-specific frame types. Keeps existing `withStreaming()` unchanged. Split across `packages/operative/src/streaming/`, `packages/herald/src/streaming/`, and gateway WebSocket updates.

- [ ] **[Hook System Expansion](reference/hook-system-expansion.md)** — Extends `OperativeHookMap` from 7 hooks to 16. Adds prompt lifecycle hooks (`beforeGenerate`, `afterGenerate`), read-only LLM I/O monitoring (`onLLMInput`, `onLLMOutput`), run lifecycle hooks (`onRunStart`, `onRunComplete`, `onRunError`, `onRunAbort`), and error recovery (`onError` with retry/skip/abort actions). Also adds hook composition utilities: `onlyOnStep()`, `runOnce()`, `everyNSteps()`, `withTimeout()`, `composeHooks()`. All in `packages/operative/src/hooks/`.

- [ ] **[Structured Output](reference/structured-output.md)** — Provider-native structured output support in herald (`tool_choice`, `response_format`) and per-step tool choice control in operative. Adds `ToolChoice` and `ResponseFormat` types, provider-specific adapters for Anthropic/OpenAI/Gemini, `zodToJsonSchema()` converter to bridge operative's `responseSchema` to herald's `responseFormat`, and a `selectToolChoice` hook. Eliminates wasted tokens on invalid outputs by constraining generation at the provider level. Split across `packages/herald/src/structured-output/` and `packages/operative/src/structured-output/`.

- [ ] **[Cross-Platform Crypto](reference/cross-platform-crypto.md)** — Shared hashing utilities in the `interoperability` package replacing environment-specific crypto across the monorepo. Armorer uses `node:crypto.createHash` (breaks browsers), skills uses `Bun.CryptoHasher` (breaks Node.js and browsers), and memory has a standalone `crypto.subtle` implementation. Adds `sha256Hex()` (async, works everywhere), `sha256HexSync()` (sync, Bun/Node with runtime detection), and `createIncrementalHash()` (sync incremental hasher for streaming). Migrates armorer, skills, and memory to the shared utility. All in `packages/interoperability/src/hash.ts`.

- [ ] **[Environment Compatibility](reference/environment-compatibility.md)** — Fixes remaining cross-environment issues after crypto migration. Adds `isFts5Available()` guard to memory's FTS5 provider (currently crashes in non-Bun). Moves `node:module` behind dynamic import in armorer's MCP integration (currently breaks browser bundlers). Adds Node.js gateway support via server adapter pattern (`Bun.serve` → `@hono/node-server`). Adds `"browser"` export condition to 9 package.json files. Replaces `Bun.file()` calls in skills with `readFile` from `node:fs/promises`. Depends on Cross-Platform Crypto completing first.

## Tier 2: Production Hardening

- [ ] **[Smart Retry](reference/smart-retry.md)** — Extends operative's retry system with request mutation before retrying. Instead of repeating the identical call, mutate the context: compact conversation on overflow, remove failing tools, escalate temperature, inject schema errors as context. Adds `RetryMutator` callback to `RetryOptions`, built-in mutators (`createOverflowMutator()`, `createToolRemovalMutator()`, `createTemperatureEscalationMutator()`, `createSchemaErrorMutator()`), `composeMutators()`, and retry delay jitter. All in `packages/operative/src/retry/`.

- [ ] **[Response Caching](reference/response-caching.md)** — LLM response caching via `GenerateMiddleware`. Wraps any `GenerateFunction` with a `KeyValueStore`-backed cache. Adds `withCache()` middleware with configurable key strategies (`conversation-hash`, `last-message`, custom), TTL expiry, tool-call invalidation, cache metrics (hit rate, saved tokens, saved cost), and `clearCache()`/`invalidateCache()` utilities. Immediate cost savings for development loops and deterministic tool-use patterns. All in `packages/operative/src/cache/`.

- [ ] **[Guardrails](reference/guardrails.md)** — Defense-in-depth safety system. Layer 1: `createInputGuardrail()` with prompt injection detection, topic boundary enforcement, and input length limits. Layer 3: `createOutputGuardrail()` with grounding validation, PII leakage detection, and code safety checking. Session tainting marks conversations as potentially compromised after high-confidence threat detection, activating escalated detectors. `createGuardrails()` composes input + output into operative hooks. All in `packages/operative/src/guardrails/`.

- [ ] **[Idempotent Tools](reference/idempotent-tools.md)** — Tools that are safe to retry. Adds `idempotencyKey` option to tool definitions, `createToolResultCache()` backed by `KeyValueStore`, `withIdempotency()` tool wrapper, and `withToolboxIdempotency()` for bulk wrapping. Key generators: `fullInputKey()` for pure functions, `fieldKey()` for ID-based tools, `compositeKey()` for multi-field tools. Prerequisite for durable execution. All in `packages/armorer/src/idempotency/`.

- [ ] **[Durable Execution](reference/durable-execution.md)** — Checkpoint after every LLM call, tool return, and decision. Survive process crashes and resume from the exact point of failure. Adds `createCheckpointStore()`, 5 checkpoint phases (step-start, generate-complete, tool-execution-complete, step-complete, run-complete), `resumeFromCheckpoint()` for crash recovery, and automatic checkpoint pruning. Requires idempotent tools for safe re-execution after crash recovery. All in `packages/operative/src/checkpointing/`.

## Tier 3: Operational Maturity

- [ ] **[Evaluation Framework](reference/evaluation-framework.md)** — Agent behavior testing. Run agents against golden datasets, measure whether they do the right thing, detect regressions, gate deployments. Adds `createAgentEval()` runner, output matchers (exact, regex, semantic), tool call matching, `EvalReport` with standardized metrics (pass rate, cost, steps, latency), `compareEvalReports()` for regression detection, `createLLMJudge()` for semantic scoring, and `runEvalSuite()` for CI integration. New `packages/evaluation/` package.

- [ ] **[Model Routing](reference/model-routing.md)** — Route tasks to the cheapest model that can handle them. The single biggest cost lever in production. Adds `createRoutingGenerate()` to herald with pluggable strategies: `createComplexityStrategy()` (analyze conversation signals), `createStepBasedStrategy()` (different models per loop phase), `createCostAwareStrategy()` (prefer cheap when budget is low), and `composeStrategies()`. Includes `withRoutingMetrics()` for tracking route usage. All in `packages/herald/src/routing/`.

- [ ] **[Approval Workflows](reference/approval-workflows.md)** — General-purpose human-in-the-loop approval for tool execution. Risk tier classification (`auto`/`notify`/`approve`), `createApprovalHook()` as a `BeforeToolExecutionHook`, pluggable approval handlers (elicitation-based, webhook-based), batch approval for multi-tool steps, and `createAuditLog()` for compliance. All in `packages/operative/src/approval/`.
