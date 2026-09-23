import type { RuntimeServices } from '@lostgradient/lifecycle';
import { isWeftErrorLike } from '@lostgradient/weft';
import type { AnyToolbox } from 'armorer';
import { Conversation } from 'conversationalist';

import { AgentRunError, toAgentRunError } from '../errors';
import type { OperativeEventEmitter } from '../events';
import { makeErrorResult, startRunLifecycle } from '../run-lifecycle';
import { type RunOptions, type RunResult } from '../types';
import type { DurableActiveRunContext } from './active-run-adapter';
import {
  classifyTimeoutMessage,
  emptyRunState,
  finalizeRunResult,
  makeInterruptedRunResult,
  reconstructRunResult,
} from './active-run-result-reconstruction';
import {
  AGENT_RUN_WORKFLOW_RESULT_SCHEMA_VERSION,
  type AgentRunWorkflowResult,
  normalizeAgentRunWorkflowResult,
} from './run-workflow-result';
import type { DurableRunDeps } from './types';

export async function driveDurableRun(
  context: DurableActiveRunContext,
  runId: string,
  sessionId: string,
  agentName: string,
  options: RunOptions,
  conversation: Conversation,
  signal: AbortSignal,
  emitter: OperativeEventEmitter,
  prompt: string | undefined,
  onServices: ((services: DurableRunDeps) => void) | undefined,
  reachability: { unreachable: boolean },
  // AB-339: true when `abort()` was called before this run's deferred
  // microtask even fired — captured, once, as a synchronous snapshot in
  // that SAME microtask (see `drive()`'s call site for why a live
  // `signal.aborted` re-check here would be wrong: an abort that arrives
  // AFTER the microtask starts, while this function is still inside its
  // own `startRunLifecycle` await, already fires `engine.cancel()` via
  // `abort()`'s own `if (driveStarted)` branch, and that in-flight cancel
  // must still resolve against a workflow `engine.start` actually
  // launches).
  abortedBeforeDrive: boolean,
  onStepToolbox: ((toolbox: AnyToolbox) => void) | undefined,
  runtime: RuntimeServices,
  hookTracker: (promise: Promise<unknown>) => void,
  // AB-361: settles `ActiveRun.durablyStarted` — see that field's doc
  // comment and `createDurableActiveRun`'s own comment on these callbacks
  // for the call sites that reach them. Split resolve/reject (AB-361
  // review, PRRT_kwDORvupsc6gXHn8) so no failure value — including a
  // literal `undefined` throw/rejection — can be mistaken for success.
  resolveDurablyStarted: () => void,
  rejectDurablyStarted: (error: unknown) => void,
): Promise<RunResult> {
  const runStartTime = runtime.monotonic.now();
  const { hooks } = options;
  let terminalErrorFromEvent: AgentRunError | undefined;
  emitter.addEventListener('run.error', (event) => {
    terminalErrorFromEvent = event.error;
  });

  // RunStartedEvent + onRunStart (an onRunStart error aborts the run) —
  // fired identically whether or not this run was already aborted before
  // dispatch: a caller listening for these events must still see them.
  //
  // AB-361 review (codex P2 PRRT_kwDORvupsc6gXHn4): `startRunLifecycle`
  // itself CAN reject, and the prior rationale here (that native
  // `EventTarget` dispatch isolates a listener's throw) was wrong for this
  // `emitter`. `emitter` is a `CompletableEventTarget`
  // (`packages/lifecycle/src/completable.ts`), whose overridden
  // `dispatchEvent` calls the native dispatch first (which does isolate a
  // native `addEventListener` throw, per spec) and THEN loops every
  // `toObservable()`/`subscribe()` subscriber directly, unguarded. A
  // synchronous throw from one of those observable subscribers propagates
  // straight out of `dispatch()` — and thus out of `startRunLifecycle`'s
  // own `emitter?.dispatch(new RunStartedEvent(...))` call — before this
  // function ever reaches its `startError !== undefined` check. No durable
  // write is attempted on this path either, so `durablyStarted` rejects
  // with that same error instead of hanging forever.
  let startError: unknown;
  try {
    const started = await startRunLifecycle(options, conversation, emitter);
    startError = started.error;
    // COR-766: released when this run reaches a terminal state, so a registry
    // that outlives the run does not accumulate an observer per run. A throw
    // from `startRunLifecycle` itself never attached one.
    emitter.addEventListener('run.completed', started.stopObservingHookPlan, { once: true });
    emitter.addEventListener('run.error', started.stopObservingHookPlan, { once: true });
    emitter.addEventListener('run.aborted', started.stopObservingHookPlan, { once: true });
  } catch (error) {
    rejectDurablyStarted(error);
    return makeErrorResult(
      emptyRunState(),
      conversation,
      hooks,
      emitter,
      terminalErrorFromEvent ?? toAgentRunError(error),
      options.costEstimation,
      undefined,
      hookTracker,
    );
  }
  if (startError !== undefined) {
    // AB-361: no `context.engine.start` call is ever reached on this path —
    // there is no durable write for `durablyStarted` to await, so resolve
    // it immediately (success: cleanup here consisted of never durably
    // launching at all, mirroring `abortedBeforeDrive` below). See AB-34's
    // started-work control contract: this branch's `RunResult` (an
    // already-terminal `finishReason: 'error'`, dispatched synchronously
    // below via `RunCompletedEvent`, before this identifier is ever handed
    // to a caller) settles the run completely before any identifier is
    // returned — there is no in-flight durable work for a restart to find
    // or fail to find. `durablyStarted` gates only on whether a durable
    // launch was attempted, not on whether the run ultimately succeeded.
    resolveDurablyStarted();
    return makeErrorResult(
      emptyRunState(),
      conversation,
      hooks,
      emitter,
      terminalErrorFromEvent ?? toAgentRunError(startError),
      options.costEstimation,
      undefined,
      hookTracker,
    );
  }

  // AB-339: an already-doomed run never durably launches at all — no
  // `context.engine.start` call, so nothing to cancel and nothing for a
  // later `Bureau.shutdown()` to race. Settles straight to an aborted
  // `RunResult` through the SAME `finalizeRunResult` helper every other
  // terminal branch below uses, so `run.aborted` fires (and, per AC1,
  // `onRunAbort`) exactly as it would for an ordinary abort.
  if (abortedBeforeDrive) {
    // AB-361: same reasoning as the `startError` branch above — no durable
    // write was ever attempted.
    resolveDurablyStarted();
    return finalizeRunResult({
      finishReason: 'aborted',
      runState: emptyRunState(),
      conversation,
      hooks,
      emitter,
      runStartTime,
      runtime,
      abortReason: typeof signal.reason === 'string' ? signal.reason : undefined,
      costEstimation: options.costEstimation,
      terminalError: terminalErrorFromEvent,
      hookTracker,
    });
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
  const services: DurableRunDeps = {
    // Keep the resolved durable option on the per-run options object used by
    // each `runStep` invocation. `durableRun.agentName` is authoritative when
    // the caller supplied it separately from `RunOptions`; without copying it
    // here, step-synthesized tool events lose the run identity.
    options: { ...options, agentName, signal },
    toolbox: options.toolbox,
    emitter,
    onStepToolbox,
  };
  // AB-361 review (copilot PRRT_kwDORvupsc6gWb3a, codex P2 PRRT_kwDORvupsc6gWc39):
  // both `onServices` (a caller-supplied callback — genuinely reachable
  // synchronous throw) and `context.engine.start` itself (a real
  // persistence failure, e.g. disk-full) sit BEFORE the durable write
  // `durablyStarted` gates on, and both need to settle that gate with the
  // failure rather than leave a caller (bureau's `createRunFromRequest`)
  // awaiting it forever. Unlike the `startError`/`abortedBeforeDrive`
  // branches above, this failure happens AFTER `store.register` would have
  // run on the bureau side, so it is routed through the SAME
  // `makeErrorResult` helper those branches use — that dispatches
  // `RunCompletedEvent` synchronously, which is what bureau's own
  // `run.completed` listener needs to fire and clean up the run's
  // registration and persist its terminal session state. A raw rethrow
  // here would leave `result` rejecting with no terminal event ever
  // dispatched, so a caller relying on event-driven cleanup (exactly what
  // bureau's `createRunFromRequest` does) would leak the run forever.
  //
  // (Correction, AB-361 review PRRT_kwDORvupsc6gXHn4: an earlier version of
  // this comment claimed `startRunLifecycle`'s own
  // `emitter.dispatch(new RunStartedEvent(...))` could not reject, on the
  // theory that native `EventTarget.dispatchEvent` isolates a listener's
  // throw. That is true for a plain `EventTarget`/native `addEventListener`
  // subscriber, but `emitter` is a `CompletableEventTarget`
  // (`packages/lifecycle/src/completable.ts`), whose overridden
  // `dispatchEvent` calls every `toObservable()`/`subscribe()` observable
  // subscriber directly, unguarded, after the native dispatch returns — a
  // throw there DOES propagate out of `dispatch()` and out of
  // `startRunLifecycle`. See the `try`/`catch` around the
  // `startRunLifecycle` call above, which now covers exactly that gap.)
  let handle: Awaited<ReturnType<typeof context.engine.start>>;
  try {
    // Give the caller a live reference to the EXACT object Weft will hand
    // back as `ctx.services` — see `DurableActiveRunOptions.onServices`.
    // Must fire before `engine.start` so a tool the caller wired against
    // this reference (e.g. `requestHumanInput`) can mutate it the moment
    // `runStep` executes.
    onServices?.(services);

    // `engine.start(...)` is the write `ActiveRun.durablyStarted` exists to
    // gate on — settled the moment this call itself settles, NOT when
    // `handle.result()` later settles (that's the run's own completion, a
    // wholly separate promise `result` above already tracks). A caller
    // awaiting `durablyStarted` only ever waits for THIS commit, never for
    // the run to finish.
    handle = await context.engine.start(
      'agentRun',
      {
        runId,
        sessionId,
        // F2: thread agentName into the durable input so boot recovery can
        // identify which agent ran this workflow without reading the session store.
        agentName,
        prompt,
        maximumSteps: options.maximumSteps,
      },
      {
        id: runId,
        services,
      },
    );
  } catch (error) {
    rejectDurablyStarted(error);
    return makeErrorResult(
      emptyRunState(),
      conversation,
      hooks,
      emitter,
      terminalErrorFromEvent ?? toAgentRunError(error),
      options.costEstimation,
      undefined,
      hookTracker,
    );
  }
  resolveDurablyStarted();

  let summary: AgentRunWorkflowResult;
  try {
    summary = normalizeAgentRunWorkflowResult(await handle.result());
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
      // AB-204: closed() classifies this as unresolved/unreachable, never
      // completed/not-required — see `reachability`'s doc comment above.
      reachability.unreachable = true;
      return makeInterruptedRunResult(conversation);
    }
    // B6 (abort-into-generate): when abort() calls engine.cancel() in parallel
    // with abortController.abort(), engine.cancel() can win the race and set the
    // workflow's state to 'cancelled' before the in-flight generate() rejection
    // has a chance to settle the workflow to 'aborted'. Weft then rejects
    // handle.result() with a plain Error("Workflow cancelled") — not a WeftError
    // (no .code) — so isWeftErrorLike won't match it. Detect it by message and
    // treat it as a clean abort so the terminal lifecycle fires and the session
    // does not stay stuck 'running'. The abort reason (if any) lives on the
    // combined signal that was passed into this call.
    //
    // Reconstruct from the checkpoint so any steps completed before cancel() won
    // the race are preserved in the abort result — matching the normal durable
    // completion path. Fall back to an empty run state if the checkpoint is
    // unavailable (e.g. aborted before any step committed).
    if (error instanceof Error && error.message === 'Workflow cancelled') {
      let cancelledRunState = emptyRunState();
      let cancelledConversation = conversation;
      try {
        const reconstructed = await reconstructRunResult(
          context,
          runId,
          {
            schemaVersion: AGENT_RUN_WORKFLOW_RESULT_SCHEMA_VERSION,
            runId,
            steps: 0,
            content: '',
            finishReason: 'aborted',
          },
          runtime,
        );
        cancelledRunState = reconstructed.runState;
        cancelledConversation = reconstructed.conversation;
      } catch {
        // Checkpoint unavailable — fall back to the seed conversation and an
        // empty run state (no steps committed before cancel won the race).
      }
      return finalizeRunResult({
        finishReason: 'aborted',
        runState: cancelledRunState,
        conversation: cancelledConversation,
        hooks,
        emitter,
        runStartTime,
        runtime,
        abortReason:
          signal.aborted && typeof signal.reason === 'string' ? signal.reason : undefined,
        costEstimation: options.costEstimation,
        terminalError: terminalErrorFromEvent,
        hookTracker,
      });
    }
    // A `history.maxEvents` circuit-breaker (or a genuine execution-deadline
    // timeout) rejects `handle.result()` with a `WorkflowTimeoutError`. The error
    // code is `'WorkflowTimeoutError'` (no 'd' — distinct from the
    // `WorkflowTimedOutEvent` name) and carries NO `terminationReason`, so the
    // circuit-breaker-vs-deadline distinction must come from the engine's stored
    // state. Either way the run is genuinely terminal (not abandoned-for-recovery
    // like EngineDisposedError), so classify it as `error` and fire the terminal
    // lifecycle here rather than rethrowing into the unawaited `.then()` chain
    // (which would surface as an unhandled rejection and leave the session stuck
    // `running`).
    if (!isWeftErrorLike(error) || error.code !== 'WorkflowTimeoutError') throw error;

    const message = await classifyTimeoutMessage(context, runId, error);
    return finalizeRunResult({
      finishReason: 'error',
      runState: emptyRunState(),
      conversation,
      hooks,
      emitter,
      runStartTime,
      runtime,
      errorMessage: message,
      costEstimation: options.costEstimation,
      hookTracker,
    });
  }

  // The authoritative conversation on the durable path is the one rehydrated
  // from the checkpoint — the workflow mutates rehydrated snapshots per step,
  // never the input instance (which stays empty). Use the reconstructed one
  // for the result AND the completion lifecycle so they agree.
  const {
    result,
    runState,
    conversation: durableConversation,
  } = await reconstructRunResult(context, runId, summary, runtime);

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
    runtime,
    errorMessage: summary.errorMessage,
    abortReason: summary.abortReason,
    schemaValidation: summary.schemaValidation,
    output: summary.output,
    tripwire: summary.tripwire,
    costEstimation: options.costEstimation,
    terminalError:
      terminalErrorFromEvent ?? (result.error instanceof AgentRunError ? result.error : undefined),
    hookTracker,
  });
}

/** A throwaway run state for the pre-step error path (no steps completed yet). */
