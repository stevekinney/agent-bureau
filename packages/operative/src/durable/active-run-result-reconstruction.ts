import type { RuntimeServices } from '@lostgradient/lifecycle';
import { HISTORY_CIRCUIT_BREAKER_REASON } from '@lostgradient/weft';
import { Conversation } from 'conversationalist';

import type { ActiveRun } from '../create-run';
import {
  AbortAgentRunError,
  AgentRunError,
  BudgetExceededError,
  ElicitationDeniedError,
  GuardrailTripwireError,
  MaximumStepsExceededError,
} from '../errors';
import type { OperativeEventEmitter } from '../events';
import { createRunState } from '../loop';
import { makeAbortResult, makeCompletedResult, makeErrorResult } from '../run-lifecycle';
import type { RunState } from '../run-step';
import { type FinishReason, type RunOptions, type RunResult } from '../types';
import type { DurableActiveRunContext } from './active-run-adapter';
import { type AgentRunWorkflowResult } from './run-workflow-result';

export async function loadRunStateFromCheckpoint(
  context: DurableActiveRunContext,
  runId: string,
  runtime: RuntimeServices,
): Promise<{ runState: RunState; conversation: Conversation }> {
  try {
    const checkpoint = await context.checkpointStore.loadCheckpoint(runId);
    const conversation =
      checkpoint.conversation !== null
        ? // AB-321: forwards the resolved runtime so any append on this
          // rehydrated instance mints ids/timestamps through the run's own
          // seam rather than conversationalist's default — the snapshot's
          // OWN id is unaffected either way (`Conversation.from` restores
          // it verbatim).
          Conversation.from(checkpoint.conversation, { runtime })
        : new Conversation(undefined, { runtime });

    const runState = createRunState();
    runState.totalUsage = { ...checkpoint.cursor.totalUsage };
    runState.lastContent = checkpoint.cursor.lastContent;
    runState.schemaAttempts = checkpoint.cursor.schemaAttempts;
    runState.steps = checkpoint.steps.map((record, index) => ({
      step: record.step,
      conversation,
      content: record.content,
      toolCalls: record.toolCalls,
      results: record.results,
      ...(record.usage ? { usage: record.usage } : {}),
      ...(record.metadata ? { metadata: record.metadata } : {}),
      // Only the final step is marked final, mirroring the in-memory loop where
      // `final` is set on the step that triggered the stop condition.
      final: record.final && index === checkpoint.steps.length - 1,
    }));

    return { runState, conversation };
  } catch {
    return { runState: createRunState(), conversation: new Conversation(undefined, { runtime }) };
  }
}

/**
 * Reconstruct a full {@link RunResult} from the durable checkpoint. The workflow
 * returns only a thin {@link AgentRunWorkflowResult} summary; the `ActiveRun`
 * contract requires the complete shape (conversation, steps, usage). We rebuild
 * it from the persisted cursor, transcript snapshot, and step records.
 *
 * Every `StepResult.conversation` is set to the single final rehydrated
 * instance — matching `executeLoop`, where each step's `conversation` is the one
 * live run conversation — so gateway's step/snapshot mapping sees the same shape.
 */
export async function reconstructRunResult(
  context: DurableActiveRunContext,
  runId: string,
  summary: AgentRunWorkflowResult,
  runtime: RuntimeServices,
): Promise<{ result: RunResult; runState: RunState; conversation: Conversation }> {
  const { runState, conversation } = await loadRunStateFromCheckpoint(context, runId, runtime);
  const terminalError = reconstructTerminalRunError({
    finishReason: summary.finishReason,
    steps: summary.steps,
    errorMessage: summary.errorMessage,
    errorKind: summary.errorKind,
    errorCode: summary.errorCode,
    abortReason: summary.abortReason,
    schemaValidation: summary.schemaValidation,
    tripwire: summary.tripwire,
  });
  const schemaValidation = reconstructSchemaValidation(summary.schemaValidation, terminalError);

  const result: RunResult = {
    conversation,
    steps: runState.steps,
    content: summary.content,
    usage: runState.totalUsage,
    finishReason: summary.finishReason,
    ...(terminalError ? { error: terminalError } : {}),
    ...(schemaValidation ? { schemaValidation } : {}),
    // Mirror the in-memory loop and `finalizeRunResult`: a successful
    // `output` run's validated value must survive result-only durable
    // paths (`resumeDurableRunResult`, `startDurableRunResult`), not just the
    // full lifecycle/finalize path (`driveReattachedRun`/`driveDurableRun`).
    ...('output' in summary ? { output: summary.output } : {}),
  };

  return { result, runState, conversation };
}

interface ReconstructTerminalRunErrorArgs {
  finishReason: FinishReason;
  steps: number;
  errorMessage?: string | undefined;
  errorKind?: AgentRunError['kind'] | undefined;
  errorCode?: AgentRunError['code'] | undefined;
  abortReason?: string | undefined;
  schemaValidation?: { success: boolean; error?: string | undefined } | undefined;
  tripwire?: AgentRunWorkflowResult['tripwire'] | undefined;
}

export function reconstructTerminalRunError(
  args: ReconstructTerminalRunErrorArgs,
): AgentRunError | undefined {
  if (args.finishReason === 'maximum-steps') {
    return new MaximumStepsExceededError(args.steps);
  }
  if (args.finishReason === 'aborted') {
    return new AbortAgentRunError(args.abortReason);
  }
  if (args.finishReason === 'elicitation-denied') {
    return new ElicitationDeniedError(args.errorMessage);
  }
  if (args.finishReason === 'budget-exceeded') {
    return new BudgetExceededError(args.errorMessage);
  }
  if (args.finishReason === 'tripwire') {
    return new GuardrailTripwireError(args.errorMessage ?? 'Durable run tripwire', {
      guardrailName: args.tripwire?.guardrailName ?? 'unknown',
      category: args.tripwire?.category ?? 'unknown',
      phase: args.tripwire?.phase ?? 'input',
      confidence: args.tripwire?.confidence ?? 0,
      detail: args.tripwire?.detail,
    });
  }
  if (args.finishReason === 'error') {
    const message =
      args.errorMessage ?? args.schemaValidation?.error ?? `Durable run ${args.finishReason}`;
    const kind =
      args.errorKind ?? (args.schemaValidation?.success === false ? 'output' : 'generate');
    const code =
      args.errorCode ?? (args.schemaValidation?.success === false ? 'INVALID_OUTPUT' : 'UNKNOWN');
    return new AgentRunError(message, { kind, code });
  }
  return undefined;
}

export function reconstructSchemaValidation(
  schemaValidation: AgentRunWorkflowResult['schemaValidation'],
  terminalError: AgentRunError | undefined,
): RunResult['schemaValidation'] {
  if (!schemaValidation) return undefined;
  if (schemaValidation.error === undefined) return { success: schemaValidation.success };
  const error =
    terminalError?.kind === 'output'
      ? terminalError
      : new AgentRunError(schemaValidation.error, { kind: 'output', code: 'INVALID_OUTPUT' });
  return { success: schemaValidation.success, error };
}

/**
 * Build an {@link ActiveRun} over a durable Weft workflow. This is the seam that
 * makes durable execution the DEFAULT: `createRun` delegates here when an engine
 * is present, so a normal run is checkpointed and resumable while preserving the
 * full `ActiveRun` event surface gateway depends on.
 *
 * The construction preserves `createRun`'s two hard contracts:
 *
 * 1. **Synchronous construct + deferred-microtask start.** The emitter and the
 *    `ActiveRun` surface are returned synchronously; the workflow starts on the
 *    next microtask, so callers attach listeners before any event fires.
 * 2. **Run-level lifecycle parity.** `RunStartedEvent`/`onRunStart` fire before
 *    the workflow starts and `RunCompleted`/`Aborted`/`Error` + the run hooks
 *    fire on completion — via the SAME `run-lifecycle.ts` functions the
 *    in-memory loop uses. Step-level events come from `runStep` running in-process
 *    under inline mode, emitting to the same emitter. Gateway's
 *    `once('run.completed')` + `store.register` therefore see a durable run
 *    exactly as they see an in-memory one.
 *
 * @remarks
 * Abort uses the operative `AbortSignal` (mirroring `createRun`'s
 * `AbortController`): `abort()` signals the running step, which returns an abort
 * outcome and the workflow finishes with `finishReason: 'aborted'` — a clean
 * in-band stop, no Weft-level `handle.cancel()` needed for the common case.
 *
 * Seam #11 (hook replay on recovery) is RESOLVED, not open here: this function
 * is only ever invoked to START a fresh run (see `create-run.ts`); a
 * cross-process resume goes through {@link reattachDurableActiveRun} instead,
 * whose docblock documents why the run-level lifecycle does not re-fire
 * (`hooks: undefined`, no `startRunLifecycle` call). Step-level hooks are
 * protected by `ctx.memo` wrapping the whole step in run-workflow.ts — see its
 * "#11 hook side-effect-ness on resume" remark for the full resolution.
 */
export function emptyRunState(): RunState {
  return createRunState();
}

/**
 * Build the error message for a `WorkflowTimeoutError`, distinguishing a history
 * circuit-breaker kill from a genuine execution-deadline timeout. The error class
 * itself carries no `terminationReason`, so the distinction comes from the
 * engine's stored {@link WorkflowState}: `'history-circuit-breaker'` means the
 * run's event-log breached `history.maxEvents`. A failed/absent state read falls
 * back to the raw error message rather than guessing.
 */
export async function classifyTimeoutMessage(
  context: DurableActiveRunContext,
  runId: string,
  error: unknown,
): Promise<string> {
  const fallback = error instanceof Error ? error.message : String(error);
  try {
    const state = await context.engine.get(runId);
    if (state?.terminationReason === HISTORY_CIRCUIT_BREAKER_REASON) {
      return `Durable run terminated by the history circuit breaker (history.maxEvents exceeded): ${fallback}`;
    }
    return `Durable run exceeded its execution deadline: ${fallback}`;
  } catch {
    return fallback;
  }
}

/**
 * Build a quiet, interrupted-shaped {@link RunResult} for a run whose engine was
 * disposed mid-flight. Deliberately fires NO terminal lifecycle event: dispose
 * mid-run is the crash semantic (the run is abandoned for a fresh process to
 * recover), so the session must stay `running` for the boot reconstructor to
 * pick it up. The returned value only resolves the (typically unawaited) run
 * promise on the tearing-down side; nothing observes its `finishReason`.
 */
export function makeInterruptedRunResult(conversation: Conversation): RunResult {
  return {
    conversation,
    steps: [],
    content: '',
    usage: { prompt: 0, completion: 0, total: 0 },
    finishReason: 'aborted',
  };
}

/** Arguments to {@link finalizeRunResult}. */
interface FinalizeArgs {
  finishReason: FinishReason;
  runState: RunState;
  conversation: Conversation;
  hooks: RunOptions['hooks'];
  emitter: OperativeEventEmitter;
  runStartTime: number;
  /**
   * The AB-92/AB-252/AB-253 runtime this run's `runStartTime` was measured
   * against — threaded into `makeCompletedResult`'s `totalDuration` so the
   * elapsed-time computation reads the SAME monotonic clock instance that
   * produced `runStartTime`, never a mismatched fresh default.
   */
  runtime: RuntimeServices;
  /** Serialized terminal error message (when the durable run errored). */
  errorMessage?: string | undefined;
  /** The exact terminal error object captured from the live run event, when available. */
  terminalError?: AgentRunError | undefined;
  /** The abort reason (when the durable run was aborted). */
  abortReason?: string | undefined;
  /**
   * The structured-output validation outcome carried out of the workflow, so a
   * completed durable run's `RunResult.schemaValidation` matches the in-memory
   * loop. Its serialized error message is rebuilt into an `Error` for parity.
   */
  schemaValidation?: { success: boolean; error?: string | undefined } | undefined;
  /**
   * The `output`-validated structured output carried out of the
   * workflow, mirroring `RunResult.output` on the in-memory path.
   * Unlike `schemaValidation.error`, this crosses the checkpoint as plain
   * (already-JSON) data, so no reconstruction is needed here.
   */
  output?: unknown;
  /** Forwarded from `RunOptions.costEstimation` so a durable run's terminal
   * `RunResult.costEstimate` matches the in-memory loop's. */
  costEstimation?: RunOptions['costEstimation'] | undefined;
  /**
   * The tripped guardrail's identity, carried out of the workflow summary when
   * `finishReason` is `'tripwire'`. Used to rebuild the same `GuardrailTripwireError`
   * subclass the workflow classified, so `makeErrorResult`'s `instanceof` check
   * lands on `finishReason: 'tripwire'` again and `RunTripwireEvent` fires.
   */
  tripwire?:
    | {
        guardrailName: string;
        category: string;
        phase: 'input' | 'output';
        confidence: number;
        detail?: string;
      }
    | undefined;
  /**
   * AB-291 (AC1): collects every run-owned hook's fire-and-forget promise so
   * `createDurableActiveRun`'s `resolveDurableOutcome` can await genuine hook
   * completion before reporting `closed()` `completed` — the durable
   * counterpart of `create-run.ts`'s `pendingHookPromises`. Omitted by
   * `driveReattachedRun`'s call sites (`hooks: undefined` there — reattach
   * never fires run hooks, so nothing to track).
   */
  hookTracker?: ((promise: Promise<unknown>) => void) | undefined;
}

/**
 * Map a durable run's `finishReason` to the matching run-lifecycle terminal, so
 * `RunCompleted`/`Aborted`/`Error` and the run hooks fire identically to the
 * in-memory loop — carrying the real abort reason and error message out of the
 * workflow summary, not a synthetic placeholder.
 */
export function finalizeRunResult(args: FinalizeArgs): RunResult {
  const { finishReason, runState, conversation, hooks, emitter, runStartTime } = args;
  const terminalError =
    args.terminalError ??
    reconstructTerminalRunError({
      finishReason,
      steps: runState.steps.length,
      errorMessage: args.errorMessage,
      abortReason: args.abortReason,
      schemaValidation: args.schemaValidation,
      tripwire: args.tripwire,
    });

  if (finishReason === 'aborted') {
    const lastStep = runState.steps[runState.steps.length - 1];
    return makeAbortResult(
      runState,
      conversation,
      hooks,
      emitter,
      lastStep ? lastStep.step + 1 : 0,
      args.abortReason,
      args.costEstimation,
      terminalError,
      args.hookTracker,
    );
  }
  if (
    finishReason === 'error' ||
    finishReason === 'elicitation-denied' ||
    finishReason === 'budget-exceeded' ||
    finishReason === 'tripwire'
  ) {
    return makeErrorResult(
      runState,
      conversation,
      hooks,
      emitter,
      terminalError,
      args.costEstimation,
      undefined,
      args.hookTracker,
    );
  }
  const schemaValidation = reconstructSchemaValidation(args.schemaValidation, terminalError);

  return makeCompletedResult(
    runState,
    conversation,
    hooks,
    emitter,
    finishReason === 'stop-condition' ? 'stop-condition' : 'maximum-steps',
    runStartTime,
    schemaValidation,
    args.output,
    args.costEstimation,
    terminalError,
    args.hookTracker,
    args.runtime,
  );
}
