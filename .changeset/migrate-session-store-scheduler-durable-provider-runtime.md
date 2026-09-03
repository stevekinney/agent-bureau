---
'@lostgradient/operative': minor
---

Migrate the session, store, scheduler, durable, and provider call sites onto the composed `RuntimeServices` seam (AB-92, delivered by AB-253).

Every remaining non-test source file under `packages/operative/src` — outside the run-path AB-252 already migrated — now reads wall time, monotonic time, timers, identifiers, and randomness through the composed `RuntimeServices` seam rather than a process global:

- `session/session-handle.ts` — `SessionHandleContext` gains an optional `runtime?: RuntimeServices` field. `setTimeoutFunction`/`clearTimeoutFunction` keep their exported names and process-local meaning, but their defaults now resolve from `runtime.timers` rather than `globalThis.setTimeout`/`clearTimeout` directly; an explicitly supplied pair still wins. Every `run()` this session dispatches shares the handle's own resolved runtime unless `runOptions.runtime` is set explicitly, so a session driven by a manual runtime stays deterministic end-to-end.
- `session/create-session-store.ts` — `createSessionStore` takes an optional second `{ runtime? }` argument governing `updatedAt` refreshes and `cleanup({ olderThan })`'s age cutoff.
- `store/store.ts` — `StoreOptions` gains `runtime?`; action timestamps and auto-generated run ids are minted through it.
- `agent-session.ts` — `createAgentSession` gains a `runtime?` option; `createdAt`/`updatedAt` and the default session id come from it.
- `child-run.ts` — `DispatchChildRunOptions` gains `runtime?`; the default `childRunId` is minted through it.
- `scheduler/create-scheduler.ts` and `scheduler/create-heartbeat.ts` — both gain `runtime?`; task/heartbeat ids and idle-delay/backoff timing read it.
- `scheduler/sleep.ts` — `sleep(milliseconds, timers?)` now takes the timer pair directly instead of a process-global override symbol and `Bun.sleep`; omitted, it resolves the real globals.
- `durable/active-run-adapter.ts` — `createDurableActiveRun`, `createRecoveredRunEventSurface`, and `reattachDurableActiveRun` all resolve (or accept) a `RuntimeServices` instance for tool-event timestamps and `totalDuration` measurement. `createActiveRun`'s durable branch now resolves `options.runtime` before routing to the durable path (previously resolved only on the in-memory branch), closing a gap where a durable run never saw a caller-supplied runtime at all.
- `durable/run-workflow.ts` — the two `ctx.memo`-checkpointed wall-clock reads (`deliveredAt`, `firedAt`) now source their first-execution value from the durable routing's own `RuntimeServices.clock` rather than a bare `new Date()`; Weft's own `ctx.memo` replay-determinism boundary is unchanged and untouched.
- `durable/schedule-agent.ts` — `CreateAgentScheduleOptions` gains `runtime?`; the default schedule id is minted through it instead of a hand-rolled UUID generator reaching `crypto`/`Math.random` directly.
- `providers/routing/routing-metrics.ts` — `RoutingOptions` gains `runtime?`; `withRoutingMetrics`'s recorded latencies read it.
- `providers/fallover/create-fallover-generate.ts` — `FalloverOptions` gains `runtime?`; its `now`/`sleep` defaults resolve from it instead of `Date.now`/a process-global sleep-override symbol. An explicitly supplied `now`/`sleep` still wins.
- `providers/gemini.ts` — `GeminiProviderOptions` gains `runtime?`; managed-cache creation and expiry timing read it.

Every call site above omits `runtime` by default and falls back to `createDefaultRuntimeServices()` — the real-globals implementation — so no existing caller's behavior changes. A caller that supplies a `ManualRuntimeServices` (from `@lostgradient/operative/test`) gets a fully deterministic instance across all of these subsystems, including two independent runs in one process with two different manual runtimes never observing each other's clock or identifiers.

Weft's own clock stays an external integration boundary per AB-92 and is neither reached into nor shimmed: `ctx.memo`/`ctx.sleep`/`ctx.waitForSignal` remain Weft's own replay-determinism primitives, unchanged in shape.

Out of scope for this change: the `liveness/` module (AB-214's own clock seam), `providers/selection.ts`, `create-lazy-agent.ts`, and other call sites outside this issue's delivery boundary — each is a migration candidate for a separate slice.
