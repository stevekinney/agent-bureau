import { isWeftErrorLike } from '@lostgradient/weft';
import { Conversation, isConversation } from 'conversationalist';
import type { ForwardableSource } from 'lifecycle';
import { CompletableEventTarget, forwardEvents } from 'lifecycle';

import type { ActiveRun } from '../create-run';
import { BudgetExceededError, ElicitationDeniedError } from '../errors';
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
  /**
   * The bureau session that owns this run. Threaded into the durable workflow
   * input so boot recovery can correlate a recovered handle back to its session
   * from the durable input alone (see {@link AgentRunWorkflowInput.sessionId}).
   */
  sessionId: string;
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

  const conversation = isConversation(options.conversation)
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
        durableRun.sessionId,
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
 * The minimal recovered-handle surface {@link reattachDurableActiveRun} needs: a
 * pinned id (== runId) and the settling `result()`. `engine.recoverAll()` returns
 * full `WorkflowHandle`s; this narrow shape avoids depending on Weft's invariant
 * `WorkflowHandle` generics (matching the `AnyRunEngine` widening convention).
 */
export interface RecoveredRunHandle {
  readonly id: string;
  result(): Promise<unknown>;
}

/**
 * Reattach an `ActiveRun` to a run RECOVERED in this process by
 * `engine.recoverAll()` (closes seam #5b). Unlike {@link createDurableActiveRun},
 * this does NOT `engine.start` a new run — the recovered generator is already
 * relaunched by `recoverAll()`; this wraps the existing {@link RecoveredRunHandle}
 * so the run rejoins the live surface (`store.register` makes `getRun(runId)`
 * resolve and live subscribers see it) and fires its TERMINAL lifecycle when the
 * resumed run settles.
 *
 * Contract (core scope — deliberately narrower than a fresh run):
 * - **Terminal events only.** `run.completed` / `run.aborted` / `run.error` fire
 *   when the recovered run settles. Per-step / toolbox / progress events are NOT
 *   forwarded: the recovered generator runs against the resolver's rebuilt
 *   `ctx.services.toolbox`, whose events fire on THAT toolbox, never this
 *   adapter's. Live-per-step-during-resume is a documented sub-seam, not core.
 * - **No start lifecycle (seam #11).** `startRunLifecycle` / `onRunStart` are NOT
 *   re-fired — the run already started in the prior process and `onRunStart` is
 *   side-effecting. Re-firing it on every recovery would double-execute it.
 * - **Engine-failed / disposed runs fire NO terminal event.** A run the resolver
 *   could not rebuild is terminally `failed` by Weft pre-replay, so `result()`
 *   rejects; the resolver already persisted that session's status. An
 *   `EngineDisposedError` means the bureau is tearing down mid-resume (re-recover
 *   later). Either way this adapter logs and stays write-free — it must not
 *   clobber the session status the resolver/teardown owns.
 *
 * NOTE: a recovered run's `onRunComplete.totalDuration` is measured from reattach
 * on THIS process, not the original wall-clock start (the start timestamp is not
 * checkpointed). No current consumer reads it for billing/classification; a
 * persisted start time is deferred until one does.
 */
export function reattachDurableActiveRun(
  context: DurableActiveRunContext,
  reattach: { runId: string; handle: RecoveredRunHandle },
): ActiveRun {
  const { runId, handle } = reattach;
  const emitter = new CompletableEventTarget<CombinedOperativeEventMap>();

  // Resolves `true` only when an adapter-initiated `engine.cancel` SUCCEEDS for
  // this run — i.e. THIS abort terminalized the run. `undefined` means no abort
  // was requested. The result-rejection path classifies as `aborted` ONLY when
  // this proves the cancel caused the termination; if cancel rejected (the run was
  // already terminal for a resolver/teardown reason) it stays on the write-free
  // path and does not clobber that owner's status (committee round-3 finding 1).
  let abortCancelled: Promise<boolean> | undefined;

  function complete(): void {
    emitter.complete();
  }

  // Deferred-microtask start — REQUIRED for the registration ordering invariant:
  // the caller (`recoverDurableRuns`) must finish `store.register` +
  // `runSessionIdentifiers.set` in its synchronous turn BEFORE any terminal event
  // microtask fires, so `getRun(runId)` resolves and no subscriber misses the
  // terminal event — even when `handle.result()` already settled before reattach.
  const result = Promise.resolve()
    .then(() => driveReattachedRun(context, runId, handle, emitter, () => abortCancelled))
    .finally(complete);

  return {
    result,
    // A reattached run has no abort SIGNAL (the recovered generator runs under the
    // engine, not this adapter's controller), so abort cancels the run at the
    // engine instead (committee MF-3): a recovered run is now visible via
    // `getRun(runId)`, so `bureau.abortRun(runId)` must actually stop it rather
    // than silently no-op. `engine.cancel` terminalizes the run and rejects its
    // result waiter; the rejection is translated into a real `run.aborted`
    // lifecycle (so gateway persists `aborted`) — but ONLY if the cancel actually
    // succeeded (abortCancelled resolves true), distinguishing this abort from a
    // resolver/teardown failure that merely raced an abort() call.
    abort(): void {
      abortCancelled ??= context.engine.cancel(runId).then(
        () => true,
        () => false,
      );
    },
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
      complete();
    },
  };
}

/**
 * Resume a SUSPENDED durable run and return a `RunResult` promise that settles
 * when the resumed run completes. Unlike {@link reattachDurableActiveRun} — which
 * is write-free and swallows a rejecting handle into an interrupted result because
 * a recovered run's terminal status is owned by the resolver/teardown — this
 * PROPAGATES failure: if `engine.resume(runId)` rejects (the run is already
 * terminal) or the resumed handle's `result()` rejects, the returned promise
 * REJECTS. The scheduler needs that so a failed resume surfaces as a failed task
 * (committee MF-4), not a silently "completed" one. There is exactly one owner of
 * the run — the resume caller — so reconstructing + returning the result here is
 * safe (no lifecycle events; the scheduler drives task-level events itself).
 */
export async function resumeDurableRunResult(
  context: DurableActiveRunContext,
  runId: string,
): Promise<RunResult> {
  const handle = await context.engine.resume(runId);
  const summary = (await (handle as RecoveredRunHandle).result()) as AgentRunWorkflowResult;
  const { result } = await reconstructRunResult(context, runId, summary);
  return result;
}

/**
 * Drive a REATTACHED recovered run: await the already-running handle, reconstruct
 * the `RunResult` from the checkpoint, and fire ONLY the terminal lifecycle (no
 * start lifecycle — seam #11). On a rejecting handle, stay write-free: the
 * resolver (services-unavailable → engine-failed) or the teardown
 * (`EngineDisposedError`) already owns that session's terminal status.
 */
async function driveReattachedRun(
  context: DurableActiveRunContext,
  runId: string,
  handle: RecoveredRunHandle,
  emitter: CompletableEventTarget<CombinedOperativeEventMap>,
  abortOutcome: () => Promise<boolean> | undefined,
): Promise<RunResult> {
  const runStartTime = performance.now();

  let summary: AgentRunWorkflowResult;
  try {
    summary = (await handle.result()) as AgentRunWorkflowResult;
  } catch (error) {
    // An ADAPTER-INITIATED abort (bureau.abortRun → engine.cancel) that ACTUALLY
    // terminalized this run is a real terminal: fire `run.aborted` so the gateway
    // listener persists `aborted`, rather than leaving the session looking
    // `running` (committee round-2 finding 2). Classify as aborted ONLY when the
    // cancel succeeded (committee round-3 finding 1): if the cancel rejected, this
    // rejection came from a resolver/teardown failure that merely raced abort(),
    // and that owner's status must not be clobbered.
    const cancelSucceeded = await (abortOutcome() ?? Promise.resolve(false));
    if (cancelSucceeded) {
      // A failed transcript read must NOT suppress the abort lifecycle (committee
      // round-3 finding 2) — fall back to an empty conversation.
      let conversation: Conversation;
      try {
        const snapshot = await context.checkpointStore.loadConversation(runId);
        conversation = snapshot ? Conversation.from(snapshot) : new Conversation();
      } catch {
        conversation = new Conversation();
      }
      return makeAbortResult(createRunState(), conversation, undefined, emitter, 0, 'aborted');
    }
    // Otherwise write-free. EngineDisposedError = bureau teardown mid-resume
    // (leave running for a later boot). Any other rejection = the engine
    // terminally failed this run pre-replay because the resolver returned
    // services-unavailable, and the resolver ALREADY reconciled that session to
    // `error`. Firing a terminal lifecycle here would clobber what the
    // resolver/teardown owns, so we only log and resolve quiet.
    if (!(isWeftErrorLike(error) && error.code === 'EngineDisposedError')) {
      console.error(
        `[operative] Reattached durable run "${runId}" did not settle cleanly: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return makeInterruptedRunResult(new Conversation());
  }

  const {
    result,
    runState,
    conversation: durableConversation,
  } = await reconstructRunResult(context, runId, summary);

  // `hooks: undefined` — the recovered run's `onRunComplete`/etc. hooks are
  // non-serializable run behavior; they were rebuilt by the resolver into
  // `ctx.services`, which the bureau never gets back. So reattach fires the
  // terminal EVENTS (which gateway's session-persistence listeners need) but not
  // the run HOOKS — matching the old `settleRecoveredRun`, which persisted the
  // session directly and never fired operative run hooks for a recovered run.
  return finalizeRunResult({
    finishReason: result.finishReason,
    runState,
    conversation: durableConversation,
    hooks: undefined,
    emitter,
    runStartTime,
    errorMessage: summary.errorMessage,
    abortReason: summary.abortReason,
    schemaValidation: summary.schemaValidation,
  });
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
  sessionId: string,
  options: RunOptions,
  conversation: Conversation,
  signal: AbortSignal,
  emitter: CompletableEventTarget<CombinedOperativeEventMap>,
  prompt: string | undefined,
): Promise<RunResult> {
  const runStartTime = performance.now();
  const { hooks } = options;

  // RunStartedEvent + onRunStart (an onRunStart error aborts the run).
  const startError = await startRunLifecycle(options, conversation, emitter);
  if (startError !== undefined) {
    return makeErrorResult(emptyRunState(), conversation, hooks, emitter, startError);
  }

  // Pin the Weft workflow id to `runId` so `handle.id === runId`. This makes the
  // run's id its resume key (recoverAll surfaces handles keyed by it) and lets
  // boot recovery correlate handles to sessions by `handle.id` (see
  // `settleRecoveredRun`). Each `runId` is unique per run, so the duplicate-id
  // guard never trips on a fresh run.
  //
  // Hand the run's non-serializable behavior to the engine as its per-run
  // `services` value: the workflow body reads it as `ctx.services` (never
  // checkpointed), and on a cross-process recovery the engine re-provides it via
  // `resolveWorkflowServices`. Inject the combined signal so an abort() reaches
  // the running step, and the emitter so step events flow (inline mode).
  //
  // NOTE: `services` is Weft inline-execution-mode ONLY (0.2.1) — passing it
  // under `workflowExecutionMode: 'worker'` rejects at `engine.start`, because a
  // non-serializable value cannot cross to a Worker. This run engine is inline
  // by construction (tool execution runs in-process via `runStep`), so the
  // constraint is always satisfied here.
  const handle = await context.engine.start(
    'agentRun',
    {
      runId,
      sessionId,
      prompt,
      maximumSteps: options.maximumSteps,
    },
    {
      id: runId,
      services: {
        options: { ...options, signal },
        toolbox: options.toolbox,
        emitter,
      },
    },
  );

  let summary: AgentRunWorkflowResult;
  try {
    summary = (await handle.result()) as AgentRunWorkflowResult;
  } catch (error) {
    // The engine was disposed while this run was still in flight — i.e. the
    // bureau (or process) is tearing down mid-run. This is the CRASH semantic,
    // not an abort: the run is abandoned FOR RECOVERY, so a fresh process can
    // resume it from its last checkpoint. We MUST NOT fire a terminal lifecycle
    // event here — `makeAbortResult`/`makeErrorResult` would drive gateway's
    // `once('run.aborted'/'completed')`, persist a terminal session status, and
    // the boot recovery resolver (`resolveWorkflowServices`, which only rebuilds
    // deps for sessions still marked `running`) would then never see the run and
    // recovery would never happen. So we resolve quietly with an interrupted-
    // shaped result and leave the session `running`. Structural code match (not
    // `instanceof`) to survive the module boundary — `isWeftErrorLike` narrows a
    // caught unknown without `instanceof`.
    if (isWeftErrorLike(error) && error.code === 'EngineDisposedError') {
      return makeInterruptedRunResult(conversation);
    }
    throw error;
  }

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
    schemaValidation: summary.schemaValidation,
  });
}

/** A throwaway run state for the pre-step error path (no steps completed yet). */
function emptyRunState(): RunState {
  return createRunState();
}

/**
 * Build a quiet, interrupted-shaped {@link RunResult} for a run whose engine was
 * disposed mid-flight. Deliberately fires NO terminal lifecycle event: dispose
 * mid-run is the crash semantic (the run is abandoned for a fresh process to
 * recover), so the session must stay `running` for the boot reconstructor to
 * pick it up. The returned value only resolves the (typically unawaited) run
 * promise on the tearing-down side; nothing observes its `finishReason`.
 */
function makeInterruptedRunResult(conversation: Conversation): RunResult {
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
  emitter: CompletableEventTarget<CombinedOperativeEventMap>;
  runStartTime: number;
  /** Serialized terminal error message (when the durable run errored). */
  errorMessage?: string;
  /** The abort reason (when the durable run was aborted). */
  abortReason?: string;
  /**
   * The structured-output validation outcome carried out of the workflow, so a
   * completed durable run's `RunResult.schemaValidation` matches the in-memory
   * loop. Its serialized error message is rebuilt into an `Error` for parity.
   */
  schemaValidation?: { success: boolean; error?: string };
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
    // Rebuild the SAME error SUBCLASS the workflow classified, so
    // `makeErrorResult`'s `instanceof` re-classification lands on the same
    // `finishReason` — otherwise a plain `Error` would always flatten back to
    // `'error'` and lose the elicitation-denied / budget-exceeded distinction.
    const message = args.errorMessage ?? `Durable run ${finishReason}`;
    const error =
      finishReason === 'elicitation-denied'
        ? new ElicitationDeniedError(message)
        : finishReason === 'budget-exceeded'
          ? new BudgetExceededError(message)
          : new Error(message);
    return makeErrorResult(runState, conversation, hooks, emitter, error);
  }
  return makeCompletedResult(
    runState,
    conversation,
    hooks,
    emitter,
    finishReason === 'stop-condition' ? 'stop-condition' : 'maximum-steps',
    runStartTime,
    args.schemaValidation
      ? {
          success: args.schemaValidation.success,
          ...(args.schemaValidation.error !== undefined
            ? { error: new Error(args.schemaValidation.error) }
            : {}),
        }
      : undefined,
  );
}
