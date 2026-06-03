import { Conversation } from 'conversationalist';
import type { ForwardableSource } from 'lifecycle';
import { CompletableEventTarget, forwardEvents } from 'lifecycle';

import type { ActiveRun } from '../create-run';
import type { CombinedOperativeEventMap } from '../events';
import { createRunState } from '../loop';
import {
  makeAbortResult,
  makeCompletedResult,
  makeErrorResult,
  startRunLifecycle,
} from '../run-lifecycle';
import type { RunState } from '../run-step';
import type { FinishReason, RunOptions, RunResult } from '../types';
import type { CheckpointStore } from './checkpoint-store';
import type { AnyRunEngine } from './create-run-engine';
import { clearRunDeps, registerRunDeps } from './deps-registry';
import type { AgentRunWorkflowResult } from './run-workflow';

/** Dependencies the adapter needs from bureau composition. */
export interface DurableActiveRunContext {
  engine: AnyRunEngine;
  checkpointStore: CheckpointStore;
}

/** Options for {@link createDurableActiveRun}. */
export interface DurableActiveRunOptions {
  /** A stable id for the run; also the durable workflow id (resume key). */
  runId: string;
  /** The run behavior (generate fn, toolbox, conversation, hooks, stopWhen). */
  options: RunOptions;
  /** First user message to seed a brand-new run. Ignored when resuming. */
  prompt?: string;
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
async function reconstructRunResult(
  context: DurableActiveRunContext,
  runId: string,
  summary: AgentRunWorkflowResult,
): Promise<{ result: RunResult; runState: RunState; conversation: Conversation }> {
  const checkpoint = await context.checkpointStore.loadCheckpoint(runId);
  const conversation =
    checkpoint.conversation !== null
      ? Conversation.from(checkpoint.conversation)
      : new Conversation();

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

  const result: RunResult = {
    conversation,
    steps: runState.steps,
    content: summary.content,
    usage: runState.totalUsage,
    finishReason: summary.finishReason,
  };

  return { result, runState, conversation };
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
 * TODO(weft-integration): #11 on a cross-process resume the run-level lifecycle
 *   re-fires (it is not checkpointed); classify hooks by side-effect-ness before
 *   re-emitting. For in-process default-on (no crash) the lifecycle fires once.
 */
export function createDurableActiveRun(
  context: DurableActiveRunContext,
  durableRun: DurableActiveRunOptions,
): ActiveRun {
  const { runId, options } = durableRun;
  const emitter = new CompletableEventTarget<CombinedOperativeEventMap>();
  const abortController = new AbortController();

  const combinedSignal = options.signal
    ? AbortSignal.any([options.signal, abortController.signal])
    : abortController.signal;

  const conversation =
    options.conversation instanceof Conversation
      ? options.conversation
      : new Conversation(options.conversation);

  // Forward toolbox events with the `toolbox` prefix, as createRun does. The
  // toolbox is the SAME instance `runStep` executes in-process under inline mode,
  // so its events fire live on the durable path.
  //
  // We deliberately do NOT forward `conversation:*` events here. Unlike the
  // in-memory loop, the durable workflow operates on per-step
  // `Conversation.from(snapshot)` instances and never mutates this input
  // instance — it only snapshots it once to seed. Forwarding from it would be
  // inert (no events ever fire). Durable per-step conversation streaming is
  // TODO(weft-integration): #10 (in-process streaming progress).
  const cleanups: (() => void)[] = [];
  const toolboxForward = forwardEvents(
    options.toolbox as unknown as ForwardableSource,
    emitter,
    'toolbox',
  );
  cleanups.push(() => toolboxForward.stop());

  function complete(): void {
    for (const cleanup of cleanups) cleanup();
    emitter.complete();
  }

  // Deferred-microtask start so callers attach listeners first (createRun contract).
  const result = Promise.resolve()
    .then(() =>
      driveDurableRun(
        context,
        runId,
        options,
        conversation,
        combinedSignal,
        emitter,
        durableRun.prompt,
      ),
    )
    .finally(complete);

  function abort(reason?: string): void {
    abortController.abort(reason);
  }

  return {
    result,
    abort,
    addEventListener: emitter.addEventListener.bind(emitter) as ActiveRun['addEventListener'],
    removeEventListener: emitter.removeEventListener.bind(
      emitter,
    ) as ActiveRun['removeEventListener'],
    on: emitter.on.bind(emitter) as ActiveRun['on'],
    once: emitter.once.bind(emitter) as ActiveRun['once'],
    subscribe: emitter.subscribe.bind(emitter) as ActiveRun['subscribe'],
    events: emitter.events.bind(emitter) as ActiveRun['events'],
    toObservable: emitter.toObservable.bind(emitter) as ActiveRun['toObservable'],
    complete,
    [Symbol.dispose](): void {
      abort();
      complete();
    },
  };
}

/**
 * Drive one durable run: fire the start lifecycle, start (or resume) the
 * workflow, await it, reconstruct the `RunResult`, and fire the completion
 * lifecycle — all via the shared `run-lifecycle.ts` so events/hooks match the
 * in-memory loop exactly.
 */
async function driveDurableRun(
  context: DurableActiveRunContext,
  runId: string,
  options: RunOptions,
  conversation: Conversation,
  signal: AbortSignal,
  emitter: CompletableEventTarget<CombinedOperativeEventMap>,
  prompt: string | undefined,
): Promise<RunResult> {
  const runStartTime = performance.now();
  const { hooks } = options;

  // The durable run's behavior is driven through the deps registry; the workflow
  // body resolves it via getRunDeps. Inject the combined signal so an abort()
  // reaches the running step, and the emitter so step events flow (inline mode).
  registerRunDeps(runId, {
    options: { ...options, signal },
    toolbox: options.toolbox,
    emitter,
  });

  try {
    // RunStartedEvent + onRunStart (an onRunStart error aborts the run).
    const startError = await startRunLifecycle(options, conversation, emitter);
    if (startError !== undefined) {
      return makeErrorResult(emptyRunState(), conversation, hooks, emitter, startError);
    }

    const handle = await context.engine.start('agentRun', {
      runId,
      prompt,
      maximumSteps: options.maximumSteps,
    });
    const summary = (await handle.result()) as AgentRunWorkflowResult;

    // The authoritative conversation on the durable path is the one rehydrated
    // from the checkpoint — the workflow mutates rehydrated snapshots per step,
    // never the input instance (which stays empty). Use the reconstructed one
    // for the result AND the completion lifecycle so they agree.
    const {
      result,
      runState,
      conversation: durableConversation,
    } = await reconstructRunResult(context, runId, summary);

    // Fire the completion lifecycle from the SAME functions the loop uses, keyed
    // on the durable run's finishReason. These run in-process on the launching
    // engine (inline mode) and are intentionally not checkpointed. The terminal
    // error message / abort reason are carried out of the workflow summary so the
    // emitted RunAborted/RunError events and gateway's `lastError` reflect the
    // real cause, not a synthetic placeholder.
    return finalizeRunResult({
      finishReason: result.finishReason,
      runState,
      conversation: durableConversation,
      hooks,
      emitter,
      runStartTime,
      errorMessage: summary.errorMessage,
      abortReason: summary.abortReason,
    });
  } finally {
    clearRunDeps(runId);
  }
}

/** A throwaway run state for the pre-step error path (no steps completed yet). */
function emptyRunState(): RunState {
  return createRunState();
}

/** Arguments to {@link finalizeRunResult}. */
interface FinalizeArgs {
  finishReason: FinishReason;
  runState: RunState;
  conversation: Conversation;
  hooks: RunOptions['hooks'];
  emitter: CompletableEventTarget<CombinedOperativeEventMap>;
  runStartTime: number;
  /** Serialized terminal error message (when the durable run errored). */
  errorMessage?: string;
  /** The abort reason (when the durable run was aborted). */
  abortReason?: string;
}

/**
 * Map a durable run's `finishReason` to the matching run-lifecycle terminal, so
 * `RunCompleted`/`Aborted`/`Error` and the run hooks fire identically to the
 * in-memory loop — carrying the real abort reason and error message out of the
 * workflow summary, not a synthetic placeholder.
 */
function finalizeRunResult(args: FinalizeArgs): RunResult {
  const { finishReason, runState, conversation, hooks, emitter, runStartTime } = args;

  if (finishReason === 'aborted') {
    const lastStep = runState.steps[runState.steps.length - 1];
    return makeAbortResult(
      runState,
      conversation,
      hooks,
      emitter,
      lastStep ? lastStep.step + 1 : 0,
      args.abortReason,
    );
  }
  if (
    finishReason === 'error' ||
    finishReason === 'elicitation-denied' ||
    finishReason === 'budget-exceeded'
  ) {
    // Rebuild an Error from the serialized message so consumers see the real
    // cause (gateway's `lastError: serializeUnknownError(event.error)`).
    return makeErrorResult(
      runState,
      conversation,
      hooks,
      emitter,
      new Error(args.errorMessage ?? `Durable run ${finishReason}`),
    );
  }
  return makeCompletedResult(
    runState,
    conversation,
    hooks,
    emitter,
    finishReason === 'stop-condition' ? 'stop-condition' : 'maximum-steps',
    runStartTime,
  );
}
