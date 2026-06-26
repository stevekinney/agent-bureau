# Changelog

## 0.8.1

### Patch Changes

- edaedae: Add regression test for durable cross-process approval round-trip: serializes a signed pending-approval descriptor to JSON, deserializes it in a fresh toolbox instance (simulating a separate process), and verifies the resume executes correctly with re-validation.
- edaedae: Add regression tests for externally-supplied idempotency keys with crash recovery, pinning the at-least-once executor safety contract: a caller-supplied key left in the durable "started" state (driven directly via the cache primitive, decoupled from any thrown-error path) reports unknown-outcome on retry rather than blindly re-running the side effect. A second test pins the thrown-uncategorized-error orphaned-start path explicitly.
- edaedae: Add regression test for OpenTelemetry parent context injection: with a single tracer it pins both halves of the contract — a call with no parentContext forwards `undefined` to `startSpan` (so the OTel SDK applies its own ambient/root context) while a sibling call with a sentinel parentContext forwards that exact value by identity, proving the `undefined` path is a genuine "no parent" decision rather than a shallow default.

## 0.8.0

### Minor Changes

- 5e0c4a9: Add durable approval resume, parent trace context, structured head/tail truncation, and explicit fresh/deduped/unknown idempotency outcomes for at-least-once tool executors.

  Pending approvals can now be signed with a toolbox `approvalSecret`. Approvals created before this release do not have an `approvalToken`, so recreate and re-approve them before resuming. The old `ToolExecuteOptions.approved` and `proposedArguments` policy bypass path has been removed; use `Toolbox.resumeApproval()` with a `SignedPendingToolApproval` instead. Cache keys produced by `withIdempotency()` and caller-supplied toolbox `idempotencyKey` values are now scoped as `toolName:key`; migrate those entries or clear affected idempotency caches before rollout.

- a999732: Add toolbox execution options for parent OpenTelemetry context and span links so instrumented tool spans can attach to orchestrator traces.

## 0.7.1

### Documentation

- **Common Patterns Guide**: Added comprehensive `documentation/patterns/` with practical examples for implementing advanced patterns using existing primitives:
  - Circuit breaker pattern for preventing cascading failures
  - Session management with context and middleware
  - Request deduplication for concurrent identical requests
  - Resource pooling for database connections and API clients
  - Fallback tools for graceful degradation
  - Tool dependency management and execution order
  - Audit trails for compliance and debugging
  - Cost tracking and per-user quotas
  - Conditional execution and multi-way branching
  - State management with persistence
  - Structured logging middleware
  - Streaming responses with events and async iterators

## 0.7.0

### Breaking Changes

- **Armorer → Toolbox Rename**: Complete rename of all Armorer-related APIs to Toolbox for improved clarity:
  - `createArmorer()` → `createToolbox()`
  - `isArmorer()` → `isToolbox()`
  - `combineArmorers()` → `combineToolboxes()`
  - `Armorer` type → `Toolbox`
  - `ArmorerTool` → `Tool`
  - `ArmorerContext` → `ToolboxContext`
  - All related types and interfaces updated accordingly

### Core Runtime Completeness

- **Dry-Run in Composition**: `pipe`, `compose`, `parallel`, `retry`, `when`, `tap`, `bind`, `preprocess`, and `postprocess` now correctly propagate `dryRun` mode to underlying tools.
- **Consistent Tool Identity**: The registry now indexes tools by ID (`namespace:name@version`) instead of just name, resolving collisions when multiple versions or namespaces share a name. `getTool` now accepts ID or name.
- **OpenAI Adapter Naming**: Added `naming: 'safe-id'` option to `toOpenAI` to solve name collisions by using sanitized IDs. Added `createNameMapper` helper to resolve sanitized names back to tool IDs.
- **Policy Outcomes**: Added first-class `action_required` outcome for policy decisions with `status: 'needs_approval'` or `'needs_input'`, and new event `policy-action-required`.
- **API Surface**: Exported `ToolboxExecuteOptions` and ensured `createTool` passes all options (including `outputShaping`, `telemetry`, `diagnostics`) when used with an Toolbox instance.

### Documentation

- **Common Patterns Guide**: Added comprehensive `documentation/patterns/` with practical examples for implementing advanced patterns using existing primitives:
  - Circuit breaker pattern for preventing cascading failures
  - Session management with context and middleware
  - Request deduplication for concurrent identical requests
  - Resource pooling for database connections and API clients
  - Fallback tools for graceful degradation
  - Tool dependency management and execution order
  - Audit trails for compliance and debugging
  - Cost tracking and per-user quotas
  - Conditional execution and multi-way branching
  - State management with persistence
  - Structured logging middleware
  - Streaming responses with events and async iterators

## 0.6.1

- Aligned build output paths with package exports so types and sourcemaps ship under `dist/`.
- Added a tag-driven GitHub Actions release workflow with npm trusted publishing.
- Added release tag/version verification for CI.

## 0.5.0

- Added `armorer/claude-agent-sdk` adapter helpers for Claude Agent SDK MCP tooling.
- Added `createClaudeToolGate` to generate SDK tool allow/deny policies.
- Added `metadata.dangerous` with registry-level `allowDangerous` enforcement.
- Auto-annotated read-only MCP tools with `readOnlyHint`.
