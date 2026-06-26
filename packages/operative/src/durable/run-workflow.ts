import { workflow } from '@lostgradient/weft';
import { Conversation, isConversation } from 'conversationalist';

import { BudgetExceededError, ElicitationDeniedError } from '../errors';
import { RunErrorEvent } from '../events';
import { buildStepDeps, createRunState } from '../loop';
import { DEFAULT_MAXIMUM_STEPS, runStep } from '../run-step';
import type { FinishReason } from '../types';
import type { CheckpointStore } from './checkpoint-store';
import { createStorageActivities } from './storage-activities';
import type {
  DurableRunDeps,
  PendingHumanWait,
  PendingWakeup,
  RunCursor,
  StepRecord,
} from './types';

/**
 * The durable agent-run workflow.
 *
 * This is the **single-code-path durable driver**. It does NOT reimplement the
 * step body: it calls the exact same {@link runStep} the in-memory `executeLoop`
 * calls, once per checkpointed step. Under inline mode the generator runs
 * in-process, so `runStep` emits to the same event emitter, runs the same hooks,
 * applies the same retry/schema/compaction/guardrail logic, and executes tools
 * the same way — happy-path behavior is byte-identical to a non-durable run,
 * because it is the same code. What the durable path adds is a checkpoint at
 * each step boundary, so a crash resumes from the last completed step.
 *
 * @remarks
 * The load-bearing invariant: **no `Conversation` instance and no contaminated
 * `RunState` is ever a live workflow local across a `yield*`.** `runStep` runs
 * entirely inside a no-`yield*` region (a plain `await`): it rehydrates a fresh
 * `Conversation.from(snapshot)`, mutates it, and pushes a `StepResult` (which
 * embeds that live `Conversation`) into a freshly-built `RunState.steps`. Before
 * the next `yield*`, that step is projected to a plain {@link StepRecord} (no
 * `Conversation`), the transcript is re-snapshotted, and the contaminated
 * instances go out of scope. Only plain, cloneable data — the {@link RunCursor}
 * (step index + accumulators) and the conversation snapshot — crosses a
 * checkpoint boundary.
 *
 * **Durability granularity is one whole step** (generate + tools together). This
 * is a forced consequence of the one-code-path design: `yield*` cannot cross
 * into the plain-`async` `runStep`, so tool execution cannot be a finer-grained
 * activity without splitting the step body (which would fork the loop). The cost
 * is exactly what the design doc §4 documents and accepts: a crash mid-step
 * re-runs that step, i.e. at most one re-charged LLM call per crash.
 *
 * Deferred seams (these only degrade the resume window, never the happy path):
 *
 * TODO(weft-integration): #1 durable in-step retry counters — `runStep`'s
 *   internal `onError` do/while and schema-retry decisions are not individually
 *   checkpointed, so a mid-step crash re-runs the whole step's retries from the
 *   step boundary rather than the exact retry attempt.
 * #11 hook side-effect-ness on resume — RESOLVED via idempotency, not gating.
 *   On resume the crashed in-flight step re-runs from its boundary, so a
 *   side-effecting hook inside it fires again (at-least-once) — the SAME contract
 *   as side-effecting tools (#4 ADR below). The fix is to make effectful hooks
 *   idempotent, NOT to skip them on replay: skipping would drop the side effect
 *   for a step whose work (generate + tools) DID re-execute, leaving external
 *   state out of sync with a step that ran. Read-only hooks are harmless and need
 *   nothing. The gateway's only effectful run hook, `createMemoryPersistHook`, is
 *   idempotent via a DETERMINISTIC `${runId}:${step}` dedupe key (NOT content —
 *   a replayed step can regenerate different content): it skips the write when a
 *   memory already carries that key, so a re-fire is a guaranteed no-op. Hooks
 *   carry a `replay: 'safe' | 'effectful'` classification (lifecycle
 *   `HookRegistrationOptions`) for documentation/diagnostics; it does NOT gate
 *   execution. Earlier plan to filter effectful hooks on replay was rejected as
 *   unsound (skipped-side-effect semantics + fragile function-identity tracking).
 *
 * #4 sub-step tool durability — the `runStep` split is REJECTED (do not
 *   re-attempt): durability granularity is one whole step (generate + all its
 *   tools), so a crash after generate but before the step memo commits re-runs the
 *   step and re-executes its tools (at-least-once). Splitting `runStep` to
 *   checkpoint tool execution independently is unsound (a live `Conversation`
 *   cannot cross a `yield*`; `response` carries non-cloneable SDK objects;
 *   `stepToolbox` is hook-mutated) and the payoff is marginal (`ctx.memo` already
 *   frees completed steps). Side-effecting tools use armorer's existing
 *   content-keyed `withIdempotency` instead. Full ADR + the upstream primitive
 *   (weft#444): documentation/weft-030-recovery-rewrite-design.md.
 * #6 structured-error fidelity — `registerSerializer(ZodError)` is NOT wired
 *   (no consumer reads the structured error off the terminal durable result, and
 *   it would make the schema-validation path depend on a global one-shot
 *   registration to not throw). Rationale + one-liner to enable: same design doc.
 */

/** Input to the durable agent-run workflow. */
export interface AgentRunWorkflowInput {
  runId: string;
  /**
   * The bureau session that owns this run. Carried in the durable input (not a
   * side table) so boot recovery can correlate a recovered `WorkflowHandle` back
   * to its session — the resolver reads it as `info.input.sessionId` and
   * `recoverDurableRuns` reads it via `handle.getLaunchMetadata()` — without
   * scanning the session store by `lastRunId`. A plain cloneable string, safe to
   * checkpoint.
   */
  sessionId: string;
  /**
   * The name of the agent that owns this run (F2 — RunRef.agentName).
   *
   * Carried in the durable input (not a side table) so a recovered workflow can
   * be correlated to its owning agent without reading the session store. A session
   * may be worked by a SEQUENCE of different agents over time (via handoff);
   * agentName on each workflow uniquely identifies which agent ran each run.
   */
  agentName: string;
  /** The first user message to seed a brand-new run (ignored on resume). */
  prompt?: string;
  /** Safety bound on step count, mirroring `RunOptions.maximumSteps`. */
  maximumSteps?: number;
}

/**
 * Narrow an `unknown` durable input (as Weft surfaces it via
 * `resolveWorkflowServices`'s `info.input` and `WorkflowHandle.getLaunchMetadata`)
 * to an {@link AgentRunWorkflowInput}. A type guard, not an `as` cast: the input
 * crosses the checkpoint as plain JSON, so its shape must be validated at the
 * trust boundary. Requires the three correlation fields recovery depends on
 * (`runId`, `sessionId`, `agentName`); a run checkpointed before `agentName` was
 * added to the input fails this guard and is treated as not-reconstructable (no
 * compatibility-bridge fallback — cross-upgrade in-flight runs are out of scope).
 */
export function isAgentRunWorkflowInput(value: unknown): value is AgentRunWorkflowInput {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate['runId'] !== 'string' ||
    typeof candidate['sessionId'] !== 'string' ||
    typeof candidate['agentName'] !== 'string'
  ) {
    return false;
  }
  // Validate the optional fields too, so a narrowed value is sound end-to-end
  // (not just for the three correlation fields recovery keys on).
  const prompt = candidate['prompt'];
  if (prompt !== undefined && typeof prompt !== 'string') return false;
  const maximumSteps = candidate['maximumSteps'];
  if (maximumSteps !== undefined && typeof maximumSteps !== 'number') return false;
  return true;
}

/** Plain, cloneable summary returned when the durable run completes. */
export interface AgentRunWorkflowResult {
  runId: string;
  steps: number;
  content: string;
  finishReason: FinishReason;
  /**
   * Serialized message of the error that ended the run, when `finishReason` is
   * `error` / `elicitation-denied` / `budget-exceeded`. The live error object is
   * not cloneable across a checkpoint, so only its message survives; the adapter
   * rebuilds an `Error` from it so consumers (e.g. gateway's `lastError`) see the
   * real cause rather than a synthetic placeholder.
   */
  errorMessage?: string;
  /** The abort reason, when `finishReason` is `aborted`. */
  abortReason?: string;
  /**
   * The structured-output validation outcome, when the run stopped after a
   * `responseSchema` was applied. Mirrors `RunResult.schemaValidation` on the
   * in-memory path; `success` — the load-bearing bit — is preserved exactly.
   *
   * KNOWN SEAM (structural fidelity of `error`): the in-memory path puts the
   * LIVE validation error in `schemaValidation.error` (typically a `ZodError`
   * with structured `.issues`); a live error is not cloneable across a
   * checkpoint, so the durable path serializes it to its message and the adapter
   * rebuilds a plain `Error(message)`. A consumer reading `error.issues` /
   * `error.name` therefore sees the structured error in-memory but a plain
   * `Error` on the durable path. This matches the same structural-vs-identity
   * boundary already accepted for terminal `RunResult.error` (stack/cause are
   * likewise reduced to a message) and for conversations (snapshots, not
   * instances). operative cannot faithfully reconstruct an arbitrary user
   * schema library's error type; `success` is the contract, the error shape is
   * best-effort.
   */
  schemaValidation?: { success: boolean; error?: string };
  /**
   * The note from a `scheduleWakeup` call, when the agent self-scheduled a
   * wakeup during this run (D6 — self-scheduling tools). Carries the note the
   * agent attached to the wakeup request so the next run knows why it resumed.
   * Absent when no wakeup was scheduled.
   */
  wakeupNote?: string;
  /**
   * F3 — The signal name the run parked on via `requestHumanInput`. Present
   * when the agent called `requestHumanInput({ signalName })` during this run
   * and the workflow parked via `yield* ctx.waitForSignal(signalName)`. Callers
   * can surface this so the next run knows which signal triggered its resume.
   */
  humanWaitSignal?: string;
}

/** Serialize an unknown error to a stable message string for the checkpoint. */
function serializeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/**
 * Classify a terminal error into a {@link FinishReason}, identically to
 * `makeErrorResult` in run-lifecycle.ts. Called INSIDE the memo where the live
 * error object still exists (its class identity is lost once serialized across
 * the checkpoint), so the durable path distinguishes `elicitation-denied` and
 * `budget-exceeded` from a plain `error` exactly as the in-memory loop does.
 */
function classifyErrorFinishReason(error: unknown): FinishReason {
  if (error instanceof ElicitationDeniedError) return 'elicitation-denied';
  if (error instanceof BudgetExceededError) return 'budget-exceeded';
  return 'error';
}

/** The fresh cursor for a brand-new run: step 0, zeroed accumulators. */
function initialCursor(): RunCursor {
  return {
    step: 0,
    totalUsage: { prompt: 0, completion: 0, total: 0 },
    lastContent: '',
    schemaAttempts: 0,
  };
}

/**
 * Narrow the engine-provided `ctx.services` to this run's {@link DurableRunDeps}.
 *
 * Weft 0.2.1 types `ctx.services` as `unknown`; the engine guarantees it is the
 * exact value supplied at `engine.start(type, input, { services })` — or the
 * value `resolveWorkflowServices` rebuilt on a cross-process recovery — for this
 * specific run. `DurableRunDeps` holds live, non-serializable closures
 * (`generate`, `toolbox`, hooks, emitter), so it cannot be validated with a
 * runtime schema; this single documented cast at the engine trust boundary is
 * the only `as` in this module. Call it ONLY inside no-`yield*` regions: the deps
 * must never be held as a live workflow local across a checkpoint.
 */
function runDepsFrom(services: unknown): DurableRunDeps {
  return services as DurableRunDeps;
}

/**
 * Builds the durable `agentRun` workflow over the given {@link CheckpointStore}.
 * The storage activities are created from the same store the engine persists to,
 * so the workflow's reads and writes share one backend.
 */
export function createRunWorkflow(checkpointStore: CheckpointStore) {
  const storage = createStorageActivities(checkpointStore);

  return (
    workflow({ name: 'agentRun' })
      .activities({
        saveCursor: storage.saveCursor,
        saveConversation: storage.saveConversation,
        recordStep: storage.recordStep,
      })
      // A Weft workflow body MUST be an `async function*`: every durable operation
      // goes through `yield*` (ctx.run / ctx.memo), never a bare top-level `await`
      // — a bare await would not be checkpointed. So the generator correctly has no
      // own-level `await`; require-await is a false positive for this pattern.
      // eslint-disable-next-line @typescript-eslint/require-await -- Weft durable generator: async work flows through yield*, not a top-level await.
      .execute(async function* (ctx, input: AgentRunWorkflowInput) {
        const { runId } = input;
        const maximumSteps = input.maximumSteps ?? DEFAULT_MAXIMUM_STEPS;

        // CRITICAL: `ctx.services` (via `runDepsFrom`) is read ONLY inside
        // no-`yield*` regions, never held as a local across a yield. The deps hold
        // non-serializable closures (generate, toolbox, hooks, emitter); keeping
        // them live across a checkpoint would fail validateCloneable or be lost on
        // resume. Same rule as the Conversation instance and the contaminated
        // RunState.
        //
        // RECOVERY (seam #5): on a fresh-process resume the engine re-provides this
        // run's deps through `resolveWorkflowServices` BEFORE the generator advances
        // (see create-run-engine.ts), so `ctx.services` is populated here without
        // any in-workflow reconstruction step. A run whose deps cannot be rebuilt is
        // failed terminally by the engine before replay — the body never sees it —
        // so there is no "could not reconstruct" branch to own here anymore.

        // DURABLE WORKFLOW LOCALS. These are the resume position — Weft snapshots
        // live locals at every `yield*` and restores them on resume, so the cursor
        // and transcript survive a crash WITHOUT being re-read through an activity.
        // (Re-reading via a load activity is wrong: Weft caches the activity's first
        // result and replays that stale value on resume, defeating the reload.) Both
        // are plain/cloneable: `cursor` is `{ step, accumulators }`, `snapshot` is a
        // structuredClone-safe `ConversationSnapshot` tree — never a `Conversation`
        // instance. The checkpoint-store writes below exist only so the ActiveRun
        // adapter can reconstruct the RunResult post-completion; they are not the
        // workflow's own resume mechanism.
        let cursor: RunCursor = initialCursor();

        // Seed the conversation on the first run from the run's options + prompt,
        // then persist it so the adapter and any external reader see the transcript.
        const seededConversation = (() => {
          const options = runDepsFrom(ctx.services).options;
          const seeded = isConversation(options.conversation)
            ? options.conversation
            : new Conversation(options.conversation);
          if (input.prompt !== undefined) {
            seeded.appendUserMessage(input.prompt);
          }
          return seeded.snapshot();
        })();
        let snapshot = seededConversation;
        yield* ctx.run('saveConversation', { runId, snapshot });

        let finishReason: FinishReason = 'maximum-steps';
        let errorMessage: string | undefined;
        let abortReason: string | undefined;
        let schemaValidation: { success: boolean; error?: string } | undefined;
        // True when a terminal outcome (stop/abort/error) broke the loop early.
        // False means the loop exhausted `maximumSteps` naturally — the only case
        // where `onMaximumSteps` should run, mirroring `executeLoop` exactly.
        let stoppedEarly = false;

        // === Durable park-request locals (D6 + F3 recovery fix) ===
        // These accumulate the LAST pending park request (wakeup or human-wait)
        // from step results. The tool mutations happen inside `ctx.memo` (where
        // `deps` is live), so the values are captured in the memo return value and
        // survive a crash+recovery: on replay each memo short-circuits to its
        // checkpointed result, which carries the park request the tool set. This
        // is the ONLY source of park state used post-loop — we no longer read
        // `ctx.services` for this purpose, because services are rebuilt fresh on
        // recovery (with `pendingWakeup`/`pendingHumanWait` unset). Last-write-wins
        // matches the in-process tool semantics (multiple wakeup calls overwrite).
        let pendingWakeup: PendingWakeup | undefined;
        let pendingHumanWait: PendingHumanWait | undefined;

        while (cursor.step < maximumSteps) {
          // === The whole step runs inside `ctx.memo`, keyed by step index. This is
          // what makes the in-process step durable across RECOVERY (not just the
          // happy path): on a crash + recoverAll, Weft restarts the generator from
          // the top and short-circuits each `ctx.memo` to its checkpointed result
          // WITHOUT re-running the function — so every COMPLETED step's generate +
          // tool execution is skipped, and only the in-flight (un-memoized) step
          // re-runs. Without memo, the in-process generate would re-execute from
          // step 0 on recovery (re-charging the LLM), because plain in-process code
          // is re-run during replay. The memo's return value is the plain, cloneable
          // step projection — no `Conversation` instance, no live error. ===
          const stepIndex = cursor.step;
          const carriedAccumulators = {
            totalUsage: cursor.totalUsage,
            lastContent: cursor.lastContent,
            schemaAttempts: cursor.schemaAttempts,
          };
          const stepResult = yield* ctx.memo(`step-${stepIndex}`, async () => {
            const deps = runDepsFrom(ctx.services);
            const conversation = Conversation.from(snapshot);
            // Build StepDeps from the run's options (one code path with executeLoop),
            // overriding only the toolbox with the per-run (variance-widened) one
            // the engine supplied via `ctx.services`.
            const stepDeps = {
              ...buildStepDeps(deps.options),
              toolbox: deps.toolbox,
            };
            // Carry the accumulators forward; start `steps` empty so this iteration
            // accumulates exactly the one StepResult it produces (and nothing that
            // would otherwise need to cross a yield).
            const runState = createRunState();
            runState.totalUsage = { ...carriedAccumulators.totalUsage };
            runState.lastContent = carriedAccumulators.lastContent;
            runState.schemaAttempts = carriedAccumulators.schemaAttempts;

            const outcome = await runStep(
              stepDeps,
              runState,
              conversation,
              stepIndex,
              deps.emitter,
            );

            // Project the (at most one) pushed StepResult to a plain StepRecord —
            // dropping the live Conversation instance — and re-snapshot the
            // transcript. Everything returned here is plain and cloneable.
            const pushed = runState.steps[runState.steps.length - 1];
            const record: StepRecord | null = pushed
              ? {
                  step: pushed.step,
                  content: pushed.content,
                  toolCalls: pushed.toolCalls,
                  results: pushed.results,
                  ...(pushed.usage ? { usage: pushed.usage } : {}),
                  ...(pushed.metadata ? { metadata: pushed.metadata } : {}),
                  final: pushed.final,
                }
              : null;

            // Serialize terminal metadata here, inside the function, where the live
            // (non-cloneable) error object and validation error still exist. Only
            // plain data is memoized. The error finish reason is CLASSIFIED here
            // (elicitation-denied / budget-exceeded / error) because the error's
            // class identity does not survive serialization — matching the
            // in-memory `makeErrorResult`. The `schemaValidation` is carried so a
            // durable run produces the SAME `RunResult.schemaValidation` shape as
            // the in-memory loop (its live error is reduced to a message).
            //
            // pendingWakeup and pendingHumanWait are read from `deps` HERE (where
            // the tool's live mutation already landed) and embedded in the memoized
            // return value. This is critical for recovery correctness: if the process
            // crashes after this memo commits but before the post-loop park executes,
            // Weft re-runs the generator and short-circuits this memo to its
            // checkpointed result — which includes the park request. The post-loop
            // code reads these from the accumulated step results rather than from the
            // rebuilt `ctx.services`, which would be freshly constructed (unset) on
            // recovery. `PendingWakeup`/`PendingHumanWait` are plain, cloneable
            // objects (duration is number|string, signalName is string), so they
            // cross the checkpoint boundary safely.
            return {
              outcome: { kind: outcome.kind },
              errorMessage: outcome.kind === 'error' ? serializeError(outcome.error) : undefined,
              errorFinishReason:
                outcome.kind === 'error' ? classifyErrorFinishReason(outcome.error) : undefined,
              abortReason: outcome.kind === 'abort' ? outcome.reason : undefined,
              stopFinishReason: outcome.kind === 'stop' ? outcome.finishReason : undefined,
              schemaValidation:
                outcome.kind === 'stop' && outcome.schemaValidation
                  ? {
                      success: outcome.schemaValidation.success,
                      ...(outcome.schemaValidation.error !== undefined
                        ? { error: serializeError(outcome.schemaValidation.error) }
                        : {}),
                    }
                  : undefined,
              record,
              conversationSnapshot: conversation.snapshot(),
              nextAccumulators: {
                totalUsage: runState.totalUsage,
                lastContent: runState.lastContent,
                schemaAttempts: runState.schemaAttempts,
              },
              pendingWakeup: deps.pendingWakeup,
              pendingHumanWait: deps.pendingHumanWait,
            };
          });

          snapshot = stepResult.conversationSnapshot;

          // Accumulate park requests from this step's memoized result. Last-write-
          // wins across steps, matching the in-process tool semantics (a later
          // `scheduleWakeup`/`requestHumanInput` call overwrites a prior one).
          //
          // MUTUAL EXCLUSIVITY INVARIANT: `pendingWakeup` and `pendingHumanWait`
          // are mutually exclusive — only one park type governs after the loop
          // (DurableRunDeps contract). Enforced here by clearing the OTHER local
          // whenever one is set, so the last-set value wins even across steps.
          // Within a single step's memo result, both could be present if the agent
          // called both tools (an unusual but valid sequence); the `pendingHumanWait`
          // check runs second, so it clears a same-step `pendingWakeup`, matching
          // the reasonable user expectation that an explicit human-input request
          // supersedes an autonomous wakeup schedule.
          if (stepResult.pendingWakeup !== undefined) {
            pendingWakeup = stepResult.pendingWakeup;
            pendingHumanWait = undefined;
          }
          if (stepResult.pendingHumanWait !== undefined) {
            pendingHumanWait = stepResult.pendingHumanWait;
            pendingWakeup = undefined;
          }

          // === Durable commits — all plain data. Order: transcript, then the
          // step record (if any), then the advanced cursor last, so a crash
          // between commits never advances the cursor past un-persisted state. ===
          yield* ctx.run('saveConversation', { runId, snapshot });
          if (stepResult.record !== null) {
            yield* ctx.run('recordStep', { runId, record: stepResult.record });
          }

          const { outcome } = stepResult;

          // A `stop`, `next`, or `continue` all mean the step at `cursor.step`
          // finished its turn — the cursor advances, matching the in-memory `for`
          // loop where both a fall-through and a `continue` run the increment (a
          // skipped step, per-step abort, or schema-retry consumes a step index).
          // An `abort`/`error` aborts mid-step with no completed record, so the
          // cursor stays put: a resumed run re-attempts this same step. `steps` in
          // the result is therefore the count of completed steps, identical to
          // `RunResult.steps.length` in `executeLoop`.
          const aborted = outcome.kind === 'abort' || outcome.kind === 'error';
          cursor = {
            step: aborted ? cursor.step : cursor.step + 1,
            ...stepResult.nextAccumulators,
          };
          yield* ctx.run('saveCursor', { runId, cursor });

          if (outcome.kind === 'stop') {
            finishReason = stepResult.stopFinishReason ?? 'stop-condition';
            schemaValidation = stepResult.schemaValidation;
            stoppedEarly = true;
            break;
          }
          if (outcome.kind === 'abort') {
            finishReason = 'aborted';
            abortReason = stepResult.abortReason;
            stoppedEarly = true;
            break;
          }
          if (outcome.kind === 'error') {
            // Use the finish reason CLASSIFIED inside the memo (where the error's
            // class identity was still live) so a durable run distinguishes
            // elicitation-denied / budget-exceeded from a plain error, matching
            // the in-memory loop.
            finishReason = stepResult.errorFinishReason ?? 'error';
            errorMessage = stepResult.errorMessage;
            stoppedEarly = true;
            break;
          }
          // `next` / `continue` — loop to the next step.
        }

        // === onMaximumSteps tail — parity with executeLoop ===
        // When the loop exhausted `maximumSteps` without a terminal outcome (stop
        // / abort / error), call `options.onMaximumSteps` exactly once, mirroring
        // executeLoop lines 141-158. Wrapped in `ctx.memo` so a crash-then-
        // recover does NOT re-charge the LLM call: Weft short-circuits the memo
        // to its checkpointed result on replay, just as it does for per-step
        // memos. `finishReason` stays `'maximum-steps'` regardless of the handler
        // return value — matching the in-memory path. On error, dispatch
        // RunErrorEvent (parity with executeLoop) and short-circuit the return.
        if (!stoppedEarly) {
          const finalStep = cursor.step;
          const tail = yield* ctx.memo('on-maximum-steps', async () => {
            const deps = runDepsFrom(ctx.services);
            const handler = deps.options.onMaximumSteps;
            if (!handler) return { kind: 'noop' as const };
            const conversation = Conversation.from(snapshot);
            try {
              const finalContent = await handler({
                conversation,
                step: finalStep,
                signal: deps.options.signal,
              });
              if (typeof finalContent !== 'string') return { kind: 'noop' as const };
              conversation.appendAssistantMessage(finalContent);
              return {
                kind: 'content' as const,
                finalContent,
                conversationSnapshot: conversation.snapshot(),
              };
            } catch (error) {
              deps.emitter?.dispatch(new RunErrorEvent(finalStep, error));
              return {
                kind: 'error' as const,
                errorMessage: serializeError(error),
                errorFinishReason: classifyErrorFinishReason(error),
              };
            }
          });

          if (tail.kind === 'content') {
            snapshot = tail.conversationSnapshot;
            cursor = { ...cursor, lastContent: tail.finalContent };
            yield* ctx.run('saveConversation', { runId, snapshot });
            yield* ctx.run('saveCursor', { runId, cursor });
          } else if (tail.kind === 'error') {
            finishReason = tail.errorFinishReason;
            errorMessage = tail.errorMessage;
          }
        }

        // === Durable park — exactly one of wakeup or human-wait fires (never both). ===
        // `pendingWakeup` / `pendingHumanWait` were accumulated above from step memo
        // results — they are checkpointed values, NOT `ctx.services` fields. This is
        // the fix for the durable-recovery bug: on a crash AFTER the step memo commits
        // but BEFORE this park executes, Weft replays the generator and short-circuits
        // each memo to its checkpointed result. `ctx.services` is rebuilt fresh on
        // recovery (with both fields unset), so reading from services here would
        // silently skip the park. Reading from the hoisted locals (fed from
        // checkpointed step results) survives recovery correctly.
        //
        // The two locals are kept MUTUALLY EXCLUSIVE by the accumulation loop above:
        // setting one clears the other. The `else if` below is defense-in-depth —
        // it guarantees exactly one park primitive fires regardless of accumulation
        // state, so the workflow cannot sleep AND then wait for a signal in sequence.
        //
        // CRITICAL: Only park on successful / maximum-steps outcomes. A terminal
        // failure (`error`, `aborted`, `elicitation-denied`, `budget-exceeded`) must
        // return immediately — parking on a failed/aborted run would leave the Weft
        // workflow status as `running` until the sleep/signal fires, hiding the real
        // outcome and blocking the caller from seeing the error result. This covers
        // both a failing step (outcome.kind === 'abort' | 'error') and a failing
        // `onMaximumSteps` handler (tail.kind === 'error'), because both update
        // `finishReason` before we reach this point.
        const isFailureOutcome =
          finishReason === 'error' ||
          finishReason === 'aborted' ||
          finishReason === 'elicitation-denied' ||
          finishReason === 'budget-exceeded';
        if (!isFailureOutcome && pendingWakeup !== undefined) {
          yield* ctx.sleep(pendingWakeup.duration);
        } else if (!isFailureOutcome && pendingHumanWait !== undefined) {
          // === F3 — HITL human-input gate (requestHumanInput tool) ===
          yield* ctx.waitForSignal(pendingHumanWait.signalName);
        }

        ctx.setAttribute('runId', runId);

        return {
          runId,
          steps: cursor.step,
          content: cursor.lastContent,
          finishReason,
          ...(errorMessage !== undefined ? { errorMessage } : {}),
          ...(abortReason !== undefined ? { abortReason } : {}),
          ...(schemaValidation !== undefined ? { schemaValidation } : {}),
          // Only include park metadata on non-failure outcomes: a failed/aborted run
          // never actually parks (the park block above is gated on !isFailureOutcome),
          // so surfacing stale park state in the result would mislead callers.
          ...(!isFailureOutcome && pendingWakeup?.note !== undefined
            ? { wakeupNote: pendingWakeup.note }
            : {}),
          ...(!isFailureOutcome && pendingHumanWait !== undefined
            ? { humanWaitSignal: pendingHumanWait.signalName }
            : {}),
        } satisfies AgentRunWorkflowResult;
      })
  );
}
