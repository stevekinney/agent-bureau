# Weft 0.3.0 durable scheduling — design for #7a (durable timer) + #7b (suspend/resume requeue)

Status: DRAFT for adversarial review. User chose the maximal scope for both. #7a and #7b are INDEPENDENT subsystems (different files, different failure modes) — designed together but can land in separate commits.

## Constraints established (verified in weft 0.3.0 source — do not re-litigate)

- A schedule is **serializable-only**: `ScheduleOptions = {id?, overlap?, backfill?}`, `startScheduledRun` (weft schedules.ts:281) launches with `{id}` and NO `services`, no `workflowHasServices` marker → `reprovideRecoveredServices` returns false → the resolver is NOT consulted for scheduled launches. So a scheduled workflow CANNOT read `ctx.services`. Our `agentRun` needs services. ⇒ a scheduled tick cannot BE an agent run. Upstream fix filed: weft#459.
- Therefore #7a uses a **marker workflow** (serializable, no services) + an **in-process observer** that launches the real run. NOT a scheduled agentRun, NOT services-rebuilt-in-the-scheduled-body (= deleted deps-registry anti-pattern).
- `engine.suspend(id): Promise<void>` parks a running workflow before its durable commit; `engine.resume(id): Promise<WorkflowHandle>` re-arms it. Both apply ONLY to engine workflows (#7b requires routing scheduler tasks through the durable engine first).

## SINGLE-OWNER INVARIANT (load-bearing for BOTH — the Codex Q5/Q6 split-brain)

For any durable run, EXACTLY ONE in-process path may call `handle.result()` / drive its terminal lifecycle. The engine owns durability + firing; the 4-lane dispatcher owns priority/preemption; they must not BOTH terminalize a run. Concretely:

- A scheduler task routed through the durable adapter is driven by the adapter's `result` promise. Preemption must `engine.suspend` (NOT abort+re-run), leaving the run resumable; the SAME adapter/handle is resumed later. Two adapters must never wrap one runId (the #3 reattach guard pattern).
- The #7a observer must launch each marker-fire's run AT MOST ONCE (dedupe by marker/run id), or two observers (or one observer twice) double-launch.

## #7a — durable timer via marker workflow + in-process observer

### Pieces

1. **`scheduledTick` workflow** (operative/durable, NEW): a trivial SERIALIZABLE workflow. Input `{ scheduleId: string, firedAt: number }`. Body: `ctx.setAttribute('scheduleId', …)` and return the input. No services, no agent logic. Its ONLY job is to be a durable, schedulable marker whose firing Weft persists.
2. **`engine.schedule('scheduledTick', { scheduleId }, { every: '60s' }, { id, overlap: 'skip' })`** registered by the bureau per heartbeat/scheduled lane. The DURABLE TIMER: survives a crash (Weft re-arms the schedule on boot).
3. **In-process observer** in the bureau: watches for `scheduledTick` firings and, per fired occurrence, launches the REAL services-bearing agent run IN-PROCESS (via the existing durable `createRun` path — already per-run durable). The observer is how the serializable marker becomes a real run without putting services in the schedule.

### The observer mechanism (the soft spot)

**VERIFIED: `ScheduleHandle` has NO fire/occurrence callback** — only `pause/resume/cancel/update/describe/getSchedule` (weft schedule-handle.ts). So there is NO in-process "on occurrence" hook; option (a) is unavailable. The observer MUST poll:

- (b) **Poll** `engine.list` (filter `type: 'scheduledTick'`, recent `createdAt`) or the schedule's `getSchedule().currentWorkflowId`, on the bureau's own in-process tick. Launch a real run per new occurrence id not yet seen. AT-MOST-ONCE via a persisted "last observed occurrence" cursor (kv/session store).
- AT-MOST-ONCE EDGE: process dies between marker-fire and observe → that tick's run is not launched until the next observe (no duplicate; possibly a skipped tick if `overlap:'skip'` and the window passed). Inherent to a serializable-marker design until weft#459.
- COMPLEXITY CHECK: the observer is itself an in-process poll loop — so #7a trades the heartbeat's in-process `sleep` loop for an in-process poll loop PLUS a durable marker schedule. The ONLY thing gained vs. today: the schedule cadence (next-fire-at) is now durable, so cadence survives a crash. The observer/launch is still in-process. This is real but narrow; the design must be honest that it is not "fully durable scheduling," just "durable cadence + in-process launch."

### What it replaces

`createHeartbeat`'s in-process `cancellableSleep` loop becomes (for durable lanes) the marker schedule + observer. KEEP `createHeartbeat` for non-durable/library use. The 4-lane dispatcher is untouched — the observer SUBMITS to it exactly as the heartbeat does today.

## #7b — suspend/resume requeue (route scheduler tasks through the durable engine)

### The change

Today `startAndAwaitTask` runs `executeLoop` (non-durable) and `preemptTask` does `abort()` + re-enqueue a FRESH `createRun()` (progress LOST — there is no resume-from-cursor today despite the aspirational name). Make preemptable durable tasks:

1. Route through the durable engine adapter (the `createRun(options, durableRouting)` path) so each task is a checkpointed workflow with a stable `runId`.
2. `preemptTask` calls `engine.suspend(runId)` instead of `abort()`. The run parks at its last checkpoint, NON-terminal.
3. Requeue stores `{ taskId, runId, __requeues+1, RESUME: true }` instead of a fresh task. On re-dispatch, a resume-flagged task calls `engine.resume(runId)` and wraps the resumed handle (reattach-style, like #3) instead of `createRun()` from scratch — so it continues from the checkpointed step.
4. SINGLE-OWNER: the suspended run's original adapter `result` promise must be settled/abandoned cleanly on suspend (suspend rejects outstanding `result()` waiters per the 0.3.0 changelog: "cancel/fail transition a suspended workflow to terminal and reject outstanding result() waiters" — VERIFY whether SUSPEND alone rejects result() or only cancel/fail does). The resumed run gets a NEW adapter/handle; the old one must not also terminalize.

### Open questions (#7b) — VERIFIED in weft 0.3.0 source

1. **`engine.suspend(id)` does NOT settle `result()`** (weft termination/suspend.ts:28: "does NOT settle the result promise — `handle.result()` stays pending until a later `resume()` drives the run to completion"). So the dispatcher's original `result` promise for a suspended task stays PENDING — no rejection to classify, but the dispatcher must STOP awaiting it on suspend (don't leak a forever-pending await) and hand ownership to the resume path. suspend also does NOT abort the AbortController (it's a park, not a cancel) and does NOT run cancel handlers.
2. **`engine.resume(id)` reuses the PRESERVED in-memory services — the resolver is NOT consulted same-process** (suspend.ts:29 preserves `workflowServices`; recovered-services.ts:53 short-circuits `if (workflowServices.has(id)) return false`). So an in-process preempt→resume keeps the SAME generate/toolbox with zero rebuild and zero session lookup — no "unavailable" risk. `resume` returns a `WorkflowHandle` whose `result()` resolves when the resumed run completes. THIS IS THE KEY ENABLER: scheduler preemption is always same-process, so suspend/resume is clean.
3. **A suspended run is NOT auto-recovered by `recoverAll()`** (suspend.ts:16-17) — it's client-driven. So a suspended scheduler task that the process then crashes on does NOT auto-resume on reboot. Edge: if the bureau crashes while a task is suspended-and-requeued, that run stays `suspended` (resumable but not auto-resumed). Document; for the scheduler this is acceptable (preemption is a live-process concern). [If we wanted crash-resume of suspended tasks, the bureau would track suspended runIds durably and resume them at boot — DEFER unless asked.]
4. Non-durable scheduler use (library, no engine): keep abort+re-run requeue. suspend/resume is ONLY for engine-backed tasks. `preemptTask` branches on "does this RunningTask have a durable runId+engine?" — thread them into `RunningTask`.
5. The durable adapter already returns a compatible `ActiveRun`/`RunResult`, so `submit()`/`dispatch()` surface is preserved. The resumed handle is wrapped reattach-style (sibling of #3's `reattachDurableActiveRun`) so its terminal result flows back to the SAME `taskResolver`. SINGLE-OWNER: the original adapter's result is abandoned on suspend (it's pending-forever); the resume adapter is the sole owner that resolves the task.

## Files touched (estimate)

- operative/durable: NEW `scheduledTick` workflow + register it in `create-run-engine`. Suspend/resume helpers (resume-an-existing-handle, sibling of reattach).
- operative/scheduler/create-scheduler.ts: `RunningTask` carries optional `{engine, runId, durable}`; `preemptTask` branches suspend-vs-abort; requeue carries resume intent; `startAndAwaitTask` resumes a resume-flagged task.
- operative/scheduler/create-heartbeat.ts: durable-lane variant submits via the marker observer (or a new `createDurableHeartbeat`).
- gateway/create-bureau.ts: register the marker schedule(s) + the observer; thread the engine into the scheduler so its tasks are durable; `submitSchedulerTask` routes durable.
- gateway/runtime-composition.ts: register `scheduledTick` in the engine; expose the schedule/observer wiring.

## Oracles

- KEEP all existing scheduler tests (preemption, requeue, idle, priority lanes) GREEN — the in-process/non-durable path is unchanged for library use.
- ADD: a durable-task preemption test that asserts suspend (not abort+re-run) — the resumed task continues from its checkpoint (step N, not step 0), proven like the recovery proof test.
- ADD: a #7a test that a marker schedule firing launches exactly ONE real run per occurrence (at-most-once), and that the durable timer survives a simulated crash (re-arms).
- Full operative + gateway validate green, uncached.

## Honest scope note

#7a's value is timer-PHASE durability only (per-run durability is already done). The marker+observer is a real subsystem with at-most-once-tick edges; weft#459 would replace it with a clean resolver-fired scheduled run. #7b's value is real: preemption preserves progress (suspend) instead of discarding it (abort+re-run). Both keep the 4-lane dispatcher; neither asks Weft to absorb it.

---

## OUTCOME (2026-06-09)

- **#7a: DEFERRED** (user-confirmed after Codex xhigh review). A "durable metronome + volatile launcher": serializable marker workflow + in-process polling observer, where the real run still launches in-process. Only gain = schedule cadence survives a crash; a crash between marker-fire and observe just skips that tick (fine for an agent heartbeat). Marginal value, real correctness surface. `createHeartbeat` stays; weft#459 is the clean path.
- **#7b: SHIPPED.** Routed preemptable scheduler tasks through the durable engine; preemption now `engine.suspend`s (preserving the checkpoint) and a requeue `engine.resume`s from the last completed step instead of abort+re-run. All 5 Codex fixes applied: (1) ownership generation guards the abandoned suspended dispatch's still-settling result from double-resolving; (2) `suspendAndDetach` never awaits the pending-forever result (no deadlock); (3) `resumeIntent`/`__resume` carries the runId across the queue; (4)+(5) collapsed into ONE cancel-on-stop pass — the durable suspended-task registry was REMOVED (the whole scheduler is volatile, so a durable registry for one task class was gold-plating; `engine.cancel` on a suspended run terminalizes it AND rejects its waiter, closing both the dangling-record and the shutdown-hang). In-process suspend→resume reuses preserved services (resolver not consulted same-process). Proof test: `durable-preemption.test.ts` — createRun called ONCE, step 0 ran ONCE (resume-from-checkpoint), task terminalized ONCE (no split-brain). Existing 36 in-memory scheduler tests unchanged + green.
