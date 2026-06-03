import { workflow } from '@lostgradient/weft';
import { Conversation, isConversation } from 'conversationalist';

import { BudgetExceededError, ElicitationDeniedError } from '../errors';
import { buildStepDeps, createRunState } from '../loop';
import { DEFAULT_MAXIMUM_STEPS, runStep } from '../run-step';
import type { FinishReason } from '../types';
import type { CheckpointStore } from './checkpoint-store';
import { ensureRunDeps, getRunDeps } from './deps-registry';
import { createStorageActivities } from './storage-activities';
import type { RunCursor, StepRecord } from './types';

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
 * TODO(weft-integration): #11 classify hooks by side-effect-ness for resume —
 *   on resume a step re-runs from its boundary, so any side-effecting hook inside
 *   the re-run step fires again. Read-only hooks are harmless; side-effecting
 *   ones need gating.
 * TODO(weft-integration): #4 cross-crash tool dedup — tools re-run on a mid-step
 *   crash; 0.2.0 gives at-least-once only, so non-idempotent tools can double
 *   execute. Tool authors must supply their own idempotency for irreversible
 *   effects.
 */

/** Input to the durable agent-run workflow. */
export interface AgentRunWorkflowInput {
  runId: string;
  /** The first user message to seed a brand-new run (ignored on resume). */
  prompt?: string;
  /** Safety bound on step count, mirroring `RunOptions.maximumSteps`. */
  maximumSteps?: number;
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
 * Builds the durable `agentRun` workflow over the given {@link CheckpointStore}.
 * The storage activities are created from the same store the engine persists to,
 * so the workflow's reads and writes share one backend.
 */
export function createRunWorkflow(checkpointStore: CheckpointStore) {
  const storage = createStorageActivities(checkpointStore);

  return workflow({ name: 'agentRun' })
    .activities({
      saveCursor: storage.saveCursor,
      saveConversation: storage.saveConversation,
      recordStep: storage.recordStep,
    })
    .execute(async function* (ctx, input: AgentRunWorkflowInput) {
      const { runId } = input;
      const maximumSteps = input.maximumSteps ?? DEFAULT_MAXIMUM_STEPS;

      // CRITICAL: `getRunDeps` is resolved ONLY inside no-`yield*` regions, never
      // held as a local across a yield. `deps` holds non-serializable closures
      // (generate, toolbox, hooks, emitter); keeping it live across a checkpoint
      // would fail validateCloneable or be lost on resume. Same rule as the
      // Conversation instance and the contaminated RunState.

      // RECOVERY (seam #5): on a fresh-process resume the deps registry is empty.
      // Reconstruct this run's behavior from durable config before the first step
      // needs it. This is a PLAIN `await`, NOT a `ctx.run` activity: an activity
      // result is checkpointed and replayed on recovery, so it would return the
      // ORIGINAL process's cached value (`true`) and never re-reconstruct in the
      // fresh process. A plain await re-runs on every replay, so recovery actually
      // re-evaluates. If the behavior cannot be reconstructed (an ad-hoc closure
      // with no durable config), terminate this run safely instead of bricking.
      const depsReady = await ensureRunDeps(runId);
      if (!depsReady) {
        ctx.setAttribute('runId', runId);
        return {
          runId,
          steps: 0,
          content: '',
          finishReason: 'error',
          errorMessage: `Durable run "${runId}" could not be recovered: its behavior (generate/toolbox/hooks) was not reconstructable from durable configuration.`,
        } satisfies AgentRunWorkflowResult;
      }

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
        const options = getRunDeps(runId).options;
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
          const deps = getRunDeps(runId);
          const conversation = Conversation.from(snapshot);
          // Build StepDeps from the run's options (one code path with executeLoop),
          // overriding only the toolbox with the registry's (variance-widened) one.
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

          const outcome = await runStep(stepDeps, runState, conversation, stepIndex, deps.emitter);

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
          };
        });

        snapshot = stepResult.conversationSnapshot;

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
          break;
        }
        if (outcome.kind === 'abort') {
          finishReason = 'aborted';
          abortReason = stepResult.abortReason;
          break;
        }
        if (outcome.kind === 'error') {
          // Use the finish reason CLASSIFIED inside the memo (where the error's
          // class identity was still live) so a durable run distinguishes
          // elicitation-denied / budget-exceeded from a plain error, matching
          // the in-memory loop.
          finishReason = stepResult.errorFinishReason ?? 'error';
          errorMessage = stepResult.errorMessage;
          break;
        }
        // `next` / `continue` — loop to the next step.
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
      } satisfies AgentRunWorkflowResult;
    });
}
