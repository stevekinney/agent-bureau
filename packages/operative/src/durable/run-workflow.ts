import { workflow } from '@lostgradient/weft';
import { Conversation, isConversation } from 'conversationalist';

import { buildStepDeps, createRunState } from '../loop';
import { runStep } from '../run-step';
import type { FinishReason } from '../types';
import type { CheckpointStore } from './checkpoint-store';
import { getRunDeps } from './deps-registry';
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
}

const DEFAULT_MAXIMUM_STEPS = 25;

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
      loadCursor: storage.loadCursor,
      loadConversation: storage.loadConversation,
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
      // Conversation instance and the contaminated RunState. On cross-process
      // recovery the deps registry must be re-injected first (seam #5).

      // DURABLE LOCALS — both plain/cloneable. Resume rehydrates them from store.
      let cursor: RunCursor = (yield* ctx.run('loadCursor', { runId })) ?? initialCursor();
      let snapshot = yield* ctx.run('loadConversation', { runId });

      // Seed a fresh run's conversation with the prompt, then persist it so a
      // resume before step 0 completes still sees the seeded transcript.
      if (snapshot === null) {
        const options = getRunDeps(runId).options;
        const seeded = isConversation(options.conversation)
          ? options.conversation
          : new Conversation(options.conversation);
        if (input.prompt !== undefined) {
          seeded.appendUserMessage(input.prompt);
        }
        snapshot = seeded.snapshot();
        yield* ctx.run('saveConversation', { runId, snapshot });
      }

      let finishReason: FinishReason = 'maximum-steps';

      while (cursor.step < maximumSteps) {
        // === IN-MEMORY step region (no `yield*`). The deps closures, the live
        // Conversation instance, the contaminated RunState, and the StepResult it
        // accumulates are ALL born and die here, before the next yield — so none
        // ever crosses a checkpoint boundary. `runStep` runs the entire step,
        // including in-process tool execution, exactly as `executeLoop` does. ===
        const stepResult = await (async () => {
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
          runState.totalUsage = { ...cursor.totalUsage };
          runState.lastContent = cursor.lastContent;
          runState.schemaAttempts = cursor.schemaAttempts;

          const outcome = await runStep(
            stepDeps,
            runState,
            conversation,
            cursor.step,
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

          return {
            outcome,
            record,
            conversationSnapshot: conversation.snapshot(),
            nextAccumulators: {
              totalUsage: runState.totalUsage,
              lastContent: runState.lastContent,
              schemaAttempts: runState.schemaAttempts,
            },
          };
        })();

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
          finishReason = outcome.finishReason;
          break;
        }
        if (outcome.kind === 'abort') {
          finishReason = 'aborted';
          break;
        }
        if (outcome.kind === 'error') {
          finishReason = 'error';
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
      } satisfies AgentRunWorkflowResult;
    });
}
