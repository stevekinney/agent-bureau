---
'armorer': minor
---

Compose the `RuntimeServices` injectable runtime-service seam into `createToolbox` and `ExecutionLifecycle`, and move `nextExecutionId` off module scope (AB-92, delivered by AB-254).

`ToolboxOptions` gains an optional `runtime?: RuntimeServices` field. `createToolbox` resolves `options.runtime ?? createDefaultRuntimeServices()` exactly once, at construction, and snapshots the resolved instance into its own `ExecutionLifecycle` and into every tool it builds, so a toolbox-constructed tool reads wall time, timers, and identifiers through the same composed instance the toolbox itself uses. `createTool`'s own `CreateToolOptions` gains the identical optional field for a tool constructed directly (not via a toolbox).

`createExecutionLifecycle` now accepts a `RuntimeServices` instance as its second parameter, defaulting to `createDefaultRuntimeServices()`. `packages/armorer/src/execution-lifecycle.ts`'s module-level `let nextExecutionId = 0` is gone: execution and call identifiers are minted through `RuntimeServices.identifiers.next('execution')`/`.next('call')` instead, so two `ExecutionLifecycle` instances constructed in the same process — including two toolboxes running concurrently in one test file — no longer share a counter.

Every remaining `Date.now()`, `setTimeout()`/`clearTimeout()`, and `crypto.randomUUID()` call site on `create-toolbox.ts`, `create-tool.ts`, `approval-binding.ts`, `middleware/index.ts`, `utilities/retry.ts`, `idempotency/with-idempotency.ts`, `idempotency/with-toolbox-idempotency.ts`, `integrations/mcp/index.ts`, and `integrations/mcp/oauth.ts` now goes through a resolved `RuntimeServices` instance instead. `IdempotencyOptions`, `WithToolboxIdempotencyOptions`, `RetryOptions` (`utilities/retry`), and `McpOAuthProviderOptions` each gain the identical optional `runtime?: RuntimeServices` field, resolved once at wrap or construction time; a retry backoff and an idempotency lease-renewal timer can both now be driven entirely through `ManualRuntimeServices.advance()`, with no real timer. A handful of standalone utilities not composed from any toolbox or tool (`createToolCall`, `validateApprovalBinding`, `createProcessLocalApprovalStateStore`, the three `middleware/index.ts` factories, and the MCP elicitation-id generator) instead draw from one process-local default `RuntimeServices` instance rather than reaching a real global directly.

`armorer` re-exports `RuntimeServices`, `RuntimeClock`, `RuntimeMonotonic`, `RuntimeTimers`, `RuntimeTimeoutHandle`, `RuntimeIdentifiers`, `RuntimeRandom`, `RuntimeDeferred`, `DeferredDrainReport`, and `createDefaultRuntimeServices()` from its main entry point. `armorer/test` additionally re-exports `ManualRuntimeServices` and `createManualRuntimeServices()` from `lifecycle`, matching the treatment `@lostgradient/operative/test` already receives.

Production callers are unaffected: every existing call site that omits `runtime` behaves exactly as it did on the baseline, backed by `createDefaultRuntimeServices()`'s real-globals implementation.

Out of scope for this change: `@lostgradient/operative` (delivered by AB-252) and `bureau` — each has its own follow-on composition slice. Armorer's MCP lazy-loader caches and `ExecutionLifecycle`'s `inspect`/`abort`/`whenSettled` public semantics are unchanged.
