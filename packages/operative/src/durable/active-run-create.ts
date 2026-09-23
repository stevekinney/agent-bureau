import { CompletableEventTarget, createDefaultRuntimeServices } from '@lostgradient/lifecycle';
import { Conversation, isConversation } from 'conversationalist';

import { createClosedAcknowledgement, foldTerminalCleanup } from '../closed-acknowledgement';
import type { ActiveRun } from '../create-run';
import { toAgentRunError } from '../errors';
import type { CombinedOperativeEventMap } from '../events';
import { createActiveRunLiveness } from '../liveness';
import { type CleanupAcknowledgement, type RunResult, toRedactedRunResultSummary } from '../types';
import type { DurableActiveRunContext, DurableActiveRunOptions } from './active-run-adapter';
import { isTerminalWorkflowStatus } from './active-run-constants';
import { createDurableToolboxForwarder } from './active-run-create-event-surface';
import { driveDurableRun } from './active-run-driver';
import { wireHumanWaitLiveness } from './active-run-event-surface';

export function createDurableActiveRun(
  context: DurableActiveRunContext,
  durableRun: DurableActiveRunOptions,
): ActiveRun {
  const { runId, options } = durableRun;
  // AB-304: forwarded straight through from `RunOptions.childRegistry`,
  // matching `create-run.ts`'s identical extraction — see this file's
  // `resolveDurableOutcome`/`hasInFlightWork` for how it folds into
  // `closed()`.
  const childRegistry = options.childRegistry;
  // AB-92/AB-252/AB-253: resolved exactly once, here — `create-run.ts`
  // already resolves and snapshots `options.runtime` before routing to this
  // durable path, so this default only covers a caller that constructs a
  // durable run outside that composition root.
  const runtime = options.runtime ?? createDefaultRuntimeServices();
  // F2: resolve agentName — explicit > RunOptions.agentName > empty string.
  const agentName = durableRun.agentName ?? options.agentName ?? '';
  // Use the caller-supplied emitter when provided (see `DurableActiveRunOptions.emitter`)
  // so a toolbox tool built against that same emitter dispatches onto the exact
  // surface this `ActiveRun` exposes. Falls back to a fresh one otherwise.
  const emitter = durableRun.emitter ?? new CompletableEventTarget<CombinedOperativeEventMap>();
  const abortController = new AbortController();

  const combinedSignal = options.signal
    ? AbortSignal.any([options.signal, abortController.signal])
    : abortController.signal;

  const conversation = isConversation(options.conversation)
    ? options.conversation
    : // AB-321: forwards the resolved runtime into the Conversation's own
      // environment seam, matching `create-run.ts`'s in-memory path.
      new Conversation(options.conversation, { runtime });

  const liveness = createActiveRunLiveness({
    id: runId,
    durability: 'durable',
    clock: durableRun.livenessClock,
    runtime,
    owner: durableRun.livenessOwner,
  });

  // Forward toolbox events with the `toolbox` prefix, as createRun does. The
  // toolbox is the SAME instance `runStep` executes in-process under inline mode,
  // so its events fire live on the durable path.
  //
  // We deliberately do NOT forward `conversation:*` events here. Unlike the
  // in-memory loop, the durable workflow operates on per-step
  // `Conversation.from(snapshot)` instances and never mutates this input
  // instance — it only snapshots it once to seed. Forwarding from it would be
  // inert (no events ever fire). Durable per-step conversation streaming is
  // therefore not exposed by this adapter.
  const cleanups: (() => void)[] = [];
  cleanups.push(wireHumanWaitLiveness(emitter, liveness));
  // closed()'s not-required fast path (coordinator ruling, AB-204) — see the
  // identical counter in `create-run.ts`.
  let inFlightTools = 0;
  // AB-290: mirrors `create-run.ts`'s identically-named helper — a caller
  // can supply the SAME `Toolbox` instance to more than one concurrent run,
  // and armorer's `execute-start`/`progress`/`settled` events are
  // toolbox-wide, not scoped to any one run. `run-step.ts` stamps this
  // run's own id as `ownerId` on every `Toolbox.execute()` call it makes;
  // armorer echoes it back verbatim.
  const isOwnEvent = (event: { ownerId?: string | undefined }): boolean => event.ownerId === runId;
  // AB-291 (AC1 — durable parity with AB-204's in-memory fix): every
  // run-owned hook (`onRunStart`/`onRunAbort`/`onRunError`/`onRunComplete`)
  // fires via `runHookSilently`'s fire-and-forget `Promise.allSettled`
  // inside `run-lifecycle.ts`, so `result` can settle while one is still
  // running — the identical gap `create-run.ts`'s `pendingHookPromises`/
  // `hookTracker` close for the in-memory loop. Threaded through `drive()`
  // into `driveDurableRun`/`finalizeRunResult` so every terminal-lifecycle
  // helper call records its hook promise here; `resolveDurableOutcome`
  // awaits all of them before reporting `completed`.
  const pendingHookPromises: Promise<unknown>[] = [];
  const hookTracker = (promise: Promise<unknown>): void => {
    pendingHookPromises.push(promise);
  };
  // C3 — curated tool.* bubble events stamped with {agentName, runId, step}.
  // Mirrors the same block in createActiveRun (the in-memory path) so the
  // audit trail and operative store receive identical tool.* events regardless
  // of whether the run is in-memory or durable. Without this, durable tool
  // calls were absent from both the curated run stream and /api/v1/audit for
  // persistent bureaus (PRRT_kwDORvupsc6MV8Xa).
  //
  // AB-294: these listeners move onto the same per-step subscription
  // `toolboxForwarder` uses for the low-level `toolbox.*` forward (AB-239) —
  // see `attachToolboxCuratedListeners` below, passed to
  // `createToolboxEventForwarder` as its `attachCurated` argument.
  const toolboxForwarder = createDurableToolboxForwarder({
    toolbox: options.toolbox,
    emitter,
    cleanups,
    runId,
    agentName,
    runtime,
    liveness,
    isOwnEvent,
    onToolStarted: () => {
      inFlightTools += 1;
    },
    onToolSettled: () => {
      inFlightTools = Math.max(0, inFlightTools - 1);
    },
  });
  cleanups.push(() => toolboxForwarder.stop());

  function complete(): void {
    for (const cleanup of cleanups) cleanup();
    emitter.complete();
    // Liveness disposal happens exclusively via `setStatus('terminal')`/
    // `settle()` below, which always run before this `.finally(complete)`
    // callback does (AB-214 review PRRT_kwDORvupsc6esZSM) — no separate
    // dispose call belongs here.
  }

  // closed()'s AC8-equivalent for a FRESH (non-reattached) run (AB-204): a
  // pending `handle.result()` waiter rejected with `EngineDisposedError`
  // (bureau teardown mid-run) is swallowed by `driveDurableRun` into a
  // quiet, resolved, write-free `RunResult` — see its own doc comment —
  // rather than firing a terminal lifecycle. Cleanup is genuinely
  // unconfirmed there, so `resolveDurableOutcome` must classify it
  // unresolved/unreachable, never `completed`/`not-required`. Same side
  // channel `reattachDurableActiveRun`'s `reachability` uses, since the
  // rejection this observes is likewise invisible on the public `result`.
  const reachability = { unreachable: false };

  // AB-339: an `abort()` that lands before `driveStarted` ever flips true
  // — i.e. before the deferred microtask below has even run — must not
  // still let `driveDurableRun` call `context.engine.start(...)`. `abort()`
  // itself already treats this exact window as "the workflow doesn't exist
  // and engine.cancel() is a no-op" (see its own comment below); but
  // nothing previously acted on that observation once the deferred
  // microtask actually fired, so `driveDurableRun` durably launched the
  // workflow anyway — purely so it could immediately race
  // `Bureau.shutdown()`'s own (policy-'abort', by design
  // unbounded-wait-free — AB-207) engine disposal. If that disposal wins,
  // `handle.result()` rejects with `EngineDisposedError`,
  // `reachability.unreachable` flips true, and `resolveDurableOutcome`
  // reports a real `unresolved`/`unreachable` leak for a run that never
  // did anything durable at all.
  //
  // Deliberately NOT a live `combinedSignal.aborted` re-check inside
  // `driveDurableRun`: an `abort()` that arrives AFTER `driveStarted` has
  // already flipped true (the ordinary "abort while `driveDurableRun` is
  // still inside its own `startRunLifecycle` await" case every other test
  // in this file exercises) already fires `engine.cancel()` via `abort()`'s
  // `if (driveStarted)` branch below — that in-flight cancel must still
  // resolve against a workflow `engine.start` actually launches. Only the
  // synchronous snapshot taken in the SAME microtask `driveStarted` flips
  // in — captured once, before `drive()` runs — tells the two cases apart.
  const neverLaunched = { value: false };

  // AB-361: settles `durablyStarted` (below) exactly once, from inside
  // `driveDurableRun` — resolved the moment `context.engine.start(...)`
  // durably commits this run's initial workflow record (or, on a path that
  // never reaches that call at all — `startError`/`abortedBeforeDrive` —
  // resolved immediately, since there is then no durable write to await),
  // rejected on any failure that precedes that commit. Never called twice:
  // each `driveDurableRun` invocation reaches exactly one of its call sites
  // for these callbacks.
  //
  // AB-361 review (codex P2 PRRT_kwDORvupsc6gXHn8): split into two
  // functions rather than one `(error?: unknown) => void` discriminated on
  // `error !== undefined`. That discriminator resolved the gate on a
  // rejection value of literal `undefined` (e.g. `engine.start` rejecting
  // with no reason, or a caller's `onServices` doing `throw undefined`) —
  // silently reporting success for a durable write that never happened.
  // `rejectDurablyStarted` is unconditional: every call site that reaches
  // it is, by construction, a failure.
  let resolveDurablyStarted!: () => void;
  let rejectDurablyStarted!: (error: unknown) => void;
  const durablyStarted = new Promise<void>((resolve, reject) => {
    // The Promise executor runs synchronously, so both callbacks are
    // assigned before this constructor call returns — no dead initial value
    // is ever needed (and, unlike a placeholder `() => {}` default, none is
    // ever left uncalled for coverage to flag).
    resolveDurablyStarted = resolve;
    rejectDurablyStarted = (error: unknown) => {
      // A caller that awaits `durablyStarted` sees exactly whatever the
      // failing call itself rejected/threw with when it was already an
      // `Error`; a non-`Error` value (rare — Weft always rejects with a
      // real `Error`) is wrapped via `AgentRunError`'s own unknown-error
      // formatter rather than a bare `String(error)`, satisfying
      // `prefer-promise-reject-errors` without risking `[object Object]`.
      // This wrap treats `undefined`/`null` the same as any other
      // non-`Error` value — it does not special-case them into a resolve.
      reject(error instanceof Error ? error : toAgentRunError(error));
    };
  });
  // A caller of `createActiveRun` is not obligated to read `durablyStarted`
  // — only `createRunFromRequest`'s durable branch does. Without this, a
  // rejecting `engine.start` (e.g. a genuine persistence failure) would
  // surface as an unhandled rejection for every OTHER durable caller
  // (scheduler, session-handle, tests) that never awaits this field. A
  // caller that DOES await it still observes the rejection normally.
  durablyStarted.catch(() => {});

  function drive(abortedBeforeDrive: boolean): Promise<RunResult> {
    neverLaunched.value = abortedBeforeDrive;
    return driveDurableRun(
      context,
      runId,
      durableRun.sessionId,
      agentName,
      options,
      conversation,
      combinedSignal,
      emitter,
      durableRun.prompt,
      durableRun.onServices,
      reachability,
      abortedBeforeDrive,
      (toolbox) => toolboxForwarder.onStepToolbox(toolbox),
      runtime,
      hookTracker,
      resolveDurablyStarted,
      rejectDurablyStarted,
    );
  }

  {
    const onGenerateStarted = () => liveness.recordProviderPulse({ phase: 'started' });
    const onGenerateCompleted = () => liveness.recordProviderPulse({ phase: 'completed' });
    const onGenerateError = () => liveness.recordProviderPulse({ phase: 'error' });
    const onGenerateRetry = () => liveness.recordProviderPulse({ phase: 'retry' });
    emitter.addEventListener('generate.started', onGenerateStarted);
    emitter.addEventListener('generate.completed', onGenerateCompleted);
    emitter.addEventListener('generate.error', onGenerateError);
    emitter.addEventListener('generate.retry', onGenerateRetry);
    cleanups.push(() => {
      emitter.removeEventListener('generate.started', onGenerateStarted);
      emitter.removeEventListener('generate.completed', onGenerateCompleted);
      emitter.removeEventListener('generate.error', onGenerateError);
      emitter.removeEventListener('generate.retry', onGenerateRetry);
    });
  }

  // Track whether the deferred-microtask drive() call has started. This flag
  // lets abort() know whether the Weft workflow has been handed to the engine,
  // so it can fire engine.cancel() in parallel with the AbortController signal.
  // Before the first microtask fires, only the AbortController abort is needed
  // (the workflow doesn't exist yet). After it fires, engine.cancel() is also
  // needed so the next step never starts.
  let driveStarted = false;

  // Deferred-microtask start so callers attach listeners first (createRun contract).
  const result = Promise.resolve()
    .then(() => {
      // AB-339: snapshot taken in the SAME synchronous step `driveStarted`
      // flips in — see `drive()`'s own doc comment for why this can't be a
      // later, live re-check.
      const abortedBeforeDrive = combinedSignal.aborted;
      driveStarted = true;
      return drive(abortedBeforeDrive);
    })
    .then(
      (runResult) => {
        // Redacted (AB-214 review PRRT_kwDORvupsc6es7pl): every standalone
        // run's projection is `'redacted'` permanently, so the raw
        liveness.settle(toRedactedRunResultSummary(runResult));
        return runResult;
      },
      (error: unknown) => {
        liveness.setStatus('terminal');
        throw error;
      },
    )
    .finally(complete);

  let cancelRequested = false;
  let cancelSettled: Promise<void> | undefined;
  let rejectCancelGate: ((error: unknown) => void) | undefined;
  const cancelRejectionGate = new Promise<never>((_resolve, reject) => {
    rejectCancelGate = reject;
  });

  function abort(reason?: string): void {
    cancelRequested = true;
    liveness.setStatus('aborting');
    abortController.abort(reason);

    if (driveStarted) {
      cancelSettled ??= context.engine.cancel(runId).catch(async (error: unknown) => {
        try {
          const state = await context.engine.get(runId);
          if (state?.status === 'suspended') {
            rejectCancelGate?.(error);
          }
        } catch {
          // The cancellation result remains authoritative when state lookup fails.
        }
      });
    }
  }

  if (combinedSignal.aborted) {
    abort(typeof combinedSignal.reason === 'string' ? combinedSignal.reason : undefined);
  } else {
    const onCombinedSignalAbort = (): void =>
      abort(typeof combinedSignal.reason === 'string' ? combinedSignal.reason : undefined);
    combinedSignal.addEventListener('abort', onCombinedSignalAbort, { once: true });
    cleanups.push(() => combinedSignal.removeEventListener('abort', onCombinedSignalAbort));
  }

  // COR-625: the composer's terminal-cleanup step, folded in only on the
  // paths that would otherwise report `completed`. An `unresolved` or
  // `unreachable` run never reached a truthful terminal state, so there is
  // nothing for a retention step to act on and no acknowledgement of its own
  // to fold.
  const terminalCleanupStep = context.terminalCleanup
    ? (): Promise<CleanupAcknowledgement> => context.terminalCleanup!(runId)
    : undefined;

  async function resolveDurableOutcome(): Promise<CleanupAcknowledgement> {
    if (reachability.unreachable) return { status: 'unresolved', reason: 'unreachable' };
    if (!cancelRequested && !combinedSignal.aborted) {
      await Promise.all([
        Promise.allSettled(pendingHookPromises),
        childRegistry?.awaitChildrenClosed() ?? Promise.resolve(),
      ]);
      return foldTerminalCleanup({ status: 'completed' }, terminalCleanupStep);
    }
    if (neverLaunched.value) {
      await Promise.all([
        Promise.allSettled(pendingHookPromises),
        childRegistry?.awaitChildrenClosed() ?? Promise.resolve(),
      ]);
      return foldTerminalCleanup({ status: 'completed' }, terminalCleanupStep);
    }
    await cancelSettled;
    try {
      const state = await context.engine.get(runId);
      if (!state || !isTerminalWorkflowStatus(state.status)) {
        return { status: 'unresolved', reason: 'persistence-failed' };
      }
      await Promise.all([
        Promise.allSettled(pendingHookPromises),
        childRegistry?.awaitChildrenClosed() ?? Promise.resolve(),
      ]);
      return foldTerminalCleanup({ status: 'completed' }, terminalCleanupStep);
    } catch (error) {
      return { status: 'unresolved', reason: 'persistence-failed', error };
    }
  }

  const closedGate = Promise.race([result, cancelRejectionGate]);

  const closed = createClosedAcknowledgement({
    result: closedGate,
    disqualifiesFastPath: () =>
      cancelRequested ||
      combinedSignal.aborted ||
      reachability.unreachable ||
      // COR-625: a registered terminal-cleanup step means this run genuinely
      // DOES have cleanup left to do, which is precisely what the
      // `not-required` fast path asserts is false. Taking the fast path here
      // would skip `resolveOutcome` — and with it the step — so `closed()`
      // would report `not-required` for a run whose retention step had not
      // run, or had failed. A composer that registers no step is unaffected.
      terminalCleanupStep !== undefined,
    hasInFlightWork: () => inFlightTools > 0 || (childRegistry?.children().length ?? 0) > 0,
    resolveOutcome: resolveDurableOutcome,
  });

  return {
    result,
    abort,
    // COR-1270 — the durable branch reads the same snapshot the in-memory
    // branch does: whatever plan this run was dispatched with.
    describeHookPlan: () => options.hooks?.describePlan(),
    closed,
    durablyStarted,
    addEventListener: emitter.addEventListener.bind(emitter),
    removeEventListener: emitter.removeEventListener.bind(emitter),
    on: emitter.on.bind(emitter),
    once: emitter.once.bind(emitter),
    subscribe: emitter.subscribe.bind(emitter),
    events: emitter.events.bind(emitter) as ActiveRun['events'],
    toObservable: emitter.toObservable.bind(emitter),
    complete,
    snapshot: () => liveness.snapshot(),
    subscribeSnapshot: (observer, subscriptionOptions) =>
      liveness.subscribeSnapshot(observer, subscriptionOptions),
    [Symbol.dispose](): void {
      abort();
      complete();
    },
  };
}
