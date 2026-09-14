import type { RuntimeServices } from 'lifecycle';
import { CompletableEventTarget, createDefaultRuntimeServices } from 'lifecycle';

import type { ChildRunRegistry } from '../child-run';
import { createClosedAcknowledgement } from '../closed-acknowledgement';
import type { ActiveRun } from '../create-run';
import type { CombinedOperativeEventMap, OperativeEventEmitter } from '../events';
import { ToolProgressBubbleEvent, ToolSettledBubbleEvent, ToolStartedBubbleEvent } from '../events';
import type { StallWatchdogClock } from '../liveness';
import { createActiveRunLiveness } from '../liveness';
import { type CleanupAcknowledgement, type RunResult, toRedactedRunResultSummary } from '../types';
import type { DurableActiveRunContext } from './active-run-adapter';
import { isTerminalWorkflowStatus } from './active-run-constants';
import type { RecoveredRunHandle } from './active-run-event-surface';
import { wireHumanWaitLiveness } from './active-run-event-surface';
import { driveReattachedRun } from './active-run-reattach-driver';

export function reattachDurableActiveRun(
  context: DurableActiveRunContext,
  reattach: {
    runId: string;
    handle: RecoveredRunHandle;
    /**
     * The emitter installed in the rebuilt services during Weft's awaited
     * `onRecoveredWorkflow` hook. When present it IS this ActiveRun's event
     * surface, so `runStep` events are observable before resumed user code can
     * advance. Omit when reattaching outside that recovery hook.
     */
    emitter?: OperativeEventEmitter;
    /**
     * Cleanup for the `toolbox → emitter` forwarding the recovery hook wired.
     * Reattach owns it and runs it when the recovered run completes.
     */
    stopToolboxForward?: () => void;
    abort?: (reason?: string) => void;
    /** Test-only clock seam for this run's watchdogs (AB-214/obs-01). */
    livenessClock?: StallWatchdogClock;
    /**
     * The AB-92/AB-252/AB-253 injectable runtime-service seam. Resolved
     * exactly once here — omitted, this reattach reads the real globals via
     * `createDefaultRuntimeServices()`; a caller reattaching under a manual
     * runtime (e.g. `SessionHandleContext.runtime`) passes it through so the
     * reattached run's own duration measurement stays deterministic too.
     */
    runtime?: RuntimeServices;
    /**
     * AB-304: the same `ChildRunRegistry` `RunOptions.childRegistry` supplies
     * to a fresh run, forwarded through for a REATTACHED one. A reattached
     * run has no in-process toolbox forwarding of its own (see
     * `reattach.stopToolboxForward`), so this is the only source of
     * children for this handle's `closed()` — a child dispatched by
     * caller-owned code AFTER reattachment (e.g. a `createSubagentTool`
     * bound to this same registry) is discovered here exactly as it would
     * be for a fresh run. Omitted, `closed()` behaves identically to before
     * this option existed.
     */
    childRegistry?: ChildRunRegistry;
  },
): ActiveRun {
  const { runId, handle } = reattach;
  const childRegistry = reattach.childRegistry;
  const runtime = reattach.runtime ?? createDefaultRuntimeServices();
  const emitter = reattach.emitter ?? new CompletableEventTarget<CombinedOperativeEventMap>();

  const liveness = createActiveRunLiveness({
    id: runId,
    durability: 'durable',
    clock: reattach.livenessClock,
    runtime,
  });

  const onGenerateStarted = () => liveness.recordProviderPulse({ phase: 'started' });
  const onGenerateCompleted = () => liveness.recordProviderPulse({ phase: 'completed' });
  const onGenerateError = () => liveness.recordProviderPulse({ phase: 'error' });
  const onGenerateRetry = () => liveness.recordProviderPulse({ phase: 'retry' });
  const onToolProgressBubble = (event: ToolProgressBubbleEvent) => {
    liveness.recordToolProgressPulse({
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      percent: event.percent,
      message: event.message,
    });
  };
  // AB-214 review (PRRT_kwDORvupsc6etXKX): the in-memory driver
  // (create-run.ts) starts/stops the tool watchdog from
  // `execute-start`/`settled`, not from `tool.progress` alone — a tool that
  // never reports progress would otherwise start no watchdog at all (never
  // going late/unreachable), while a tool that reports exactly one progress
  // event would leave its watchdog running forever after settlement,
  // wrongly marking a later provider step unreachable. Mirror that here
  // from the curated `tool.started`/`tool.settled` bubbles this recovered
  // run's forwarded toolbox actions already produce.
  const onToolStartedBubble = () => liveness.beginToolCall();
  const onToolSettledBubble = () => liveness.endToolCall();
  emitter.addEventListener('generate.started', onGenerateStarted);
  emitter.addEventListener('generate.completed', onGenerateCompleted);
  emitter.addEventListener('generate.error', onGenerateError);
  emitter.addEventListener('generate.retry', onGenerateRetry);
  emitter.addEventListener(ToolProgressBubbleEvent.type, onToolProgressBubble);
  emitter.addEventListener(ToolStartedBubbleEvent.type, onToolStartedBubble);
  emitter.addEventListener(ToolSettledBubbleEvent.type, onToolSettledBubble);
  // AB-336 — see `wireHumanWaitLiveness`'s doc comment. A reattached run
  // whose park predates THIS process (the common recovery case) starts its
  // liveness fresh at `'running'` — nothing here retroactively reconstructs
  // a wait from the checkpoint — but this still covers a reattached run
  // that calls `requestHumanInput` again during its own remaining lifetime.
  const stopHumanWaitLiveness = wireHumanWaitLiveness(emitter, liveness);

  // The awaited recovery hook already forwards toolbox actions into `emitter`.
  // Reattach owns the teardown so the subscription stops on completion, plus
  // this function's own liveness listeners registered just above.
  function toolboxForwardCleanup(): void {
    reattach.stopToolboxForward?.();
    emitter.removeEventListener('generate.started', onGenerateStarted);
    emitter.removeEventListener('generate.completed', onGenerateCompleted);
    emitter.removeEventListener('generate.error', onGenerateError);
    emitter.removeEventListener('generate.retry', onGenerateRetry);
    emitter.removeEventListener(ToolProgressBubbleEvent.type, onToolProgressBubble);
    emitter.removeEventListener(ToolStartedBubbleEvent.type, onToolStartedBubble);
    emitter.removeEventListener(ToolSettledBubbleEvent.type, onToolSettledBubble);
    stopHumanWaitLiveness();
  }

  // Resolves `true` only when an adapter-initiated `engine.cancel` SUCCEEDS for
  // this run — i.e. THIS abort terminalized the run. `undefined` means no abort
  // was requested. The result-rejection path classifies as `aborted` ONLY when
  // this proves the cancel caused the termination; if cancel rejected (the run was
  // already terminal for a resolver/teardown reason) it stays on the write-free
  // path and does not clobber that owner's status (committee round-3 finding 1).
  let abortCancelled: Promise<boolean> | undefined;

  // closed()'s AC8 (AB-204): a pending `result()` waiter rejected with
  // `EngineDisposedError` (bureau teardown mid-resume) must classify as
  // `{ status: 'unresolved', reason: 'unreachable' }`, never `failed` — but
  // `driveReattachedRun` swallows that rejection into a write-free, resolved
  // `RunResult` (see its own doc comment), so the public `result` promise
  // never rejects to signal it. This ref is the side channel: set by
  // `driveReattachedRun` right before it returns that quiet result.
  const reachability = { unreachable: false };

  function complete(): void {
    toolboxForwardCleanup?.();
    emitter.complete();
    // See the identical reasoning in the fresh-run `complete()` above
    // (AB-214 review PRRT_kwDORvupsc6esZSM) — no separate dispose call
    // belongs here.
  }

  function abortOutcome(): Promise<boolean> | undefined {
    return abortCancelled;
  }

  function drive(): Promise<RunResult> {
    return driveReattachedRun(context, runId, handle, emitter, abortOutcome, reachability, runtime);
  }

  function cancelSucceeded(): boolean {
    return true;
  }

  function cancelFailed(): boolean {
    return false;
  }

  // A reattached run has no abort SIGNAL (the recovered generator runs under the
  // engine, not this adapter's controller), so abort cancels the run at the
  // engine instead (committee MF-3): a recovered run is now visible via
  // `getRun(runId)`, so `bureau.abortRun(runId)` must actually stop it rather
  // than silently no-op. `engine.cancel` terminalizes the run and rejects its
  // result waiter; the rejection is translated into a real `run.aborted`
  // lifecycle (so gateway persists `aborted`) — but ONLY if the cancel actually
  // succeeded (abortCancelled resolves true), distinguishing this abort from a
  // resolver/teardown failure that merely raced an abort() call. Idempotent via
  // `abortCancelled ??=`, so a later dispose() that also aborts is a no-op.
  function abort(): void {
    liveness.setStatus('aborting');
    reattach.abort?.('Aborted durable run');
    abortCancelled ??= context.engine.cancel(runId).then(cancelSucceeded, cancelFailed);
  }

  // Deferred-microtask start — REQUIRED for the registration ordering invariant:
  // the caller (`recoverDurableRuns`) must finish `store.register` +
  // `runSessionIdentifiers.set` in its synchronous turn BEFORE any terminal event
  // microtask fires, so `getRun(runId)` resolves and no subscriber misses the
  // terminal event — even when `handle.result()` already settled before reattach.
  const result = Promise.resolve()
    .then(drive)
    .then(
      (runResult) => {
        // Redacted (AB-214 review PRRT_kwDORvupsc6es7pl): every standalone
        // run's projection is `'redacted'` permanently, so the raw
        // `RunResult` never reaches the snapshot; only the safe summary does.
        liveness.settle(toRedactedRunResultSummary(runResult));
        return runResult;
      },
      (error: unknown) => {
        liveness.setStatus('terminal');
        throw error;
      },
    )
    .finally(complete);

  async function resolveReattachOutcome(): Promise<CleanupAcknowledgement> {
    if (reachability.unreachable) return { status: 'unresolved', reason: 'unreachable' };
    if (abortCancelled === undefined) {
      // AB-304: matching `createDurableActiveRun`'s identical fold-in — a
      // registered child's own `closed()` must settle before this
      // reattached parent reports `completed`, not merely its `result()`.
      await (childRegistry?.awaitChildrenClosed() ?? Promise.resolve());
      return { status: 'completed' };
    }
    // Wait for the SAME cancel attempt abort() fired (never rejects: it is
    // already `.then(cancelSucceeded, cancelFailed)`), then re-read the
    // durable record — matching `createDurableActiveRun`'s AC7 reasoning: a
    // non-throwing `engine.cancel` alone is not proof of a committed record.
    await abortCancelled;
    try {
      const state = await context.engine.get(runId);
      // See `createDurableActiveRun`'s identical `resolveDurableOutcome`
      // reasoning: a nonterminal status means the cancellation has not
      // actually taken effect yet.
      if (!state || !isTerminalWorkflowStatus(state.status)) {
        return { status: 'unresolved', reason: 'persistence-failed' };
      }
      // AB-304: same children-closed fold-in as the uncancelled branch above.
      await (childRegistry?.awaitChildrenClosed() ?? Promise.resolve());
      return { status: 'completed' };
    } catch (error) {
      return { status: 'unresolved', reason: 'persistence-failed', error };
    }
  }

  const closed = createClosedAcknowledgement({
    result,
    // A cancellation always disqualifies not-required, and so does
    // `reachability.unreachable` — otherwise the fast path could resolve
    // not-required for a run `resolveReattachOutcome` would have classified
    // unresolved/unreachable (AC8), silently hiding the teardown race.
    disqualifiesFastPath: () => abortCancelled !== undefined || reachability.unreachable,
    // No toolbox forwarding is owned by this adapter — see `reattach.stopToolboxForward`
    // above — so no in-flight-tool count is available to track here. AB-304:
    // a registered child still disqualifies the fast path the same way it
    // does for a fresh run — its own `closed()` can be pending even once its
    // `result()` has resolved.
    hasInFlightWork: () => (childRegistry?.children().length ?? 0) > 0,
    resolveOutcome: resolveReattachOutcome,
  });

  return {
    result,
    abort,
    closed,
    // AB-361: a reattached/recovered run's durable record was committed
    // before this process even started — nothing left to await.
    durablyStarted: Promise.resolve(),
    addEventListener: emitter.addEventListener.bind(emitter),
    removeEventListener: emitter.removeEventListener.bind(emitter),
    on: emitter.on.bind(emitter),
    once: emitter.once.bind(emitter),
    subscribe: emitter.subscribe.bind(emitter),
    events: emitter.events.bind(emitter) as ActiveRun['events'],
    toObservable: emitter.toObservable.bind(emitter),
    complete,
    snapshot: () => liveness.snapshot(),
    subscribeSnapshot: (observer, options) => liveness.subscribeSnapshot(observer, options),
    [Symbol.dispose](): void {
      // Cancel the durable run at the engine BEFORE completing the local emitter,
      // mirroring the live createActiveRun dispose. A reattached/recovered run
      // (session.recover() / boot reattach) keeps executing — and billing — under
      // the Weft engine, not this adapter's controller. Disposing the public
      // AgentRun must therefore stop the workflow, not just make the caller stop
      // observing it. abort() is idempotent (abortCancelled ??=), so a prior
      // explicit abort() + dispose() does not double-cancel (PRRT — Codex
      // re-review of 7b910a15).
      abort();
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
