# @lostgradient/operative

## 0.9.0

### Minor Changes

- 5c7c55b: Reject `scheduleWakeup` and `requestHumanInput` when no durable run backs them, instead of silently no-oping.

  Both tools previously wrote their pending slot and returned `{ scheduled: true }` / `{ parked: true }` unconditionally, even in an in-memory run with no durable engine attached — a success-shaped result for a park that never happened. Per AB-41's ratified decision record, `ScheduleWakeupContext` and `RequestHumanInputContext` now carry a required `durable: boolean` signal; `execute` throws a new `DurableCapabilityUnavailableError` (`code: 'DurableCapabilityUnavailableError'`, `category: 'unavailable'`, `retryable: false`) instead of mutating the context or dispatching a park event when `durable` is `false`. The thrown error satisfies Armorer's `isToolError` guard directly, so a standalone `createAgent` toolbox surfaces a `ToolExecutionResult` with `error.category === 'unavailable'`.

  `@lostgradient/bureau`'s `requestHumanInput` composition (`humanInput: true`) already omits the tool from a run's effective toolbox whenever no durable engine is attached — this release makes that the documented preference, and threads `durable: true` into the context it constructs so a real durable run (ephemeral `MemoryStorage`-backed or persistent) keeps parking exactly as before. `scheduleWakeup` has no Bureau composition wiring today, so only its factory-level rejection is exercised in production; wiring it into Bureau is out of scope for this change.

- bbfe517: A toolbox-level, per-call `failFast` budget rejection now sets `run.completed`'s `finishReason` to `'budget-exceeded'` instead of falling through to `'error'` (AB-231, ratifying AB-87's `ToolboxBudgetExceededEvent` reconciliation decision). Previously armorer's `checkBudget` path threw a generic `ToolError` stamped `code: 'BUDGET_EXCEEDED'` — armorer sits below operative in the dependency graph and cannot construct or throw operative's `BudgetExceededError` directly — so the rejection reached the run layer only as a generic `tool.error`, with the budget-exceeded semantics lost at the `finishReason` classification site.

  A thrown armorer `ToolError` is now re-classified as a `BudgetExceededError` upstream of `makeErrorResult`'s `instanceof` check only when it carries armorer's new `TOOLBOX_BUDGET_EXCEEDED_MARKER` provenance marker (see the companion `armorer` changeset) — not merely a matching `code: 'BUDGET_EXCEEDED'`, since a tool's own `execute()` can throw an error whose `code` coincidentally normalizes the same way without being a toolbox-accounting rejection at all. Every other tool error, including a tool-defined one with that same code, is unaffected.

  `BudgetExceededError` now also accepts an optional second `cause` argument, and the reclassification site passes the original armorer `ToolError` through as that cause — so `RunResult.error`, `onRunError`, and `serializeAgentRunError` still expose its underlying `code`/`category`/`retryable` diagnostics after reclassification, matching what `toAgentRunError` already preserves for every other generically-wrapped tool error.

- 64a6c31: Track and await scheduler, chunked-task, and heartbeat callback promises (AB-208), closing the last unowned-background-work gap from the AB-37 cancellation-and-shutdown decision record.

  `Scheduler.stop()` now tracks every `onComplete`/`onPreempted` callback promise a task returns and awaits it in the same `Promise.allSettled` pass it already runs for durable cancellations, instead of firing the callback with `void`. A stopped scheduler is therefore a real boundary for anything the callback closes over (credential-scoped `services`, for example) rather than a best-effort signal. A callback rejection that lands after the owner stopped no longer becomes an unhandled promise rejection: it is captured and reported as its own `task.failed` event.

  `createChunkedTask`'s `onComplete`/`onError` callbacks are likewise awaited — before `submitChunkedWork`'s own returned promise resolves on the success path, and before it rejects on the failure path — instead of being fired with `void`.

  `createHeartbeat(...).stop()` changes from `stop(): void` to `stop(): Promise<void>` (a breaking type change on this one method) — it now resolves only after the in-flight `tick()`, and its tracked `onTick` callback promise, settle. Calling `stop()` when nothing is in flight (never started, or already stopped) is a no-op that resolves promptly.

  `Bureau.dispose()`/`Bureau.shutdown()` awaiting `scheduler.stop()` or `heartbeat.stop()` is a separate, already-tracked follow-up (AB-38's `can-03` slice) — out of scope here.

- accf4a2: Emitted AB-67's steering event family (AB-90/AB-221). `packages/operative/src/events.ts` gains five new event classes, exported and added to `OperativeEventMap`:

  - `SteeringAppliedEvent` (`steering.applied`) — dispatched by `runStep` at the AB-67/AB-198 boundary (entry of `runStep`, immediately after the abort check and before backpressure) the moment an accepted command's `configVersion` is first observed there. Fires at most once per distinct `configVersion` a run observes, never once per step — deduplicated via a new `RunState.lastAppliedConfigVersion` field (threaded across a durable checkpoint boundary via `RunCursor.lastAppliedConfigVersion`, mirroring `schemaAttempts`). The check runs after every boundary read, including inside the pause-wait loop's re-reads — not only once after the loop exits — so a `pause` command itself fires its own `steering.applied` (per AB-67's pause row: "applied at the boundary"), distinct from the `resume` that later releases the step. Carries `sessionId` (read from the new `SteeringGate.sessionId` field — required, since `SteeringDesiredState`/`SteeringEffectiveState` carry no `sessionId` of their own) and the exact `SteeringEffectiveState` the boundary stamped. Never fires for `configVersion === 0` (the un-steered default) or when the run has no `runId` to stamp `appliedAtRunId` with. Cursor-advancing, per AB-87's AC5 resolution.
  - Dedupe is per-run only: a session whose `configVersion` a prior run already applied is re-observed and re-fired by a fresh run starting at `lastAppliedConfigVersion: 0`. Deduping across runs on the same session needs the `SteeringGate` implementation itself to remember what it has applied — that is AB-199's responsibility (`submitSteeringCommand`'s `SteeringGate`), not this boundary's.
  - `SteeringAcceptedEvent` (`steering.accepted`), `SteeringRejectedEvent` (`steering.rejected`), `SteeringSupersededEvent` (`steering.superseded`), and `SteeringFailedEvent` (`steering.failed`) — exported and added to `OperativeEventMap` for Bureau's `submitSteeringCommand` admission surface (AB-199, Backlog) to dispatch against. This package does not dispatch them itself; it owns only the `runStep` boundary transition.

  `SteeringGate` (an existing exported interface from AB-198) gains a required `sessionId: string` field.

  No `SteeringRequestedEvent` exists: AB-67's `requested` state is never persisted or dispatched standalone (admission is synchronous validate-then-accept-or-reject).

- 62de4e0: Adopted `@lostgradient/weft` 0.23.1 across the durable run layer.

  - Replaced the local `AnyRunEngine = Engine<any, any>` erasure (and its explicit-`any` lint suppression) with weft's own package-root `RegistryAgnosticEngine` type. Production code no longer casts an engine to `any` or to `RegistryAgnosticEngine` — `Engine.create({ workflows })`'s result is directly assignable to the new type.
  - Added a host-configurable `ownership` option to `createRunEngine` (`CreateRunEngineOptions.ownership`), defaulting to `'none'` — today's behavior is unchanged. Passing `'workflow-lease'` lets more than one engine safely share a durable store: weft fences each workflow to exactly one engine before its generator runs, so a second engine racing to resume the same workflow fails closed (`WorkflowClaimUnavailableError`) instead of double-executing it. Requires a storage backend with the `conditionalBatch` capability (`MemoryStorage` and `SQLiteStorage` both qualify).
  - Added `workflowClaimTtlMs`/`workflowClaimRenewIntervalMs` passthrough options for tuning `'workflow-lease'` claim timing.
  - **Known limitation:** a weft 0.23.1 defect makes `ownership: 'workflow-lease'` incompatible with the scheduler's suspend/resume preemption path (`createScheduler`'s `suspendAndDetach` → `resumeDurableRunResult`) — `engine.suspend()` releases a workflow's claim as a side effect of reusing weft's terminal-commit code path, so a same-engine `engine.resume()` right after throws instead of re-acquiring. Do not enable `'workflow-lease'` on an engine a preempting scheduler attaches to until this is fixed upstream. This is why `'workflow-lease'` is opt-in rather than the new default.

  **Breaking for consumers with an existing durable store:** weft 0.23 advances its persisted-data schema from version 1 to version 2 with no in-place migration — a store written by weft 0.22.x or earlier is rejected with `PersistedDataIncompatibleError` when opened under this release. Plan a cutover (new store, or an offline migration) before deploying.

- be5cf8b: BREAKING (released as a minor under 0.x convention): Make `createSubagentTool`'s input and output projections directional and type-safe (AB-19).

  `createSubagentTool` now accepts `agent: RunnableAgent<TOutput, THasOutput>` instead of a promise-returning `run` callback — `createAgent`'s returned agent satisfies this directly, with no adapter. `agentName` is retained as a separate option that names the child independently of any identity the agent object carries; it is passed verbatim to `agent.run(input, { agentName, signal, traceContext, withTraceContext })`, so a real `createAgent` child always receives the parent tool call's abort signal, plus this new `withTraceContext` option. `traceContext` propagates only when the toolbox executing the tool was itself constructed with a matching `context: { traceContext }` — the ordinary `createAgent`-driven agent loop does not populate a tool's `traceContext` from the run's own trace context today; pass `withTraceContext` directly on `createSubagentTool`'s own options to wrap the child's run in the parent's trace context regardless.

  `mapInput` is renamed `toAgentInput`: it receives the tool's parsed, Zod-validated arguments (not `unknown`) and returns `AgentInput` (a string, or `{ conversation }` to resume an existing `ConversationHistory` under `createAgent`'s snapshot semantics). `mapOutput` is renamed `toToolOutput`: it is a pure projection over a successful `SuccessfulRunResult<TOutput, THasOutput>`, never invoked for a non-success terminal, and may return synchronously or via a `Promise`. Omit `toToolOutput` for a schema-less child and the tool returns a plain string (`result.content`), matching the prior default.

  Every non-success terminal — abort, execution error, tripwire, budget exceeded, elicitation denied, maximum steps, or a clean stop whose output failed schema validation — now rejects with the new `SubagentRunError` (`kind: 'tool'`, code `SUBAGENT_RUN_FAILED`), which carries the child's full terminal `RunResult` as `.result`. `treatMaximumStepsAsError` is removed with no replacement: every non-success terminal always rejects.

  New exports from this issue: `SubagentRunError`, `SuccessfulRunResult`, and `isSuccessfulRunResult`. `agent` is typed against the canonical `RunnableAgent`/`AgentInput`/`AgentRunContext` AB-21 introduced (`RunnableAgent<TOutput, THasOutput>` from `./runnable-agent`, requiring `readonly name: string`) rather than a separate local copy — `createAgent`'s returned agent already satisfies it, `name` included.

  AB-70's `summaryAssetPolicy` amendment to this issue — controlling how non-text `parts` are represented in a capped summary — is deferred to AB-73, which introduces the `parts` field on `RunResult` this amendment depends on; it is not implemented here.

  **Migration**: rename `run` to `agent` (pass a real `RunnableAgent`, e.g. `createAgent`'s result, rather than a callback), rename `mapInput` to `toAgentInput`, rename `mapOutput` to `toToolOutput`, and remove any `treatMaximumStepsAsError` usage. A caller matching on thrown error message text should match on `SubagentRunError` and its `.result.finishReason`/`.result.error` instead.

- eadf777: BREAKING (released as a minor under 0.x convention): Replace `RunOptions.responseSchema`/`responseJsonSchema` and the non-Zod Standard Schema / raw JSON Schema structured-output paths with one Zod `output` contract (AB-18).

  `RunOptions.output` (also `CreateAgentOptions.output`) now accepts only a Zod schema. There is no more Standard Schema input, raw JSON Schema input, or per-run response-format override — a caller holding a raw JSON Schema or a non-Zod validator must convert it to a Zod schema first. The provider-facing JSON Schema is now derived with Zod's own `z.toJSONSchema(schema, { io: 'input' })` (via the exported `toOutputJsonSchema`) instead of a hand-rolled wrapper; an unrepresentable schema throws a synchronous `OutputSchemaConversionError` with no generic-object fallback.

  Validation now distinguishes two failure shapes: `OutputValidationError` (carrying the underlying `ZodError`'s `issues`) when the model's final text was valid JSON but didn't satisfy the schema, and `NonJsonOutputError` when the final text wasn't valid JSON at all (including when it still fails a schema of exactly `z.string()`). `StandardSchemaValidationError` is removed with no alias. The new `validateOutputValue(schema, candidate)` export validates an already-decoded candidate (a durable checkpoint's persisted `output`, or a provider that returns a decoded object instead of text) against the recursive JSONValue contract before the schema.

  An `output` schema must not declare a field intended to carry binary or media content (the AB-70 amendment to this issue) — a generated asset a run produces belongs in `RunResult.parts` as a managed-asset reference, never inlined as base64 inside `output`.

  **Migration**: rename `responseSchema` to `output` everywhere it's a Zod schema. A raw JSON Schema or non-Zod Standard Schema `responseSchema` has no direct replacement — author (or convert) the contract as a Zod schema instead. `responseJsonSchema` is removed with no replacement.

- 7d0b3a1: Applied AB-67's coordinator amendments (2026-09-02) to the runtime steering types exported from `@lostgradient/operative/durable`:

  - `SteeringCommandFailure` gains `readonly supersededBy?: string`, the `id` of the successor command, present exactly when `reason` is `'superseded-by'`.
  - Every `SteeringRequestedValue` variant is encoded as an exclusive `policyRef`/`override` pair — `{ target: T; policyRef: string; override?: never } | { target: T; override: V; policyRef?: never }` — instead of two same-discriminant variants, so a literal supplying both fields, or neither, is rejected by the type checker. The runtime admission check that exactly one is present stays as defense in depth.
  - `SteeringCommand` gains `readonly runId?: string`, binding a `pause`/`resume` command to a session's non-terminal run; `SteeringCommandFailure.reason` gains `'run-ambiguous'` for when `runId` is absent and the session has zero or more than one non-terminal run.

  This narrows and extends an unreleased-in-a-tagged-version export's public type — no published version of `@lostgradient/operative` has shipped the wider `SteeringRequestedValue` shape — but it is still a public type change against the types AB-197 exported, hence the minor bump. Type-only: no runtime behavior is added or changed by this release.

- 13d451e: Add `dispatchChildRun` — the lower-level child dispatch primitive (AB-50) `createSubagentTool` is now built on top of. It returns a `ChildRunHandle` carrying `childRunId`, `parentRunId`, and `agentName` alongside `AgentRun`'s own async-iterate / `result()` / `abort()` / `[Symbol.dispose]()` surface, so code that dispatches a subagent directly — not only through a tool — can retain a typed handle and hold two (or more) concurrently dispatched children independently addressable: aborting or iterating one never touches another.

  `dispatchChildRun` composes a private per-child `AbortController` with any parent signal it's given, so a parent abort and a child-targeted abort both stop the child, and emits four correlated lifecycle events on the supplied emitter — `ChildWorkflowStartedEvent` (existing, now carrying a `childRunId`), and the new `ChildWorkflowCompletedEvent`, `ChildWorkflowFailedEvent`, and `ChildWorkflowAbortedEvent` — each stamped with `parentAgentName`, `parentRunId`, `childAgentName`, and `childRunId`.

  `createSubagentTool` is reimplemented on top of `dispatchChildRun` with no change to its existing call sites or to AB-64's summary-isolation guarantee: the model-facing tool still awaits exactly one terminal mapped result, and `parentContext` (emitter, parent identity, durability) remains entirely optional.

  `AgentRun.children()` / `.abortChild(childId, reason?)` — the signatures `documentation/operative-type-safe-api.md`'s started-work control contract assigns to AB-50 — ship as real methods on `AgentRun` and `DiagnosticAgentRun`, backed by an opt-in `ChildRunRegistry` (`createChildRunRegistry()`). Supply the same registry to `createAgentRun`'s new `childRegistry` option (or `RunnableAgent.run()`'s `AgentRunContext.childRegistry`) and to a `createSubagentTool`'s `parentContext.registry` to make that run's children discoverable — including a child never returned to any caller — through `children()`, and cancelable, scoped to that one child and idempotent on an unknown or already-terminal id, through `abortChild()`. Omit the registry on either side and both read as safe no-ops rather than throwing.

  `documentation/operative-type-safe-api.md` and `scripts/documentation-examples.test.ts` are updated to match: the `children`/`abortChild` entries are removed from the doc test's `PENDING_IMPLEMENTATION` map, the `AgentRun`/`DiagnosticAgentRun` fenced types gain the real signatures plus a `ChildRunDescriptor` type, and the classification table's Agent run and Diagnostic run rows record the shipped discovery/cancellation mechanism instead of the open question.

  Review fixes folded into this same unreleased surface: `abort()` now forwards to the live `agentRun.abort()` as well as the private controller, so a `RunnableAgent` that cancels only through its own `abort()` (never observing the composed `AbortSignal`) still stops; `ChildWorkflowAbortedEvent.reason` now reads the composed signal instead of only the private controller's, so a parent-propagated abort reports its actual reason instead of `undefined`; `children()` returns a frozen clone of each descriptor so a caller mutating one can never corrupt the registry's own control state; a synchronous throw from `agentRun.result()` (not only a rejected promise) now settles the registry and emits `ChildWorkflowFailedEvent` instead of leaving the entry stuck `'running'` forever; and `createDiagnosticAgentRun(activeRun, { childRegistry })` accepts the same opt-in registry `createAgentRun` does, so a recovered run can back real child discovery too.

- ca8c781: Exported the AB-67 runtime steering contract's type-only surface: `SteeringCommand`, `SteeringTargetKind`, `SteeringRequestedValue`, `SteeringCommandState`, `SteeringCommandFailure`, `SteeringDesiredState`, and `SteeringEffectiveState` (from `@lostgradient/operative/durable`), alongside AB-42's session-input types. No runtime behavior is attached — `submitSteeringCommand`, the `runStep` boundary read, and `GenerateContext` threading are implemented by later issues.
- fad8401: Implemented AB-67's `runStep` boundary read: model/provider/route/effort/pause/resume steering now applies at the entry of `runStep`, immediately after its existing abort check and before backpressure — the single point both the in-memory `executeLoop` driver and the durable `run-workflow.ts` driver reach once per step.

  - `RunOptions` gains an optional `steering?: SteeringGate` field. `SteeringGate` is a new exported interface — `getDesiredState(): SteeringDesiredState` and `awaitResume(signal?: AbortSignal): Promise<void>` — the contract a caller (e.g. Bureau's `submitSteeringCommand` admission path) implements to supply the session's real desired steering state and resolve on the accept side of a `resume`. `runStep` passes its own step `AbortSignal` into `awaitResume` so a real implementation can drop a registered waiter on abort instead of leaking it. Omitting `steering` leaves `runStep` behaving exactly as it does today, with no thrown error.
  - `buildStepDeps` threads `RunOptions.steering` into `StepDeps.steering`, reachable by both the in-memory driver and the durable driver (via `DurableRunDeps.options: RunOptions`) with no duplicated construction logic.
  - A `paused: true` desired state at the boundary blocks the step until a matching `resume` releases it OR the step's own `AbortSignal` fires, whichever comes first; on abort, the step resolves with the identical `{ kind: 'abort', ... }` shape an unpaused abort already produces.
  - `GenerateContext` and `BeforeGenerateContext` gain a `steering?: SteeringDesiredState` field carrying the session's desired route/model/provider/effort, populated at the boundary read and re-applied after any `beforeGenerate` hook returns a replacement context — the field is not hook-overridable.
  - `createRoutingGenerate` consults `GenerateContext.steering.route` for a route override, taking priority over its `strategy(context, routes)` read, and its doc comment names the pattern a non-routing provider factory (`createAnthropicProvider` and siblings) must follow to honor a `model`/`provider`/`effort` steering override.

  `policyRef` resolution and override-against-catalog validation are out of scope (AB-66, AB-65); a `route`/`model`/`provider`/`effort` `override` is honored as given.

- 6dcb8c9: Resume agent reasoning after a durable `scheduleWakeup` timer fires, instead of the timer merely delaying terminal completion.

  Per AB-41's ratified decision record, the durable `agentRun` workflow now continues the same run with one more agent generation step once `ctx.sleep(duration)` resolves, seeded by a deterministic `[wakeup] Resumed after sleeping {duration}. Note: {note}` conversation message — never merely delaying terminal completion. A `scheduleWakeup` tool call now commits its step and parks before another generation call can run without the wakeup (previously the loop could run additional generation calls before the post-loop park block was ever reached, mirroring the same fix AB-44 made for `requestHumanInput`). Re-parking from within the continuation step is supported: if it itself calls `scheduleWakeup` again, the workflow parks again rather than returning. The final `AgentRunWorkflowResult` is produced only after the resumed agent reaches a normal terminal condition — a fired wakeup alone never finalizes a pre-wakeup result. Persistent recovery re-arms the same `ctx.sleep` timer and executes the continuation exactly once, including when recovery observes an already-passed deadline (a "late" timer) — Weft's own checkpointed `ctx.sleep` makes this correct with no additional bookkeeping.

  `packages/operative/src/durable/continuation-input.ts` gains `WakeupContinuationInput` (AB-41's ratified shape: `kind`, `firedAt`, `requestedDuration`, `note?`), `buildWakeupContinuationInput`, `renderWakeupContinuation`, and a shared `renderDurationLabel` helper (also used by `scheduleWakeup`'s own tool-result message), all re-exported from `@lostgradient/operative/durable`.

  `AgentRunWorkflowResult.wakeupNote` now reports the note from the LAST `scheduleWakeup` park the run genuinely slept on and woke from as a historical fact, persisting across the run's eventual termination — mirroring `humanWaitSignal`'s contract exactly — rather than only appearing when a wakeup happened to still be pending (unconsumed) at return time, which is no longer reachable once a park always continues the run. `create-schedule-wakeup-tool.ts`'s documentation is updated to describe the continuation behavior instead of "surfaced to the next run."

- 116008c: Implemented AB-232: `run-step.ts`'s manually iterated `beforeGenerate` and `afterGenerate` hook waterfalls now honor `HookRegistry`'s registry-level `onError` fallback instead of bypassing it.

  - `lifecycle`'s `HookRegistry` gains a public `onError` getter that exposes the registry-wide error handler passed to its constructor — the same fallback `run()` already applies internally when a handler has no per-registration `onError`. No second code path was added to `run()`; the getter simply reads `registryOptions.onError`, documented in the lifecycle README.
  - Both the `beforeGenerate` and `afterGenerate` waterfalls in `packages/operative/src/run-step.ts` now wrap each manually invoked handler in a try/catch that resolves `entry.options.onError ?? hooks.onError` — the identical precedence `HookRegistry.run()` uses — and either skips to the next handler (`'continue'`), rethrows (`'abort'` or no configured handler), matching `run()`'s behavior exactly.

- f173567: Resume agent reasoning with a delivered `requestHumanInput` signal payload, instead of discarding it.

  Per AB-41's ratified decision record, the durable `agentRun` workflow now captures the value `ctx.waitForSignal()` returns and continues the same run with one more agent generation step, seeded by a deterministic `[signal:{name}] {payload}` conversation message — never merely unparking into an immediate return. A `requestHumanInput` tool call now commits its step and parks before another generation call can run without the requested input (previously the loop could run additional generation calls before the post-loop park block was ever reached). Re-parking from within the continuation step is supported: if it itself calls `requestHumanInput` again, the workflow parks again rather than returning. The final `AgentRunWorkflowResult` is produced only after the resumed agent reaches a normal terminal condition — a delivered signal alone never finalizes a pre-signal result.

  A new `packages/operative/src/durable/continuation-input.ts` module (re-exported from `@lostgradient/operative/durable`) owns the deterministic rendering: `SignalContinuationInput`, `buildSignalContinuationInput`, `isDeniedSignalPayload` (the AB-46-ratified `{ __abDenied: true, reason?: string }` denial sentinel, rendered as `[signal:{name}] denied: {reason}`), and `renderSignalContinuation`, which defensively falls back to a fixed `[unserializable payload]` placeholder rather than crashing the workflow body when `JSON.stringify` cannot render a delivered payload.

  `AgentRunWorkflowResult.humanWaitSignal` now reports the last signal the run genuinely parked on and was released for as a historical fact, persisting across the run's eventual termination rather than only appearing when the run happened to still be "parked" at return time. `SessionHandle.signal()`'s documentation is updated to describe the continuation behavior.

- 575fd4a: Applied AB-42's coordinator amendments (2026-09-02) to the session-input admission types exported from `@lostgradient/operative/durable`:

  - `SessionInputRecord` and `SessionInputAdmissionRequest` now take `TPayload extends SessionInputPayload = SessionInputPayload` (a bounded generic) instead of an unbounded `TPayload = SessionInputPayload`. An explicit type argument can narrow the payload but can no longer widen it past the admissible union.
  - `SessionInputPayload` narrows from `string | ReadonlyArray<MultiModalContent>` to `string | ReadonlyArray<UserAdmissibleContent>`, a new exported type that explicitly allowlists `TextContent` (with `citations` structurally forbidden via `citations?: never`, not merely omitted), `ImageContent`, and `DocumentContent` — not an `Exclude<>` blacklist, since `conversationalist` is consumed at a `^` semver range and a blacklist would silently admit any new content-block kind a future compatible release adds. Session input represents what a user submits; every excluded kind (`thinking`, `redacted_thinking`, `server_tool_use`, `web_search_tool_result`, the `ServerToolResultType` discriminants, `container_upload`, and response-only `citations` metadata) is rejected, discarded, or misattributed by provider adapters if replayed as user input.
  - `SessionInputConflict.reason` gains `'id-owned-by-other-principal'` for the case where a different principal submits a session-input `id` that already exists in the session.

  This narrows an unreleased-in-a-tagged-version export's public type — no published version of `@lostgradient/operative` has shipped the wider `SessionInputPayload` — but it is still a public type change against the types AB-193 exported, hence the minor bump. Type-only: no runtime behavior is added or changed by this release.

- 972f745: Add `createLazyAgent` — type-preserving lazy loading for a whole `RunnableAgent` (AB-21), the agent-level counterpart to `createLazyGenerate` (AB-20).

  `createLazyAgent(loader, options?)` accepts a loader that returns (or resolves to) a `RunnableAgent<O, H>` — or, per AB-15's `AgentModule<O, H>`, the raw `import(path)` module-namespace shape (`{ default: RunnableAgent<O, H> }>`), unwrapped automatically — and returns a `RunnableAgent<O, H>` itself, the same shape as an eager `createAgent()` result, so it slots into an `AgentDefinitions` map without unwrapping. A named (non-default) export is still selected by the caller inside the loader (`() => import('./agent').then((m) => m.agent)`); there is no selector overload.

  `run()` remains synchronous even before the underlying agent has loaded: it returns an `AgentRun` handle immediately, buffering events emitted before resolution — deferred until a consumer actually starts iterating, so a `result()`-only caller never subscribes to the underlying event stream at all — and delegating `result()`/`unwrap()`/`output()` to the real handle once it exists. `input` and `context` are both snapshotted synchronously at `run()` call time, matching `createAgent`'s own snapshot semantics. Each `run()` call owns an isolated `waiting → started → terminal` cancellation state — `abort()` before resolution completes means the underlying agent's own `run()` is never called (including when the underlying agent races the abort synchronously inside its own `run()`, in which case the handle it returned is disposed rather than left running); `abort()` after resolution forwards to the real handle exactly once, and `context.signal` (already passed straight through to the underlying agent's own `run()`) stops being separately forwarded by the wrapper once started, so a compliant agent's own signal handling isn't duplicated.

  The first successful load is cached and shared across concurrent `run()` calls, and a failed load clears only that pending load so a later `run()` retries — mirroring `createLazyGenerate`. A loader failure surfaces `AsyncDefinitionLoadError` (kind `'load'`); a resolved value that isn't a valid `RunnableAgent`, or a `run()` return value that isn't a valid `AgentRun` (missing `result`, `unwrap`, `abort`, iteration, or `[Symbol.dispose]`), surfaces the new `AgentContractError` (kind `'contract'`, code `'INVALID_AGENT_HANDLE'`) instead — not retried, since the load itself succeeded. An abort during loading settles immediately (a hung or slow loader never blocks cancellation) without starting the underlying agent; the returned event stream rejects a second concurrent or post-completion iteration with `CompletedRunIterationError`, matching `AgentRun`'s own contract; and an underlying `result()` that rejects (rather than the documented always-resolves contract) is folded into an error `RunResult` instead of hanging the wrapper forever. Every synthetic result gets its own `usage` object rather than sharing one mutable singleton.

  This also adds the underlying public types this issue and its predecessors describe (`AgentInput`, `AgentRunContext`, `RunnableAgent`, `OPERATIVE_RESOLVE_RUN_OPTIONS`) and a matching `[OPERATIVE_RESOLVE_RUN_OPTIONS]` capability on `createAgent`'s returned agent, so a durable engine can resolve the same `RunOptions` bag `run()` would build without invoking the in-memory `run()` handle.

  `createAgent`'s returned agent now also structurally satisfies `RunnableAgent<O, H>`: `CreateAgentOptions` accepts an optional `name` (defaulting to `'(agent)'`), the returned object carries it as `readonly name`, and `run()` accepts an optional second `AgentRunContext` argument — `signal` becomes per-run `RunOptions.signal`, `agentName` overrides the stamped agent name, `traceContext` becomes `RunOptions.parentContext`, and `withTraceContext` forwards unchanged. Both additions are non-breaking.

- c764938: Export `SessionInputDeliveryMode`, `SessionInputPayload`, `SessionInputRecord`, `SessionInputAdmissionRequest`, `SessionInputReceipt`, `SessionInputConflict`, `SessionInputAdmissionOutcome`, `SessionInputState`, `SessionInputPromotion`, and `SessionInputFailure` from `@lostgradient/operative/durable`.

  These are the request, receipt, and state-transition shapes AB-42's ratified decision record fixes for session-input admission (`submitSessionInput`, illustratively named) — a fourth Bureau session verb alongside `signalSession`, `updateSession`, and `querySession`. This is a type-only addition with no runtime behavior: no `submitSessionInput` implementation ships in this release, and `SessionInputSnapshot` is not exported here (AB-88 owns building it).

  `documentation/operative-type-safe-api.md` gains a new "Session input admission" section carrying AB-42's type sketches and contract decisions verbatim, plus the four amendments AB-42's decision record specifies: the "AB-42 is the first exception" paragraph after the idempotency-key discussion, the updated _Not decided_ idempotency-key paragraph, a new classification-table row for session input, and the widened Session-row scope for AB-50's child discovery.

### Patch Changes

- 27e5e22: Pass the run's abort signal to the Anthropic SDK as request options instead of a body field, so `run.abort()` cancels the upstream HTTP stream and a streaming run blocked on its next chunk resolves with `finishReason: 'aborted'`. Adds the `AnthropicRequestOptions` type; `AnthropicClient` and `AnthropicStreamingClient` implementations now receive it as the second argument of `messages.create`.
- Updated dependencies [5739368]
- Updated dependencies [0e00f2b]
- Updated dependencies [bbfe517]
  - armorer@2.2.0

## 0.8.0

### Minor Changes

- 959d925: Classify session sleep and monitor timers as process-local and support aborting them without leaking timers.
- 72bf623: Expose tool-call stream events while the provider response is still open.

  `withEnhancedStreaming` gains a `liveToolCalls` option that installs a new optional `StreamingHandle.report` channel, letting a `StreamingGenerateFunction` push structured events through mid-response rather than only text. The Anthropic and OpenAI streaming adapters report through it as the provider emits, so `stream:tool-call-start` and `stream:tool-call-delta` reach a host before the response closes instead of being reconstructed from the resolved `GenerateResponse` afterwards.

  Additive and off by default: existing consumers see unchanged event timing and payloads, and a streaming function that reports nothing falls back to the reconstruction. Reporting is per call rather than all-or-nothing — a function that reports only some of its tool calls still gets the reconstructed sequence for the rest.

  Also exports the `LiveStreamEvent` type and adds a `set-block-tool-name` variant to `StreamCommand`, which reconciles a block started before its tool name was known against the name the resolved response supplies.

## 0.7.0

### Minor Changes

- ca25ea3: Replace `AnthropicClient`/`AnthropicStreamingClient`'s `Record<string, unknown>` request parameter with a named `AnthropicMessageCreateRequest`, and remove the `as unknown as` cast that shape forced at both SDK construction sites.

  This narrows the structural type of the `client` you may pass as `options.client` to `createAnthropicProvider`/`createAnthropicProviderStream`. It is a compile-time break for anyone who constructed a hand-rolled client against the old `Record<string, unknown>` parameter, released as a minor under pre-1.0 semver rather than as a major, so that `@lostgradient/operative` does not declare a stable 1.0 surface ahead of schedule. There is no runtime break: the emitted HTTP request is byte-for-byte unchanged, and every shipped caller in this repository compiles without modification. Pin an exact version if you depend on a hand-rolled Anthropic client and cannot absorb a type change on a minor bump.

  - `messages.create`'s parameter is now `AnthropicMessageCreateRequest`: `model`, `messages`, and `max_tokens` are required; every other field the real `@anthropic-ai/sdk` `MessageCreateParamsBase` accepts (`cache_control`, `container`, `inference_geo`, `metadata`, `output_config`, `service_tier`, `stop_sequences`, `stream`, `system`, `temperature`, `thinking`, `tool_choice`, `tools`, `top_k`, `top_p`, `user_profile_id`) is declared optional and widened to `unknown`, plus a `signal?: unknown` field that has no SDK counterpart — `providers/anthropic.ts` folds `context.signal` into this same body object, and that pre-existing behavior is preserved unchanged. A hand-rolled client implementing `create(params: Record<string, unknown>)` no longer satisfies `AnthropicClient`; a custom `create` must accept (at least) the named required fields.
  - `AnthropicStreamingClient.messages.create` now returns `AsyncIterable<AnthropicStreamEvent> | Promise<AsyncIterable<AnthropicStreamEvent>>` rather than a bare `AsyncIterable<AnthropicStreamEvent>`. The promise arm is required because the real SDK's streaming overload returns an `APIPromise` — a `Promise`, not itself iterable — so a bare-iterable return type was never satisfiable by a real `Anthropic`. The bare-iterable arm is retained so a hand-rolled or mock client that returns its generator synchronously stays valid; narrowing to promise-only would break `for await (const event of client.messages.create(params))` against such a client. `createAnthropicProviderStream` awaits the result, which is a no-op on the non-promise arm.
  - `AnthropicMessageResponse.stop_reason` and its `usage.cache_creation_input_tokens`/`usage.cache_read_input_tokens` fields now allow `null` in addition to being optional, matching the real SDK's `Message`/`Usage` types, which declare them nullable rather than merely optional. This is a widening for readers, not a narrowing.
  - `createMockAnthropicClient`/`createMockAnthropicStreamingClient` from `@lostgradient/operative/providers/test` keep their existing runtime behaviour: the streaming mock still returns its async generator synchronously and still throws queued errors synchronously, so direct `for await` over the mock is unaffected. Only the `_calls` array is retyped, from `Record<string, unknown>[]` to `AnthropicMessageCreateRequest[]`.

  No behavior change to the emitted HTTP request: every field the provider was already setting on the request body is still set the same way, through the same bracket-notation assignments. `AnthropicMessageCreateRequest` is exported alongside the existing Anthropic types from both `@lostgradient/operative/providers` and the `@lostgradient/operative/anthropic` subpath.

  `anthropic-client-assignability.test-d.ts` (a type-only, coverage-inert `.test-d.ts` file that `tsconfig.build.json` excludes from published declarations) asserts a real `Anthropic` satisfies both interfaces with no cast, following the pattern `anthropic-token-counting-assignability.test-d.ts` established for AB-167.

- 5454047: Raise the declared Bun floor from `>=1.3.13` to `>=1.4.0`.

  The repository now pins Bun 1.4.0 everywhere it builds and tests: `packageManager`, both
  CI jobs, the release workflow, and the Dockerfile. Continuing to advertise `>=1.3.13`
  would leave a claim that no gate re-verifies on any pull request, which is the failure
  mode AB-169 exists to close. The declared floor now matches the only version actually
  tested.

  Released as a minor rather than a major because `engines` is advisory: npm and Bun warn
  rather than fail unless a consumer opts into strict engine checking. No runtime, type, or
  API surface changed in any of these packages.

  Consumers still on Bun 1.3.x should upgrade or pin an exact version. The full suite did
  pass under 1.3.13 at the time of this change, so the raised floor states what is
  supported going forward rather than a known incompatibility.

  The same floor was raised on the eight private workspace packages (`bureau`,
  `cloudflare`, `evaluation`, `gateway`, `interoperability`, `lifecycle`, `memory`,
  `skills`) for internal consistency. Those are unpublished, so they carry no changeset.

### Patch Changes

- Updated dependencies [5454047]
  - conversationalist@1.1.0
  - armorer@2.1.0

## 0.6.0

### Minor Changes

- 8ac2dc0: Add Anthropic server-side token counting.

  `createAnthropicTokenCounter` wraps `@anthropic-ai/sdk`'s `messages.countTokens(params: MessageCountTokensParams): APIPromise<MessageTokensCount>` — the same lazy-import, memoized-client, `ProviderError`-normalized shape as `createAnthropicBatchClient`, including its deference to the SDK's own `ANTHROPIC_API_KEY` lookup when `apiKey` is omitted. It exposes one operation, `countTokens({ model, messages, system?, tools?, ... })`, and returns the SDK's own `input_tokens` field unrenamed rather than inventing a provider-neutral budgeting shape: `AB-64` is still in Backlog and will define this package's real context/output-limit fields, so the response type is documented as provisional pending that.

  This is the Anthropic sibling `AB-159` deliberately left out of scope when it shipped `createGeminiTokenCounter`. Landing it makes `getProviderCapabilities('anthropic').serverSideTokenCounting: true` truthful — it was the only capability the catalog advertised that this package did not actually back. OpenAI still has no server-side token-counting endpoint, and this package does not synthesize a character-ratio estimate through the same signature: a token count feeds budgeting decisions, and a wrong number is worse than no number.

  One deliberate divergence from the SDK's own declarations: `AnthropicCountTokensResponse.input_tokens` is **optional** although `MessageTokensCount` declares it required. The declared type describes what Anthropic's endpoint returns, not a runtime guarantee — `baseURL` accepts any origin, including a credential-injecting proxy — so a count is never fabricated as `0` when a response genuinely omits it. "Absent" and "zero" stay distinguishable for callers budgeting against the result, matching the rule `GeminiCountTokensResponse` and `TokenUsage` already follow.

  The structural `AnthropicTokenCountingClient` interface follows the package's minimal-interface rule (named required fields, no `Record<string, unknown>` request parameter), and a new `anthropic-token-counting-assignability.test-d.ts` asserts that a real `Anthropic` satisfies it with no cast.

  No `peerDependencies` change. `messages.countTokens` has been stable on `client.messages` since `@anthropic-ai/sdk` 0.31.0 (2024-11-01), and the declared floor of `>=0.50.0` is already well above it, so every admitted version carries the method.

## 0.5.0

### Minor Changes

- 0a7d316: Add Gemini context caching.

  `GeminiProviderOptions` gains `assembler`, `contextBudget`, and `pinnedMessages` — the same names and the same `context/` types the Anthropic side already uses, because the concept genuinely matches. Setting `assembler` + `contextBudget` runs the context assembler in stable-prefix mode, splits the conversation at the resulting `cacheBoundary`, creates the prefix as a `@google/genai` `CachedContent` resource, and has every later request reference it by name while sending only the tail. `systemInstruction` moves into the cache and is omitted from those requests; nothing else is dropped. Wired on both `createGeminiProvider` and `createGeminiProviderStream`.

  A resource is created once per **distinct stable prefix**, keyed by a digest of the lowered prefix, not once per generated function. A generate function is reusable across runs, and a per-factory resource would hand a second conversation the first one's cached content — a request that omits its own system and pinned prefix while pointing at another run's, which is both a wrong answer and a leak of the earlier run's instructions into it. The retained set is bounded at eight prefixes, evicting the least recently used; an evicted resource is left to expire on its own server-side TTL and costs at most one extra creation if that prefix returns.

  Cache entries now track when they stop being usable, from the SDK's own `CachedContent.expireTime` where the response reports one and from the configured `cacheTtl` otherwise, so a lapsed resource is replaced — for that prefix alone — rather than referenced until every later request fails against a name that no longer resolves. A burst that arrives after an expiry installs exactly one renewal that every waiter shares. Each request awaits the same stored promise and therefore wakes to the same lapsed answer, so deciding to renew is not enough — a waiter has to know whether another already decided. The entry is re-read at the resume point, and everything from there through the replacement happens in one synchronous turn, so exactly one waiter renews and the rest share what it installed. A Gemini cache is a billable resource, so _n_ concurrent requests after every expiry previously meant _n_ paid-for caches of which only the last was kept. A resource that dies inside the remaining window, because it lapsed between the freshness check and the request or was deleted elsewhere, is recognized from the provider's own rejection and rebuilt once for that request; a streaming attempt that has already pushed text to the caller is not replayed, and a rejection about anything other than the cache is never retried. A failed `caches.create` is no longer retained either: the call that met it still throws, and the next call gets a real attempt rather than a replayed rejection.

  Two options diverge from the Anthropic names on purpose, because Gemini's cache is a named, explicitly-created server resource with its own lifecycle rather than a per-request `cache_control` breakpoint. `cacheTtl` takes Gemini's own duration string (`'3600s'`) where `extendedCacheTtl` is a boolean over Anthropic's two fixed lifetimes — a boolean cannot express an arbitrary TTL, and "extended" would be a fiction. `cachedContent` names an existing cache the caller created and owns, lowered verbatim to the SDK's `GenerateContentConfig.cachedContent` field; Anthropic's cache has no handle, so there is no name to borrow. Combining `cachedContent` with the assembler options, or enabling caching against an injected client with no `caches` namespace and no `cacheClient`, is rejected at factory-construction time rather than mid-run.

  `cachedContent` carries a documented **tail-only** input contract, because a `CachedContent` resource is the head of the prompt rather than an addition to it. Setting the option declares that the head of the conversation already lives server-side, so each call must pass only the turns that are not in the cache; passing the full conversation you would have sent uncached states the cached prefix twice, changing the prompt and paying for the duplicate on every request. Operative cannot do the subtraction for a resource it never created — it has no boundary to split on, unlike the provider-managed path where it built the prefix itself — so the caller who owns the cache owns the boundary. The half of the contract that is checkable is now enforced at the point of use: a conversation carrying a system message is rejected with a `ProviderError` naming the cache and the fix, rather than sent as a `config.systemInstruction` riding alongside `config.cachedContent` that duplicates or contradicts the cached instruction.

  `cacheClient` is the documented escape hatch for a client that cannot create caches, and it now behaves that way: precedence is a cache-capable injected `client`, then `cacheClient`, then the client the factory imports for itself. The two clients may carry different credentials, projects, or endpoints, so creating through `cacheClient` while generating through a perfectly capable `client` risked referencing a cache the generating client could not see.

  Gemini token accounting now reports `cacheReadTokens` from `cachedContentTokenCount` and subtracts it from `prompt`, matching the OpenAI provider: Gemini's `promptTokenCount` includes the cached count, unlike Anthropic's disjoint buckets. This applies to every response, not only cache-configured ones, because Gemini reports the field for its own implicit caching too. `cacheCreationTokens` stays absent — Gemini reports no cache-write count and it is never fabricated.

  Internal: the stable-prefix assembly helper the Anthropic provider used moves to `providers/shared/cache-aware-assembly.ts` so both providers share one implementation. Behavior is unchanged.

- 0a7d316: Add cross-provider batch inference and a static provider capability report.

  A new `providers/batches` subpath exposes one client per provider that has a native asynchronous batch endpoint: `createAnthropicBatchClient` (Anthropic Message Batches), `createOpenAIBatchClient` (the OpenAI Batch API), and `createGeminiBatchClient` (`@google/genai` batch jobs). Each is a thin, error-normalizing wrapper over the provider's own resource — the verbs, argument shapes, and returned objects stay the provider's, because the three APIs genuinely differ: Anthropic inlines per-request Messages bodies and streams results as JSONL, OpenAI builds a batch from an uploaded file and returns results as another file, and Gemini takes `{ model, src, config }` and addresses jobs by resource name. Like the existing provider factories, each SDK is imported dynamically, so a consumer that never batches never loads it.

  There is deliberately no OpenAI-compatible/local-server batch export. An Ollama, vLLM, or LM Studio server reuses OpenAI's chat shape and implements no batches endpoint, so `createOpenAIBatchClient` exposes no `baseURL` option and there is nothing to import for that case — unsupported is a compile-time fact, not a factory that fails at runtime. A caller with a batch-capable endpoint behind another origin passes their own client instead.

  `getProviderCapabilities(provider, { baseURL })` reports, synchronously and without side effects, which of four capabilities a provider supports: `batchInference`, `explicitThinkingRequest`, `requestControlledContextCaching`, and `serverSideTokenCounting`. A custom OpenAI `baseURL` reports no batch inference, because operative cannot tell a proxy from a local server and a wrong `true` is worse than a conservative `false`. This surface is provisional pending AB-64.

  The OpenAI answer accounts for the **effective** endpoint, not just the options object. `openai` documents `baseURL` as defaulting to `process.env['OPENAI_BASE_URL']`, and `createOpenAIBatchClient` constructs its client with no explicit base URL, so that variable silently decides where a batch request lands — pointed at LM Studio or Ollama, the advertised batch call reaches a server with no `/v1/batches` at all. `getProviderCapabilities` now reads the same variable and applies the same conservative rule it already applied to an explicit `baseURL`, with an empty string counting as the default endpoint in both cases. The function stays synchronous and side-effect-free, but its OpenAI row is now a fact about the running process rather than about the build, and is documented as such: call it when you need the answer instead of memoizing it at module load.

  Structural client interfaces for all three batch surfaces are added to `providers/types.ts`, and a new type-level test proves a real `Anthropic`, `OpenAI`, and `GoogleGenAI` each satisfy the matching interface with no cast.

  Each factory also verifies its client actually exposes the batch resource, and throws a `ProviderError` naming the required SDK version if it does not. This closes a real gap in the `openai` peer range: `client.batches` first shipped in `openai@4.34.0` and its `list` method in `4.38.0`, so an install satisfying the declared `>=4.0.0` could construct `createOpenAIBatchClient` successfully and then fail with an opaque `TypeError` on every operation. The peer range stays `>=4.0.0` deliberately — chat-only consumers should not be held to a batch-API floor — so the check is a construction-time guard rather than a version bump. `@anthropic-ai/sdk` (stable `messages.batches` since 0.33.0, floor `>=0.50.0`) and `@google/genai` (`batches` since 1.7.0, floor `>=2.19.0`) have no such gap and are guarded the same way for consistency. An injected `client` is checked when the factory is called; a lazily imported one as soon as it is constructed.

- 0a7d316: Add an explicit extended-thinking request parameter for Anthropic.

  `AnthropicProviderOptions` gains `thinking`, mirroring the native Anthropic request shape directly. Its type, exported as `AnthropicThinkingConfig`, is a structural mirror of the SDK's full `ThinkingConfigParam` union — `{ type: 'enabled'; budget_tokens: number }`, `{ type: 'disabled' }`, and `{ type: 'adaptive' }`, the first and last carrying an optional `display` — so adaptive thinking is reachable without defeating the type system. It is declared structurally rather than re-exported from `@anthropic-ai/sdk`, which is an optional peer dependency; a type-level test asserts the SDK's own `ThinkingConfigParam` stays assignable to it, so a variant added upstream fails the build instead of silently becoming unreachable.

  This is a second, provider-native escape hatch alongside the existing neutral `effort` knob rather than a competing abstraction over the same dimension — `effort` continues to lower to `output_config.effort`, `thinking` lowers to the `thinking` field, and neither overrides the other. When a caller sets both, both are sent on the request body and Anthropic applies its own documented interaction between them. Only `createAnthropicProvider` and `createAnthropicProviderStream` expose the option; OpenAI and Gemini have nothing to import for this, so `getProviderCapabilities` continues to report `explicitThinkingRequest: true` only for `anthropic`.

  An enabled budget is validated where the request is configured rather than left for the API to reject. Anthropic requires `budget_tokens` to be at least 1024 and strictly below `max_tokens`, and each half is checked where its inputs are actually known. The 1024 floor depends on nothing but the budget, so both factories reject it at construction. The `< max_tokens` bound depends on the `max_tokens` the request will send, and `GenerateContext.maximumTokens` is documented to override the construction-time value per call — so it is checked per request instead, before the client is touched. A `{ type: 'enabled', budget_tokens: 4096 }` against the default `maximumTokens` of 4096 therefore constructs fine and stays valid for a caller that passes `maximumTokens: 8192` on every invocation, while a call that would actually send an invalid pair throws a non-retryable `ProviderError` naming both values. Neither number is adjusted silently: raising `max_tokens` would change billing the caller did not ask for, and lowering `budget_tokens` would degrade the feature they explicitly requested.

  Both factories also reject, at construction, the parameter combinations Anthropic documents as incompatible with an active thinking configuration — each verified against Anthropic's thinking documentation rather than assumed, because they do not cover the same modes. A non-default `temperature` and a `topP` below 0.95 conflict with `enabled` and `adaptive` alike ("the restriction applies only while thinking is on: `temperature` and `top_k` are incompatible with thinking", and "`top_p` is allowed at values between 0.95 and 1"). A forced `toolChoice` — `'required'` or a named tool — conflicts with manual `{ type: 'enabled' }` only; Anthropic is explicit that "adaptive thinking, including on models where thinking is on by default, supports forced tool use", so that combination is deliberately left alone. `{ type: 'disabled' }` and an absent `thinking` skip all three.

  Known limitation: `thinking` is not yet supported end-to-end alongside tool calls. Anthropic requires the signed `thinking`/`redacted_thinking` block to be replayed, complete and unmodified, on the request that carries a tool result, and this provider extracts only `text` and `tool_use` blocks — so the block never reaches conversation history, and the follow-up request loses reasoning continuity (the API degrades rather than erroring, stripping blocks or disabling thinking for that request). Preserving native response blocks in conversation history is output-side work tracked separately as AB-73; the option's JSDoc carries the same warning.

- 0a7d316: Add Gemini server-side token counting.

  `createGeminiTokenCounter` wraps `@google/genai`'s `models.countTokens(params: CountTokensParameters): Promise<CountTokensResponse>` — the same lazy-import, memoized-client, `ProviderError`-normalized shape as `createGeminiBatchClient`. It exposes one operation, `countTokens({ model, contents, config? })`, and returns the SDK's own `{ totalTokens?, cachedContentTokenCount? }` fields unrenamed rather than inventing a provider-neutral budgeting shape: `AB-64` is still in Backlog and will define this package's real context/output-limit fields, so the response type is documented as provisional pending that.

  This is Gemini-only per `AB-155`'s progressive-enhancement decision. Anthropic's own `messages.countTokens` is a genuine sibling capability but is out of scope for this factory — it gets its own issue. OpenAI has no server-side token-counting endpoint at all, and this package does not synthesize a character-ratio estimate through the same signature: a token count feeds budgeting decisions, and a wrong number is worse than no number.

  The structural `GeminiTokenCountingClient` interface follows the package's minimal-interface rule (named required fields, no `Record<string, unknown>` request parameter), and `gemini-client-assignability.test-d.ts` gains an assertion that a real `GoogleGenAI` satisfies it with no cast.

## 0.4.0

### Minor Changes

- c2ec10f: `createAgent` now defaults `stopWhen` to `stopWhen.noToolCalls()` when the caller omits it, instead of running every step to `maximumSteps` with no stop condition at all. Pass an explicit `stopWhen` (still fully overridable) for agents that must finish on a tool call, such as a handoff.
- 3c45232: Migrate the Gemini provider from the frozen `@google/generative-ai` package to Google's maintained `@google/genai` SDK (peer floor `>=2.19.0`).

  BREAKING (Gemini client surface; released as a minor under 0.x convention): this changes both the optional peer dependency name and the structural shape of the client you may pass as `options.client`. Anyone constructing their own Gemini client must update on both counts.

  - Install `@google/genai` instead of `@google/generative-ai`. The old package has not been published since 2025-04-30.
  - `createGeminiProvider`/`createGeminiProviderStream` now take a `GoogleGenAI` client rather than a `GenerativeModel` handle. Calls go through the `models` namespace (`client.models.generateContent`), the model id travels with each request instead of being bound at client construction, and `generateContentStream` resolves to the chunk async-iterable directly rather than to a `{ stream }` wrapper.
  - Response objects lost their `.response` envelope: `candidates` and `usageMetadata` now sit at the top level of `GeminiGenerateContentResult`, and `functionCall.name`/`functionCall.args` are optional, so a call with no name is dropped and a named call with no arguments becomes an empty argument object.
  - Request bodies use `@google/genai`'s single flat `config` block. The former top-level `systemInstruction`, `tools`, and `toolConfig` fields and the nested `generationConfig` object all fold into it.
  - `createGeminiEmbedder` takes a `GoogleGenAI` client too: `client.models.embedContent({ model, contents })` returning a batch of `embeddings`, and it now throws a `ProviderError` when the API returns no vector for a text.
  - `createMockGeminiModel`/`createMockGeminiStreamingModel` from `@lostgradient/operative/providers/test` were reshaped to match, so fakes stay trivial to construct.
  - The structural client interfaces take a new exported `GeminiGenerateContentRequest` (`{ model: string; contents: unknown; config?: unknown }`) rather than a bare `Record<string, unknown>`. `GenerateContentParameters` is an SDK `interface` and so has no implicit index signature, which made a real `GoogleGenAI` unassignable to `GeminiGenerativeModel`/`GeminiStreamingModel` — passing one to `options.client` required an `as unknown as` cast, defeating the migration path above. Naming the required fields fixes that in both directions; fakes stay trivial, and `providers/gemini-client-assignability.test-d.ts` locks the assignability in at type-check time.

  Model resolution, effort/thinking-budget mapping, tool calling, streaming, and structured output are otherwise unchanged, and the provider still issues only `POST /v1beta/models/{model}:generateContent` (or `:streamGenerateContent`) with an `x-goog-api-key` header.

### Patch Changes

- c2ec10f: Document `textValueStore(new MemoryStorage())` from `@lostgradient/weft/storage` as the copy-paste-runnable in-memory `ConditionalTextValueStore` for `createSessionStore`, matching the pattern operative's own test suite uses.
- c2ec10f: Document that `createTopicBoundaryDetector`'s `allowedTopics`/`blockedKeywords` matching is literal, case-insensitive substring matching, not semantic — a paraphrased, on-topic input that never uses the literal keyword is flagged as off-topic. No behavior change.
- c2ec10f: Correct the `createHandoffTool` documentation. Warn against `stopWhen.noToolCalls()`, which never terminates a handoff loop, and recommend composing `stopWhen.every(stopWhen.toolCalled(name), stopWhen.not(stopWhen.toolOutcome('error')))` with a step cap instead of bare `stopWhen.toolCalled(name)` — the latter inspects only the generated call name, so it also fires on a handoff whose arguments fail validation, ending the run with no `HANDOFF_MARKER` and `extractHandoffTarget` returning `undefined`. Document that `undefined` check as mandatory, and document the default `z.object({})` input schema alongside an honest account of a custom one: it constrains and validates the call but does not travel into the handoff marker, so the values are recoverable from the recorded tool call on `RunResult.steps`, not from `extractHandoffTarget`.
- 3c45232: Bump the `@anthropic-ai/sdk` devDependency from `^0.116.0` to `^0.122.0`. No breaking changes apply between these versions, so `src/providers/anthropic.ts` and `src/providers/streaming/normalize-anthropic.ts` are unchanged and the `>=0.50.0` peer dependency floor is unchanged.
- 3c45232: Bump the `openai` devDependency from `^7.4.0` to `^7.8.0`. No breaking changes apply between these versions, so `src/providers/openai.ts`, `src/providers/embeddings/openai.ts`, and `src/providers/streaming/normalize-openai.ts` are unchanged and the `>=4.0.0` peer dependency floor is unchanged.
- 59f7642: Stop tool-result materialization from throwing on a self-referential array. `interoperability`'s non-JSON fallback called `String()` directly, which relies on `Array.prototype.join`'s cycle guard — an engine extension rather than a spec requirement. On Bun 1.3.13 that yields `'1,2,'`; on Bun 1.4.0 it recurses until the stack overflows and a `RangeError` escapes what is supposed to be a total normalization step. Cycles are now elided before coercion, so every supported runtime produces the documented result. Circular plain objects still render as `[object Object]`, unchanged. This ships to consumers because `interoperability` is inlined into these packages at build time.
- Updated dependencies [995734a]
- Updated dependencies [c2ec10f]
- Updated dependencies [59f7642]
- Updated dependencies [3c45232]
  - armorer@2.0.1
  - conversationalist@1.0.1

## 0.3.0

### Minor Changes

- a6e18f2: Require request-scoped Armorer execution authority when using approval-gated toolboxes, and update the stateless approval flow for Armorer 2.

### Patch Changes

- Updated dependencies [a6e18f2]:
  - armorer@2.0.0

## 0.2.0

### Minor Changes

- 00e34f2: `SessionHandle.recover()` now surfaces a failed durable re-attach through `emitter` instead of returning an indistinguishable `null`. `SessionRecoverEvent` gains a `failures` array (each entry carrying the rejected `runId` and its `error`), populated whenever `engine.resume()` rejects while re-attaching to a session's `running` refs — distinguishing "nothing to resume" (`failures: []`) from "resume was attempted and failed" (`failures.length > 0`). `recover()` itself keeps returning `AgentRun | null` and never throws.
- 8e70c14: Add `createLazyGenerate` for shared, retryable lazy loading of selected generate functions with invocation-local abort handling.
- 31d4780: Wire `@lostgradient/operative` into the Changesets and trusted-publishing release pipeline.
- f4fd0ed: Rename validated run data from `structuredOutput` to `output`, reject old persisted run-result shapes explicitly, add cached `unwrap()` and typed output accessors, and expose diagnostic handles for durable runs whose originating agent definition is unavailable.
- d3670e3: `createAgent`'s standalone `CreateAgentOptions` now encodes `tools`/`toolbox`/`permissions` exclusivity at the type level: `tools` + `toolbox`, `toolbox` + `permissions`, and all three together are now compile-time errors, matching the existing runtime guard. `tools`, `permissions`, `tools` + `permissions`, and `toolbox` alone remain valid, as does passing no tool configuration, including when `tools`/`permissions` are forwarded as already-optional (`T | undefined`-typed) values.

  `CreateAgentOptions` is now a `type` (a union-based intersection), not an `interface` — a consumer that previously wrote `interface MyOptions extends CreateAgentOptions` for the full options bag needs `type MyOptions = CreateAgentOptions & { ... }` instead. Extending or declaration-merging onto just the non-exclusive fields (`generate`, `instructions`, `stopWhen`, etc.) still works via the newly exported `CreateAgentOptionsBase` interface.

### Patch Changes

- e45b40c: Fix `session.recover()` leaving a session's `RunRef` stranded at `status: 'running'` forever when a recovered durable run reaches a terminal state before `recover()` resumes it. `engine.resume()` rejecting for an already-terminal workflow now reconciles the persisted `RunRef` (and recovered conversation history) to the workflow's actual terminal status instead of being silently swallowed; an unknown `runId` is left untouched.
- dfc571b: Optimize session listing with a maintained summary index while preserving compatibility with legacy session records.
- Updated dependencies [22de20a]
- Updated dependencies [ed70acf]
- Updated dependencies [aff071a]
- Updated dependencies [22de20a]
- Updated dependencies [d947aad]
- Updated dependencies [d229843]
- Updated dependencies [8bddca2]
  - conversationalist@1.0.0
  - armorer@1.0.0
