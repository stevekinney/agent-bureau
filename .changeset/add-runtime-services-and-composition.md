---
'@lostgradient/operative': minor
---

Add the `RuntimeServices` injectable runtime-service seam and compose it into the agent-run path (AB-92, delivered by AB-252).

`@lostgradient/operative` re-exports `RuntimeServices`, `RuntimeClock`, `RuntimeMonotonic`, `RuntimeTimers`, `RuntimeTimeoutHandle`, `RuntimeIdentifiers`, `RuntimeRandom`, `RuntimeDeferred`, `DeferredDrainReport`, and `createDefaultRuntimeServices()` — the real-globals implementation — from its main entry point. `@lostgradient/operative/test` additionally re-exports `ManualRuntimeServices` and `createManualRuntimeServices()`, a fully deterministic implementation with explicit `advance(milliseconds)`/`setTime(epochMilliseconds)` time control, `pendingTimers()`, and `outstandingDeferred()` — no real timer anywhere in it.

`RunOptionsBase` and `CreateAgentOptionsBase` both gain an optional `runtime?: RuntimeServices` field. `createAgent` resolves `options.runtime ?? createDefaultRuntimeServices()` exactly once, at agent construction, and passes that same instance into every run the agent starts, so two runs from one agent share one clock while two agents never share one. `createActiveRun` resolves `options.runtime ?? createDefaultRuntimeServices()` exactly once at construction and snapshots the resolved instance into the run; nothing downstream reads `options.runtime` again or falls back to a global. The standalone-run identifier seam AB-214 introduced is rebound onto the resolved runtime's `identifiers.next('run')` (a caller-injected `CreateActiveRunDependencies.identifiers` still takes precedence when explicitly supplied, for backward compatibility).

Every direct read of `Date.now()`, `performance.now()`, `setTimeout()`/`clearTimeout()`, and `Math.random()` on the run path (`create-run.ts`, `create-agent.ts`, `loop.ts`, `run-lifecycle.ts`, `run-step.ts`, `run-envelope.ts`, `retry/jitter.ts`) now goes through the resolved `RuntimeServices` instance instead. `hooks/composition.ts`'s pre-existing, declared-but-unwired timer seam (`TimeoutHandle`/`ScheduleTimeout`/`ClearScheduledTimeout`) is now an alias of `RuntimeServices`'s own timer shapes, and `withTimeout`'s fallback timer functions default to a `RuntimeServices` instance's `timers` rather than a bare `globalThis.setTimeout`/`clearTimeout` call — the exported names are unchanged, so no consumer breaks.

Production callers are unaffected: every existing call site that omits `runtime` behaves exactly as it did on the baseline, backed by `createDefaultRuntimeServices()`'s real-globals implementation.

Out of scope for this change: operative's session, store, scheduler, durable, and provider-adapter call sites; armorer; bureau; and gateway/Cloudflare — each has its own follow-on composition slice.
