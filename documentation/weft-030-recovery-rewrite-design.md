# Weft 0.3.0 recovery rewrite — design for #2 (launch metadata) + #3 (live recovered-run visibility)

Status: DRAFT for adversarial review. Scope: close seams #2 and #3 (which are ONE coupled unit — both rewrite gateway's boot recovery). Weft 0.3.0 shipped `WorkflowHandle.getLaunchMetadata()` and `WorkflowHandle.snapshot()`.

## Current state (before)

**Run start** (`create-bureau.ts` runDurable path, ~L320-444):

- `sessionId` (L320) + `runId = run-${uuid}` (L332) both in scope.
- `createDurableActiveRun({engine, checkpointStore, runId}, {runId, options, prompt})` → `driveDurableRun` calls `engine.start('agentRun', {runId, prompt, maximumSteps}, {id: runId, services: {options, toolbox, emitter}})`.
- Then `store.register(activeRun, runId)` + `runSessionIdentifiers.set(activeRun, sessionId)`.

**Boot recovery** (`recoverDurableRuns`, ~L560-596):

1. `sessionStore.list()` → filter `lastRunStatus==='running'` → build `recovered: Map<runId, sessionId>` (the SIDE TABLE #2 targets).
2. `engine.recoverAll()` → `handles[]`.
3. Detached `Promise.allSettled(handles.map(h => settleRecoveredRun(h, recovered, sessionStore)))` — each awaits `handle.result()`, looks up `recovered.get(runId)` for the sessionId, persists terminal session status. NEVER `store.register`s the recovered run (seam #5b — invisible to `getRun()`/subscribers).

**Resolver** (`resolveRunServices` in runtime-composition.ts, ~L817):

- Receives `info: {workflowId, workflowType, input}`. Currently IGNORES `info.input`.
- Does its OWN `sessionStore.list()` scan, filters `lastRunId===workflowId && lastRunStatus==='running'`, loads session, `buildRunDepsFromSession(session)` → `{status:'available', services}` (no emitter attached — L764-766).
- On rebuild-throw: synchronously reconciles session to `error` (keyed on the session it just loaded). On null/vanished: unavailable.

## #2 — thread `sessionId` into the workflow input; kill BOTH side-tables

`AgentRunWorkflowInput` is OURS (run-workflow.ts:60). Add `sessionId: string`.

- **Run start**: pass `sessionId` into `createDurableActiveRun` options → `driveDurableRun` → `engine.start('agentRun', {runId, sessionId, prompt, maximumSteps}, {id: runId, services})`.
- **Resolver**: read `info.input.sessionId` directly (a narrowed read of `info.input`), `sessionStore.load(sessionId)` — DROP the `sessionStore.list()` scan + the `lastRunId`/`lastRunStatus` filter loop. The session is loaded by id, not found by scan. Still reconcile-to-error on rebuild-throw and return unavailable on null.
- **Boot recovery**: per recovered handle, `const meta = await handle.getLaunchMetadata()` → `meta.input.sessionId`. DROP the pre-built `recovered` Map entirely. `settleRecoveredRun` takes the sessionId from the handle's launch metadata, not a side table.

`info.input` / `meta.input` are typed `unknown` by Weft; narrow with a small type guard (`isAgentRunWorkflowInput`) — NOT an `as` cast (project rule). The guard checks `runId: string` + `sessionId: string`.

**Cross-upgrade caveat (per no-compatibility-bridge rule): NO scan-fallback.** A run checkpointed before this change and recovered after won't have `sessionId` in its input; the guard returns false → that run is treated as not-reconstructable (unavailable / settle skipped). This is acceptable for this stage; stated explicitly, not silently handled. (Pre-existing in-flight durable runs across a version upgrade are not a supported migration path here.)

## #3 — reattach a recovered run as a live `ActiveRun` + `store.register` (closes #5b)

**Scope decision: CORE (reattach + terminal events), NOT deluxe (live per-step during resume).**

Rationale: deluxe (live step events while the recovered generator advances) requires creating the emitter per-run BEFORE `recoverAll()` and injecting it through the resolver — which reintroduces a pre-`recoverAll` `runId→emitter` Map, in direct tension with #2's "no pre-recoverAll bookkeeping" win. The actual #5b complaint is "recovered runs are invisible to `getRun()` and live subscribers." Core fixes exactly that: the run rejoins the live surface (`getRun(runId)` resolves; subscribers see it) and fires terminal lifecycle events when it settles. Live per-step-DURING-resume is gold-plate and becomes a documented sub-seam.

**New operative export: `reattachDurableActiveRun(context, {runId, handle, deps})`** in active-run-adapter.ts. Unlike `createDurableActiveRun` (which `engine.start`s a NEW run), this wraps an ALREADY-RECOVERED `WorkflowHandle`:

- Creates the `CompletableEventTarget` emitter + the `ActiveRun` surface synchronously (same shape as `createDurableActiveRun`).
- Forwards `deps.toolbox` events with `toolbox` prefix (so the reconstructed toolbox's events fire if any).
- **Does NOT call `startRunLifecycle` / does NOT re-fire `onRunStart`** (seam #11 — the run already started in the prior process; `onRunStart` is side-effecting). Skips straight to awaiting `handle.result()`.
- On settle: `reconstructRunResult(context, runId, summary)` + `finalizeRunResult(...)` — the SAME terminal-lifecycle path `driveDurableRun` uses (fires `run.completed`/`aborted`/`error` + run hooks). On `EngineDisposedError`: the same quiet `makeInterruptedRunResult` (leave session running for re-recovery).

**Boot recovery rewrite** (`recoverDurableRuns`):

1. `handles = await engine.recoverAll()`.
2. For each handle: `meta = await handle.getLaunchMetadata()`; guard `meta.input`; if not ours, skip. `sessionId = meta.input.sessionId`.
3. Rebuild the run's deps for the adapter. PROBLEM: the deps were rebuilt by the resolver during `recoverAll` (for `ctx.services`), but the resolver's result is internal to Weft — the bureau doesn't get it back. So the adapter needs deps too (for `reconstructRunResult`'s checkpointStore is enough for the RESULT, but the toolbox-forward wants `deps.toolbox`). Options:
   - (a) Call `buildRunDepsFromSession(session)` AGAIN in `recoverDurableRuns` per handle (a second rebuild — wasteful but clean; the resolver's rebuild and this one are independent).
   - (b) Have the adapter NOT need deps — `reconstructRunResult` only needs `context.checkpointStore` + the summary, which it already has. The toolbox-forward is the only deps consumer; for a recovered run with no live per-step streaming (core scope), the toolbox-forward produces nothing observable anyway (tools already ran in the prior process or run in-process under the resumed generator, not through this adapter's toolbox). So the adapter can SKIP toolbox-forward entirely for the reattach path.
   - **CHOICE: (b).** The reattach adapter needs only `{runId, handle, context}` — no deps. It wraps the handle, awaits result, reconstructs from checkpoint, fires terminal lifecycle, registers. No second dep rebuild, no emitter injection into the resolver.
4. `store.register(reattached, runId)` + `runSessionIdentifiers.set(reattached, sessionId)` so `getRun(runId)` + session correlation work exactly like a live run.
5. The terminal-session-status persistence that `settleRecoveredRun` did is now driven by the adapter's `once('run.completed'/'aborted')` listeners (the SAME ones the live-run path registers) — so `settleRecoveredRun` is DELETED; its session-write logic is replaced by reusing the live-run completion listeners. (Verify the live-run listeners persist the same metadata `settleRecoveredRun` did: lastRunId/lastRunStatus/lastFinishReason/lastError + the checkpoint-snapshot-preferred conversation.)

**Registration timing**: `store.register` must happen synchronously in the boot loop (before the detached result-await), so `getRun(runId)` resolves the instant boot returns — even while the run is still resuming. The adapter's result-promise runs detached (boot doesn't await it), same as today.

## Files touched

- `@lostgradient/operative/src/durable/run-workflow.ts` — `AgentRunWorkflowInput.sessionId`; read nothing new in the body (sessionId is for the resolver/recovery, not the workflow logic) — actually the body ignores it. Add the field + `isAgentRunWorkflowInput` guard (exported for the gateway).
- `@lostgradient/operative/src/durable/active-run-adapter.ts` — `DurableActiveRunOptions.sessionId`; thread into `engine.start` input; new `reattachDurableActiveRun`; export it + the guard.
- `gateway/src/create-bureau.ts` — pass `sessionId` into `createDurableActiveRun`; rewrite `recoverDurableRuns` (drop `recovered` Map + `settleRecoveredRun`, use `getLaunchMetadata` + `reattachDurableActiveRun` + `store.register`).
- `gateway/src/runtime-composition.ts` — `resolveRunServices` reads `info.input.sessionId` (via guard), drops the `list()` scan.

## Oracles (done = these stay green + new ones added)

- KEEP: `run-workflow.test.ts` "THE PROOF" (resumes at step N, step 0 not re-run), `create-bureau.test.ts` "recovers an in-flight durable run" (assert engine-level + session status). These MUST keep their assertions — the recovery RESULT is unchanged; only the visibility + the side-table mechanism change.
- ADD: a `create-bureau.test.ts` test that after `recoverDurableRuns`, `bureau.getRun(recoveredRunId)` resolves (NOT undefined) — the #5b closure. And that a subscriber sees the recovered run's terminal `run.completed`. Use deterministic polling (`waitForCondition`), never fixed setTimeout.
- ADD: resolver reads sessionId-from-input (assert no `list()` scan needed — a session whose `lastRunId` metadata is WRONG but whose id is in the input still resolves).

## REQUIRED FIXES from Codex adversarial review (session 019e9f89) — apply ALL during implementation

1. **Q3 abort `lastFinishReason` regression (REAL BUG).** `settleRecoveredRun` writes BOTH `lastRunStatus:'aborted'` AND `lastFinishReason:'aborted'` (~L483-484). The live-run `once('run.aborted')` listener (~L420-434) writes ONLY `lastRunStatus:'aborted'` — no `lastFinishReason`. Reusing the live listener would DROP `lastFinishReason`, leaving contradictory metadata (a session that previously had `lastFinishReason:'error'` keeps it). FIX: patch the live `once('run.aborted')` listener to ALSO write `lastFinishReason:'aborted'`. This also fixes a latent bug on the non-recovery path. (budget-exceeded/elicitation-denied are NOT a regression: they fire `run.completed`, and both old+new map non-error/non-aborted → 'completed' identically. Confirmed.)

2. **Q6 engine-failed-run rejection (the biggest unflagged risk).** A recovered run whose deps the resolver can't rebuild is terminally `failed` PRE-REPLAY by Weft; the reattached `handle.result()` REJECTS with a non-`EngineDisposedError` error. The resolver ALREADY wrote that session to `error` synchronously (runtime-composition resolveRunServices reconcile path). So `reattachDurableActiveRun`'s result-error path MUST: catch `EngineDisposedError` → quiet interrupted (leave running, same as driveDurableRun); catch ANY OTHER rejection → LOG ONLY, fire NO terminal lifecycle event (the resolver owns that session's status). Do NOT `finalizeRunResult` a rejected handle. This mirrors old `settleRecoveredRun`'s write-free `catch`.

3. **Q2 deferral + ordering invariant.** `reattachDurableActiveRun` MUST use the same `Promise.resolve().then(() => driveReattached(...))` deferred-microtask start as `createDurableActiveRun`, so the synchronous boot turn completes `store.register` + `runSessionIdentifiers.set` BEFORE any terminal event microtask fires — even for a pre-settled handle. Document this as a required ordering invariant. ADD a test: pre-settle the handle BEFORE `recoverDurableRuns`, assert `getRun(runId)` resolves and the subscriber still sees `run.completed`.

4. **Q5 single-shot / at-most-once registration.** `recoverDurableRuns` is boot-single-shot, but guard anyway: `if (store.getRun(runId)) continue;` before reattaching, so a runId already live on this process (or a double-call) never double-registers (store uses plain `Map.set` → silent overwrite + split-brain). Cheap guard, add it.

5. **Q1 contract doc.** `reattachDurableActiveRun` JSDoc states: TERMINAL lifecycle events only; per-step toolbox/progress events are NOT forwarded for a reattached run (the recovered generator's tool events fire on the resolver's rebuilt `ctx.services.toolbox`, never this adapter's). This is the honest core-scope contract; live-per-step-during-resume stays a documented sub-seam.

6. **Q4 duration note (no code change).** `finalizeRunResult` sets `runStartTime = performance.now()` at reattach, so a recovered run's `onRunComplete.totalDuration` is time-on-THIS-process, not full wall-clock. No current consumer reads it for billing/classification. Add a TODO note in the reattach path; do not over-engineer a persisted start timestamp now.

## Open questions for review (ANSWERED by Codex — see REQUIRED FIXES above)

1. Is choice (b) — reattach adapter needs no deps, skips toolbox-forward — actually sound? Does the live-run surface guarantee anything via toolbox events that a recovered run would now be missing? (Belief: no — the recovered generator runs in-process via the resolver's rebuilt `ctx.services.toolbox`, whose events fire on THAT toolbox, not the adapter's. So neither the old `settleRecoveredRun` NOR a reattach adapter ever saw per-step tool events. Core scope is honest about this.)
2. `store.register` of a reattached run whose `handle.result()` already settled (a fast recovered run that finished before the boot loop reached it): does `reconstructRunResult` from the checkpoint still produce the right terminal result, and does `once('run.completed')` still fire (the adapter awaits result in a detached promise, so registration happens first regardless)? Confirm no race where the terminal event fires before `store.register`.
3. Does dropping `settleRecoveredRun` lose the "checkpoint-snapshot-preferred conversation" nuance (it loaded `checkpointStore.loadConversation(runId)` and preferred it over the session store)? The reattach adapter's `reconstructRunResult` already loads from the checkpoint, so the completion listener's `event.conversation` IS the checkpoint conversation — parity preserved. Confirm.

---

## ADR — #4 sub-step tool durability: the `runStep` split is REJECTED (do not re-attempt)

(Moved here from `run-workflow.ts` per committee review — keep the runtime comment short.)

Durability granularity is one whole step (generate + all its tools). A crash after `generate` but before the step's `ctx.memo` result commits re-runs the whole step, re-executing its tools — Weft is at-least-once, so a non-idempotent tool can double-execute. Making tool execution its own checkpointed `yield* ctx.run('executeTool', …)` unit would require splitting `runStep` so the durable generator can yield between "generate + append the assistant message and tool calls" and "execute tools + append results". That split is unsound, not merely risky, for three independent reasons:

1. **Correctness — Conversation across a yield.** Tool results must append to the live `Conversation` AFTER the checkpointed tool execution, but a live `Conversation` instance cannot cross a `yield*` (it fails `validateCloneable`). The second half would have to rehydrate from a snapshot taken AFTER the assistant message + tool calls were appended — a much fatter checkpoint payload (intermediate snapshot + the raw `response` + the tool plan). And `response` routinely carries non-cloneable provider SDK objects: Weft's checkpoint codec THROWS (`validateCloneable`) on a non-cloneable value at the `yield*` boundary — it does not silently drop the field — so this surfaces as a workflow failure, not a quiet data loss. Either way the payload is not reliably checkpointable.
2. **Hooks.** `stepToolbox` is mutated by the `selectTools` / `selectToolChoice` hooks before tools run; a durable split would re-fire those hooks on the tool-execution side or serialize a resolved tool plan. Neither is clean.
3. **Payoff.** `ctx.memo('step-N')` already short-circuits every COMPLETED step on resume, so the split only protects the single in-flight step, and only the narrow "crashed after generate, before tools" window (~a few percent of in-step crashes). It does NOTHING for the real hazard — non-idempotent tool side effects — which needs domain idempotency regardless.

**Accepted mitigation (NO agent-bureau code — the primitive already exists):** side-effecting tools opt into armorer's `withIdempotency(tool, { cache })` (`armorer/src/idempotency`). Its key is CONTENT-based (`fullInputKey` / `fieldKey('orderId')` / `compositeKey(...)`), NOT the tool-call id — which is the right design here: a crashed step re-runs `generate`, so the model re-issues fresh, NON-deterministic tool-call ids (`materializeToolCall` falls back to `crypto.randomUUID()`), so any `runId+stepIndex+toolCallId` key would NOT dedup the re-run. A content key the model reproduces deterministically does. Back the idempotency `cache` with the durable store and a cached success survives the crash-rerun within the same run. The clean upstream primitive (durable-activity-from-plain-async OR an activity-level idempotency key) is tracked in weft#444; if Weft ships it, this seam closes properly and the mitigation can be deleted.

## #6 structured-error fidelity — NOT wired (deliberate)

Weft 0.3.0 ships `registerSerializer(ctor, { toJSON, fromJSON }, { tag })`, which could preserve a `ZodError`'s `.issues` across the checkpoint (today `schemaValidation.error` is reduced to its message). Declined: no consumer reads the structured error off the TERMINAL durable result (the only `.issues` reader, `retry/schema-error-mutator.ts`, runs inside `runStep` on the LIVE error, before any checkpoint), and `registerSerializer` is process-global + one-shot + throws on duplicate registration — so wiring it would convert a best-effort, can't-fail message reduction into a global registration the schema-validation path depends on to not throw, for a field nobody reads. To enable later (only if a consumer appears): register a `ZodError` serializer at module load and let the live error flow through `ctx.memo` instead of calling `serializeError` on it.
