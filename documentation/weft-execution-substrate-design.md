# Weft as agent-bureau's Durable Execution Substrate

**Status:** Design accepted for the integration-foundation phase (Phase 3).
**Scope of this document:** the *foundation* — a durable, resume-from-step-N agent run on Weft `@lostgradient/weft@0.2.0`, with every unfinished path marked as a `TODO(weft-integration):` seam. It is **not** a finished loop rewrite. Breaking changes are acceptable (agent-bureau is pre-release); gratuitous churn is not.

All `file:line` references are to `/Users/stevekinney/Developer/agent-bureau`. Weft claims are verified against `/Users/stevekinney/Developer/weft` (the source of the published `0.2.0` package). agent-bureau consumes the **published npm package**, never this source.

---

## 1. Chosen strategy: a synthesis, because there was no majority winner

Three strategies (WRAP, REFACTOR, HYBRID) were judged by three independent judges. The verdicts were a **1-1-1 split** — one judge each crowned WRAP, HYBRID, and REFACTOR. There is no consensus *winner*. The real consensus is in the three judges' `bestIdeasFromLosers` sections, which — regardless of which label each crowned — **converge on the same blended design**. This document is that blend.

The blend's spine, and where each strategy contributes:

| Decision | Source | Why |
|---|---|---|
| Thin durable workflow generator; only **plain, cloneable cursor data** crosses a `yield*` | WRAP | The only Stage-0 skeleton correct as drafted. `validateCloneable` (`weft/src/core/codec/validation.ts:41,144`) rejects class instances with prototype methods, and the transcript-in-locals path is O(n²). |
| **One code path**, not two: split the per-step body at the tool boundary into `runStepUpToTools` + `applyToolResults`; the durable generator drives those *same halves* | HYBRID | Kills WRAP's fatal flaw — a "two-loop period" (thin durable loop alongside the rich in-process loop, converging "in Stage 3") reproduces exactly the silent duplication the project forbids. The split is a behavior-preserving **pure refactor**, landed first, independently revertable. |
| `executeTool` is the **only** operation that must be a `ctx.run` activity; generate stays in-process and is made durable as a restored cloneable projection + snapshot | HYBRID + judges' unanimous praise | Extracting generate with its hooks/streaming/schema-retry into an activity boundary *is* the REFACTOR rewrite the task defers. It becomes a seam, not foundation. |
| onError + schema-retry as **workflow-local loops** (durable counters for free) | REFACTOR | The correct *eventual* target; the one design that gets mid-retry resume by construction. Deferred to a seam here, but its shape is the convergence target — so the foundation never forks. |
| Interceptor-based event bridge; `engine.schedule`/`ctx.sleep` for scheduled/ambient lanes | REFACTOR | The concrete mechanism for cross-worker event fan-out and the heartbeat lanes, once the loop leaves inline mode. Seams here. |
| **Recovery re-registration seam** — recovered handles need ActiveRun adapters rebuilt | REFACTOR (only design that caught it) | `recover:true` relaunches workflows on boot, but `store.register` only fires on fresh start (`gateway/src/create-bureau.ts:416`). A resumed run would otherwise complete invisibly to gateway. |
| Per-crash-window durability **table**, and the snapshot-ordering **tested invariant** | HYBRID's table + WRAP's O(1) proof obligation | Honesty discipline: name exactly what survives each crash point, and gate the make-or-break checkpoint-size invariant in CI. |

**The governing fact that makes all of this work** (verified `weft/README.md:105-107`): Weft is **checkpoint-not-replay**. At each `yield*` it snapshots live locals + generator position and resumes from that snapshot — it does *not* re-run the body from the top. So a generate result, once it is a cloneable local before the next `yield*`, is durable *without* being an activity. There is no replay-determinism constraint on the body (`Date.now()`, `Math.random()` are fine).

---

## 2. Integration foundation — build this first

### 2.1 Module layout

**No new package.** operative already declares `@lostgradient/weft@^0.2.0` and already consumes `TextValueStore` (`packages/operative/src/session/create-session-store.ts`, `src/cache/`). A sibling package would split the run loop from its durability layer across a package boundary and invert the dependency graph. Co-locate, keep physically deletable.

```
packages/operative/src/durable/
  create-run-engine.ts     // createRunEngine({ storage }) -> Promise<Engine> via Engine.create
  run-workflow.ts          // workflow({ name: 'agentRun' }).activities({...}).execute(...)
  execute-tool-activity.ts // the ONLY side-effect activity: wraps stepToolbox.execute
  storage-activities.ts    // thin durable KV activities: loadCursor / loadConversation / recordStep
  checkpoint-store.ts      // RunCheckpoint + StepRecord plain projections over a textValueStore view
  active-run-adapter.ts    // ActiveRun over engine.start + WorkflowHandle (preserves deferred-start)
  types.ts                 // RunCursor, RunCheckpoint, StepRecord, DurableRunDeps
```

And a **pure refactor inside `loop.ts`** (the anti-duplication move):

```
packages/operative/src/loop.ts
  // extracted at the stepToolbox.execute boundary (loop.ts:769):
  runStepUpToTools(deps, conversation, cursor) -> StepUpToToolsResult   // generate + hooks + schema-retry + validation, in-memory
  applyToolResults(deps, conversation, generated, toolResults) -> void  // append results, afterToolExecution hooks, build StepRecord
  // executeLoop() is re-expressed in terms of these two halves (behavior-preserving)
```

### 2.2 Engine wiring — one durable backend, two consumers

`textValueStore` is **not** an Engine `Storage`. Verified (`weft/src/storage/text-value-store.ts:192`): `textValueStore(storage: Storage, options)` *wraps* a raw `Storage` backend and returns a string-KV view. Both `resolveStorage` and `textValueStore` are exported from `@lostgradient/weft/storage`.

**The wiring correction:** today `gateway/src/runtime-composition.ts:453` does `textValueStore(await resolveStorage(options.storage))` and **discards the raw `Storage`**. We keep it, build the Engine on the *same backend*, and pass `disposeUnderlyingStorage: false` so the Engine owns disposal (the flag exists in Weft precisely for this — `text-value-store.ts:46`). Weft requires **one engine per durable store** (`README.md:93`), so the Engine is built once at bureau composition.

```ts
// runtime-composition.ts (sketch)
import { resolveStorage, textValueStore } from '@lostgradient/weft/storage';

const storage = await resolveStorage(options.storage);          // raw Storage — KEEP IT
const kv = textValueStore(storage, { disposeUnderlyingStorage: false }); // transcript + session + checkpoints
const engine = await createRunEngine({ storage });              // wf: checkpoints + recoverAll on boot
```

```ts
// create-run-engine.ts
import { Engine } from '@lostgradient/weft';
import type { Storage } from '@lostgradient/weft/storage';
import { runWorkflow } from './run-workflow';
import { executeToolActivity } from './execute-tool-activity';
import { loadCursorActivity, loadConversationActivity, recordStepActivity } from './storage-activities';

/** Builds the durable run engine. `recover` defaults true: recoverAll() runs on boot. */
export async function createRunEngine(options: { storage: Storage }): Promise<Engine> {
  return Engine.create({
    storage: options.storage,            // NOT MemoryStorage — recovery loses checkpoints with the process
    recover: true,                       // resume in-flight agentRun workflows from last checkpoint
    workflows: { agentRun: runWorkflow },
    activities: {
      executeTool: executeToolActivity,
      loadCursor: loadCursorActivity,
      loadConversation: loadConversationActivity,
      recordStep: recordStepActivity,
    },
    // TODO(weft-integration): tune history.maxEvents / checkpointSizeWarningThreshold once long-run checkpoint sizes are measured.
  });
}
```

`SQLiteStorage` (runtime-neutral, `new SQLiteStorage('./weft.db')`, resolves to `BunSQLiteStorage` under Bun — `weft/src/storage/sqlite.ts:31`, `bun-sql.ts:34`) is the durable backend behind `resolveStorage`.

### 2.3 The named activities (minimal table)

| Activity | Wraps | Why an activity | Idempotency |
|---|---|---|---|
| `executeTool` | `stepToolbox.execute(call)` (`loop.ts:769`) | **External side effects** — the one operation that genuinely must be at-least-once with retry | `idempotencyKey = tc.id` (materialized tool-call id, `loop.ts:717`). **See §4 — this does NOT provide cross-crash dedup in 0.2.0.** |
| `loadCursor` | read `RunCursor` from `kv` | Durable read on resume | trivially idempotent |
| `loadConversation` | read snapshot from `kv`, `Conversation.from(snapshot)` (`history.ts:1207`) | Rehydrate transcript on resume | trivially idempotent |
| `recordStep` | write `StepRecord` + `Conversation.snapshot()` (`history.ts:1177`) to `kv` | Durable step-boundary commit | last-write-wins on `run:{id}:*` keys |

**Generate is deliberately not an activity.** Its durability comes from §4's snapshot-before-tool-yield + restored cloneable projection. Lifting it (with `prepareStep`/`beforeGenerate`/`afterGenerate` hooks, `messageAppended` streaming, schema-retry re-prompts) into an activity boundary is the REFACTOR rewrite — a seam, not foundation.

### 2.4 Workflow body skeleton

The load-bearing invariant, stated as a hard rule the skeleton must obey: **no `Conversation` instance is ever a live workflow local across a `yield*`.** Only plain, cloneable data crosses a yield — `cursor`, `generated`, `toolResults`, and `conversationSnapshot` (a `structuredClone`-safe `{ root, currentPath }` tree, `history.ts:1177`). The two extracted halves therefore take and return **snapshots**, not instances: each half rehydrates `Conversation.from(snapshot)` internally, mutates, and returns a fresh snapshot — the instance is born and dies inside the half, before any yield. This is the exact rule HYBRID's skeleton violated (it held a live `conversation` instance across the tool yield, which `validateCloneable` hard-throws on, `validation.ts:144`); the synthesis exists to not do that.

```ts
// run-workflow.ts — real Weft Context API; comments are the literal TODO seams
import { workflow } from '@lostgradient/weft';
import { executeToolActivity } from './execute-tool-activity';

// The two halves are SNAPSHOT-in / SNAPSHOT-out — they never leak a Conversation instance:
//   runStepUpToTools(deps, conversationSnapshot, cursor)
//     -> { generated, conversationSnapshot }   // rehydrates, generates+mutates, re-snapshots; instance dies here
//   applyToolResults(deps, conversationSnapshot, generated, toolResults)
//     -> conversationSnapshot                   // rehydrates, appends results + afterToolExecution hooks, re-snapshots

export const runWorkflow = workflow({ name: 'agentRun' })
  .activities({
    executeTool: executeToolActivity,
    loadCursor: loadCursorActivity,
    loadConversation: loadConversationActivity,
    recordStep: recordStepActivity,
  })
  .execute(async function* (ctx, input: { runId: string }) {
    // Closures (generate fn, toolbox, hooks, stopWhen) come from a per-run deps registry.
    // They are NEVER checkpointed and NOT available after a real crash — see §4.recovery + seam #5.
    const deps = getLaunchScopedDeps(input.runId);

    // DURABLE LOCALS — ALL plain/cloneable: cursor {step} + a conversation SNAPSHOT (never an instance).
    let cursor = (yield* ctx.run('loadCursor', { runId: input.runId })) ?? { step: 0 };
    let snapshot = yield* ctx.run('loadConversation', { runId: input.runId }); // plain snapshot tree

    while (!stopReached(deps, cursor)) {
      // === IN-MEMORY: generate + hooks + schema-retry + validation. SNAPSHOT in, SNAPSHOT out. ===
      // This is runStepUpToTools — the SAME half executeLoop() calls. One code path.
      const stepUpToTools = await runStepUpToTools(deps, snapshot, cursor);
      const generated = stepUpToTools.generated; // { assistantMessage, toolCalls:[{id,name,input}], usage, final } — cloneable
      snapshot = stepUpToTools.conversationSnapshot; // assistant turn already appended; plain tree

      // === INVARIANT: snapshot reflects the assistant turn, taken BEFORE the first tool yield. ===
      // `generated` + `snapshot` are the only live locals across the executeTool yield — both plain.
      yield* ctx.run('recordStep', {
        runId: input.runId,
        phase: 'pre-tools',
        step: cursor.step,
        conversationSnapshot: snapshot,
        // TODO(weft-integration): StepRecord projection must strip the Conversation instance
        //   (StepResult embeds it at types.ts:123 and fails validateCloneable across a yield).
      });

      // === DURABLE tool execution — the only side-effect activity ===
      const toolResults = generated.toolCalls.length
        ? yield* ctx.all(
            generated.toolCalls.map((tc) =>
              ctx.run('executeTool', { runId: input.runId, toolCall: tc }, {
                idempotencyKey: tc.id, // forward-compat; see §4 — NOT cross-crash dedup in 0.2.0
                retry: { maxAttempts: 3, initialBackoff: '1s', backoffMultiplier: 2 },
              }),
            ),
          )
        : [];

      // === IN-MEMORY tail: append results + afterToolExecution hooks. SNAPSHOT in, SNAPSHOT out. ===
      snapshot = await applyToolResults(deps, snapshot, generated, toolResults);

      // === Durable step-boundary commit ===
      yield* ctx.run('recordStep', {
        runId: input.runId,
        phase: 'complete',
        step: cursor.step,
        stepRecord: toPlainStepRecord(generated, toolResults),
        conversationSnapshot: snapshot,
      });

      cursor = { step: cursor.step + 1 };
      if (generated.final) break;

      // TODO(weft-integration): in-flight schemaAttempts/stepRetryCount (loop.ts:233,463) are NOT
      //   durable — an incomplete step restarts its retry loops from zero on resume. Lift the
      //   onError do/while (loop.ts:466-642) and schema-retry loop (loop.ts:972-1015) to
      //   WORKFLOW-LOCAL loops so Weft snapshots the counters for free (the REFACTOR convergence target).
      // TODO(weft-integration): compaction (contextManagement.onCompact, loop.ts:402) runs in-memory
      //   inside the step today; promote to a compactContext activity with recordStep-after-compaction ordering.
    }

    ctx.setAttribute('runId', input.runId); // visibility
    return buildRunResult(deps, snapshot, cursor); // snapshot in, plain RunResult out
  });
```

> [!WARNING] `getLaunchScopedDeps` is the recovery hazard, not a convenience
> `generate`, `toolbox`, and `hooks` are **non-serializable closures** pulled from a process-lifetime registry. On a fresh-process recovery the registry is empty, so a recovered generator cannot advance a step until those deps are **re-injected**. This is the deeper half of the recovery problem — distinct from re-attaching the observable surface. See §4 "Recovery requires re-injecting deps" and seam #5.

---

## 3. Public operative API: stays / breaks / wrapped

The central preserved contract is **`ActiveRun`** (`create-run.ts:12-47`), built synchronously over an in-process `CompletableEventTarget` with a **deferred-microtask loop start** (`create-run.ts:88-90`) so callers attach listeners before the loop runs. gateway depends on this exactly: `create-bureau.ts` attaches `.once('run.completed'|'run.aborted'|'run.error')` and calls `store.register(activeRun, runId)`.

**Inline mode (`workflowExecutionMode: 'inline'`, the default) is what makes the first pass low-risk.** The generator runs in-process on the engine isolate, so the existing `CompletableEventTarget` stays reachable — `runStepUpToTools`/`applyToolResults` emit to the same emitter `ActiveRun` exposes, unchanged.

| Surface | First pass | Notes |
|---|---|---|
| `ActiveRun` (full event API, `abort`, `[Symbol.dispose]`) | **Preserved** | Hard gateway contract. Adapter (`active-run-adapter.ts`) builds it over `engine.start` + `WorkflowHandle`, preserving the deferred-microtask contract: construct synchronously, `engine.start('agentRun', { runId })` on the next microtask. `result` ← `handle.result()`; `abort` → `handle.cancel()`; `[Symbol.dispose]` → cancel + complete. |
| Event types (`CombinedOperativeEventMap`) and WS frames | **Preserved** | Emitted by the same in-process loop halves; gateway `.once(...)` wiring unchanged. |
| `run()` (`run.ts`), `createRun()` (`create-run.ts:52`) signatures | **Preserved** | Internally route through `engine.start('agentRun')` → bridge `handle.result()`. Absent an injected engine, the legacy in-memory path still runs (opt-in durability). |
| `RunResult` / `RunOptions` / `StepResult` (public shape) | **Preserved** | gateway request mapping depends on option names. |
| `Scheduler` interface (`create-scheduler.ts:44-77`) | **Preserved** | Stays an in-process dispatcher; now `engine.start`s workflows and `handle.cancel`s them. Gateway scheduler route unchanged. |
| `RetryOptions` + `callGenerateWithRetry` (`loop.ts:94`) for **tools** | **Superseded** by activity `RetryPolicy` (acceptable break) | Generate retry stays in-memory in pass 1, so these survive for generate; the *tool* retry path is replaced. |
| `AgentSession` save/load (`agent-session.ts`) | **Kept as a façade** over the durable checkpoint | Was post-run-only (resumed at step 0); becomes a thin read of the latest `RunCheckpoint`. |
| Per-step `abortStep` two-level abort (`loop.ts:332-339`) | **Partially changed** (seam) | Run-level abort → `handle.cancel()`. `abortStep` (cancel one step, continue) has no Weft analog — stays in-process behind a seam. |

**Consumer blast radius, pass 1:** gateway / sentinel / herald change **0 files** — the `ActiveRun` contract is preserved verbatim under inline mode.

---

## 4. Durable vs deferred — precise and honest

### What survives a crash (durable, written at each `yield*` / activity commit)
- The `RunCursor` (`{ step }`, plain cloneable local, checkpointed at every yield).
- Every **completed** step's `StepRecord` projection (no `Conversation` instance) and the run-scope `Conversation.snapshot()`, in `kv` keyed by `runId`.
- The in-flight `generated` projection — *if* the crash was after the pre-tools `recordStep` yield, it is restored as a local; generate does **not** re-run.

### What is replayed (resumed-from, not re-executed)
- The generator relaunches from the last checkpoint with locals restored. Body code between the last `yield` and the crash re-runs — but that is only pure cursor math + stop evaluation (idempotent). No determinism constraint.

### Per-crash-window table (the honesty artifact)

| Crash point | On `recover:true` boot | Generate re-runs? | Tool re-runs? |
|---|---|---|---|
| During step N **generate** (before the pre-tools yield) | restore end of step N−1; re-enter at step N | **Yes** — one re-charged LLM call | No |
| After **pre-tools `recordStep`**, before/inside the `executeTool` yield | restore post-snapshot checkpoint; `generated` restored | **No** | **Possibly** — see at-least-once below |
| After the `executeTool` yield, before the **complete `recordStep`** | restore post-tool checkpoint; `generated` + results restored | No | No (results cached in checkpoint) |
| After the complete `recordStep` (step N done) | restore end of step N; continue at N+1 | No | No |

**Bounded cost: at most one re-charged LLM call per crash.**

### The at-least-once reality — stated plainly (VERIFIED, do not overclaim)

**`idempotencyKey = tc.id` does NOT provide cross-crash deduplication in `0.2.0`.** Verified against `weft/documentation/architecture/tier-0-behavioral-contract.md`:

> "the checkpoint commit path does not persist a separate activity-reconciliation record. If an activity finishes and the process crashes before the checkpoint commit records its result, recovery has no durable activity result to replay." (line 11)
> "When absent, the activity is non-reconcilable across the hard crash window and must behave like current at-least-once dispatch." (line 22)

Activity result reconciliation is a **Tier-0 / roadmap-to-1.0 item** (`weft/documentation/roadmap-to-1.0.md:30`), explicitly "stricter than the current implementation." So:

- We wire `idempotencyKey = tc.id` **for forward-compatibility** — when reconciliation lands upstream, the keys are already in place.
- **Today, a tool that commits an external effect and then crashes before the checkpoint records its result will re-fire on resume.** Non-idempotent tools (sends, writes, charges) can double-execute in that window. Tool authors must supply their own external idempotency for irreversible effects. This is flagged in code and in the tool-authoring docs.

### Recovery requires re-injecting deps — the deeper half of resume (do not imply "just works")

What checkpoints persist is **state** (cursor + transcript snapshot + cached activity results), not **behavior**. The workflow body calls `runStepUpToTools(deps, …)` / `applyToolResults(deps, …)`, where `deps` carries the non-serializable closures — `generate`, `toolbox`, `hooks`, `stopWhen` — sourced from a process-lifetime registry via `getLaunchScopedDeps(runId)`. On a fresh-process recovery (the only crash that matters), **that registry is empty**: `recover:true` relaunches the generator, it reaches the first half, and there is no `generate` to call. Resume does not "just work" — the per-run deps must be **re-injected on recovery** before the generator can advance.

This is distinct from, and deeper than, re-attaching the observable surface (the original seam #5). Both are required for a recovered run to be correct *and* visible. The two are folded together below.

> [!WARNING] The proof test (item 10) must cross a real process boundary
> Calling `Engine.create({ recover: true })` on a fresh engine **in the same process** leaves the deps registry populated, so the test passes while masking exactly this gap — it proves cursor/transcript resume but not crash recovery of a run's behavior. The proof test therefore either spawns a genuinely fresh process **or** explicitly clears the deps registry before recovery, so it can fail for the reason that matters.

### Deferred seams — these become the literal `TODO(weft-integration):` comments

| # | Seam | One-line description |
|---|---|---|
| 1 | `TODO(weft-integration): durable retry counters` | Lift onError do/while (`loop.ts:466-642`) + schema-retry (`loop.ts:972-1015`) to workflow-local loops so `schemaAttempts`/`stepRetryCount` are snapshotted; today they restart from zero on mid-step crash. |
| 2 | `TODO(weft-integration): StepRecord strips Conversation instance` | The plain projection must not embed the `Conversation` class instance (`types.ts:123`) — it fails `validateCloneable` across a yield. |
| 3 | `TODO(weft-integration): compactContext activity + post-compaction snapshot ordering` | `onCompact` (`loop.ts:402`) runs in-memory today; promote to an activity that re-snapshots the transcript so the compacted state is canonical. |
| 4 | `TODO(weft-integration): activity reconciliation for cross-crash tool dedup` | `idempotencyKey` is wired but 0.2.0 gives at-least-once only; revisit when upstream reconciliation lands. |
| 5 | `TODO(weft-integration): re-inject per-run deps AND reconstruct ActiveRun on recovery` | Two-part. (a) **Behavior:** recovered generators have an empty deps registry — `generate`/`toolbox`/`hooks` must be re-injected (re-`getLaunchScopedDeps`) before a resumed run can advance a step. (b) **Visibility:** `store.register` (`create-bureau.ts:416`) only fires on fresh start, so recovered `WorkflowHandle`s also need ActiveRun adapters reconstructed and re-registered, else a resumed run completes invisibly to gateway. Both wire into the `recoverAll` boot path. |
| 6 | `TODO(weft-integration): abortStep has no Weft analog` | Per-step abort that continues to the next step (`loop.ts:332-339`) — `handle.cancel()` kills the whole workflow. Model as activity-timeout + caught error later. |
| 7 | `TODO(weft-integration): cross-worker event bridge via interceptors` | Inline mode keeps the in-process emitter reachable; worker mode needs `EngineOptions.interceptors` (`WorkflowInterceptor.activity(interception, next)` carries input on the context + output via `next`'s return) + `handle.tail()` for WS streaming. |
| 8 | `TODO(weft-integration): scheduled/ambient lanes to engine.schedule + ctx.sleep` | The heartbeat / scheduled / ambient lanes map to durable schedules; the priority dispatcher stays in-process. |
| 9 | `TODO(weft-integration): preemption has no native analog` | The 4-lane preempt-and-requeue scheduler (`create-scheduler.ts:329-361`) has no Weft primitive; requeue = `handle.cancel()` + re-`start` from the persisted cursor. |
| 10 | `TODO(weft-integration): streaming progress is in-process only` | `messageAppended` token deltas (`types.ts:100`) flow through the inline emitter; only the final `GenerateResponse` is durable. Worker-mode streaming needs `ctx.stream` / `StreamSink`. |
| 11 | `TODO(weft-integration): classify hooks by side-effect-ness for resume re-emit` | Read-only hook re-fire on resume is harmless; side-effecting `afterToolExecution` (`loop.ts:892-921`) re-fire is not. Gate re-emission. |
| 12 | `TODO(weft-integration): tune history.maxEvents / checkpointSizeWarningThreshold` | Defaults left in pass 1; set after measuring long-run checkpoint sizes. |

---

## 5. Implementation task list — Phase 3 (foundation), ordered and checkable

Land in this order; each item is independently verifiable.

1. **Pure refactor of `loop.ts` (no behavior change).** Extract `runStepUpToTools(deps, conversation, cursor)` and `applyToolResults(deps, conversation, generated, toolResults)` at the `stepToolbox.execute` boundary (`loop.ts:769`). Re-express `executeLoop()` in terms of both halves. **Check:** the full existing operative test suite passes unchanged (`turbo run test --filter=operative`). This is the anti-duplication foundation — the durable generator will call the *same* halves.
2. **`checkpoint-store.ts` + `types.ts`.** Define `RunCursor` (`{ step }`), `RunCheckpoint`, and the `StepRecord` plain projection (mirrors what `StepCompletedEvent` already flattens, `events.ts`) — explicitly **no `Conversation` instance**. Persistence over a `textValueStore` view keyed `run:{runId}:cursor` / `run:{runId}:transcript` / `run:{runId}:step:{n}`. **Check:** unit round-trip — write a snapshot, `Conversation.from()` it back, assert deep-equal history.
3. **`storage-activities.ts`.** `loadCursor`, `loadConversation`, `recordStep` over the checkpoint store. **Check:** activities are pure-data-in/pure-data-out; no closures leak into inputs.
4. **`execute-tool-activity.ts`.** Wrap `stepToolbox.execute` for a single call; `idempotencyKey = tc.id`; `RetryPolicy`. **Check:** a tool result round-trips through the activity boundary identically to a direct call.
5. **`run-workflow.ts`.** The skeleton from §2.4, driving `runStepUpToTools` / `applyToolResults`, with all twelve `TODO(weft-integration):` comments inline. **Check:** `validateCloneable` is never violated — assert no `Conversation` instance enters a local.
6. **`create-run-engine.ts`.** `Engine.create({ workflows: { agentRun }, activities, storage, recover: true })`. **Check:** engine boots; `engine.start('agentRun', { runId })` returns a `WorkflowHandle`.
7. **`active-run-adapter.ts`.** `ActiveRun` over `engine.start` + `WorkflowHandle`, preserving the synchronous-construct + deferred-microtask-start contract; `result`←`handle.result()`, `abort`→`handle.cancel()`, events via the in-process emitter (inline). **Check:** the existing `ActiveRun` event-ordering tests pass against the adapter.
8. **Wire `runtime-composition.ts`.** Keep the raw `Storage` from `resolveStorage`, pass it to both `textValueStore(storage, { disposeUnderlyingStorage: false })` and `createRunEngine({ storage })`. Build the engine once at composition. **Check:** one backend, no double-disposal; gateway boots.
9. **Route `run()` / `createRun()` through the adapter** when an engine is present; legacy in-memory path otherwise. **Check:** gateway / sentinel / herald compile and their suites pass with **0 file changes**.
10. **The single proof test (the foundation gate).** Start an `agentRun`; crash mid-run (after step N's complete `recordStep`) **across a real process boundary** — spawn a fresh process for recovery, or explicitly clear the per-run deps registry first, so the test cannot pass on a warm registry. Re-inject the run's deps, `Engine.create({ recover: true })`, and assert **(a)** the run resumes at step N+1, not 0, with the conversation intact; **(b)** checkpoint size stays **O(1) per step** (the bloat `validateCloneable` won't catch); **(c)** no `Conversation` instance was ever checkpointed (the run completes without a `validateCloneable` throw). One integration test in `packages/integration`.
11. **`TODO(weft-integration): re-inject deps + reconstruct ActiveRun` wired as a real seam** — a `recoverAll` callback site in bureau composition that, per recovered handle, **(a)** re-injects `generate`/`toolbox`/`hooks` into the deps registry so the run can advance, and **(b)** reconstructs + registers an ActiveRun adapter so the run is visible. Stub + TODO if not fully implemented, but the hook must exist — without (a) a resumed run stalls; without (b) it completes invisibly.
12. **Run `turbo run validate`** (format / lint / check-types / test) across affected packages. **Check:** green.

---

## 6. Nice-to-have Weft upstream changes

These fall straight out of the seams and are written to `../weft/tmp/requests-from-agent-bureau`. Each would let agent-bureau delete a seam rather than carry it.

1. **Activity result reconciliation / cross-crash `idempotencyKey` dedup** (the big one — ties to seams 4). Today `idempotencyKey` does not survive the crash-after-effect-before-checkpoint window (`tier-0-behavioral-contract.md:11,22`). Landing Tier-0 reconciliation turns at-least-once into reconciled-once for keyed activities, which is exactly what non-idempotent tools need.
2. **Per-step / sub-workflow abort that does not kill the whole workflow** (seam 6). `abortStep` (cancel one step, continue) has no analog; `handle.cancel()` is all-or-nothing. A cancellable scoped operation inside a workflow would map cleanly.
3. **A priority / preemption scheduler primitive** (seams 8, 9). `engine.schedule` covers durable cron/interval, but there is no preempt-and-requeue with priority lanes + budget gating. Even a documented pattern (cancel + re-start-from-cursor with a priority attribute) would help.
4. **A `recoverAll` observer-reattach hook** (seam 5). A callback invoked per recovered `WorkflowHandle` on boot would let consumers re-attach their observable surface (our ActiveRun adapter + `store.register`) without polling for recovered runs.

---

### Summary in one line

Land HYBRID's pure `loop.ts` split first (one code path, no fork), drive those same halves from a thin WRAP-style durable generator whose only side-effect activity is `executeTool`, make generate durable via snapshot-before-tool-yield + a restored cloneable projection, preserve `ActiveRun` verbatim under inline mode, and mark the twelve deferred paths — durable retry counters, compaction, cross-crash dedup, recovery re-registration, cross-worker events, schedules, preemption — as explicit `TODO(weft-integration):` seams, proven real by one resume-from-N + O(1)-checkpoint-size test.
