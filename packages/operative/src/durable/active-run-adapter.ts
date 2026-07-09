import { HISTORY_CIRCUIT_BREAKER_REASON, isWeftErrorLike } from '@lostgradient/weft';
import type { ToolboxEventMap } from 'armorer';
import { Conversation, isConversation } from 'conversationalist';
import type { ForwardableSource } from 'lifecycle';
import { CompletableEventTarget, forwardEvents } from 'lifecycle';

import type { ActiveRun } from '../create-run';
import { BudgetExceededError, ElicitationDeniedError } from '../errors';
import type { CombinedOperativeEventMap } from '../events';
import {
  StepStartedEvent,
  ToolErrorBubbleEvent,
  ToolPolicyDeniedBubbleEvent,
  ToolProgressBubbleEvent,
  ToolSettledBubbleEvent,
  ToolStartedBubbleEvent,
} from '../events';
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

/**
 * Tag stamped on every durable run launched by the operative scheduler (via
 * {@link startDurableRunResult}). Weft 0.7 recovery reads it from
 * `WorkflowServicesResolverInfo.launchOptions.tags` to discriminate
 * scheduler-origin runs from genuine session runs — a scheduler run is a
 * live-process concern with no bureau session behind it, so on a crash it is
 * cancelled, never reattached as a session run. Direct handle metadata carries
 * the same tag; the boot sweep still uses the stable id prefix so legacy untagged
 * suspended residue remains cleanupable. Exported through `operative/durable`
 * (no `operative/scheduler` subpath export exists) so the gateway recovery path
 * can import it.
 */
export const SCHEDULER_ORIGIN_TAG = 'bureau:scheduler-origin' as const;

/**
 * Id prefix for durable scheduler runs (`scheduler-run-<taskId>-<n>`). A scheduler
 * run uses a synthetic id as BOTH its runId and its phantom sessionId. New
 * recovery resolver calls use {@link SCHEDULER_ORIGIN_TAG}; the prefix remains
 * for suspended-residue cleanup and for legacy persisted runs whose launch
 * metadata predates the tag-aware resolver context.
 */
export const SCHEDULER_RUN_ID_PREFIX = 'scheduler-run-' as const;

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
  /**
   * The name of the agent that owns this run (F2 — RunRef.agentName).
   *
   * Threaded into the durable workflow input so boot recovery can identify which
   * agent ran a given workflow without reading the session store. Defaults to
   * `options.agentName ?? ''` when not explicitly supplied. A session worked by
   * a SEQUENCE of different agents (via handoff) stores one agentName per run,
   * giving a full audit trail of which agent handled each run.
   */
  agentName?: string;
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
 * Seam #11 (hook replay on recovery) is RESOLVED, not open here: this function
 * is only ever invoked to START a fresh run (see `create-run.ts`); a
 * cross-process resume goes through {@link reattachDurableActiveRun} instead,
 * whose docblock documents why the run-level lifecycle does not re-fire
 * (`hooks: undefined`, no `startRunLifecycle` call). Step-level hooks are
 * protected by `ctx.memo` wrapping the whole step in run-workflow.ts — see its
 * "#11 hook side-effect-ness on resume" remark for the full resolution.
 */
export function createDurableActiveRun(
  context: DurableActiveRunContext,
  durableRun: DurableActiveRunOptions,
): ActiveRun {
  const { runId, options } = durableRun;
  // F2: resolve agentName — explicit > RunOptions.agentName > empty string.
  const agentName = durableRun.agentName ?? options.agentName ?? '';
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

  // C3 — curated tool.* bubble events stamped with {agentName, runId, step}.
  // Mirrors the same block in createActiveRun (the in-memory path) so the
  // audit trail and operative store receive identical tool.* events regardless
  // of whether the run is in-memory or durable. Without this, durable tool
  // calls were absent from both the curated run stream and /api/v1/audit for
  // persistent bureaus (PRRT_kwDORvupsc6MV8Xa).
  {
    let currentStep = 0;

    const stepListener = (e: StepStartedEvent) => {
      currentStep = e.step;
    };
    emitter.addEventListener(StepStartedEvent.type, stepListener);
    cleanups.push(() => emitter.removeEventListener(StepStartedEvent.type, stepListener));

    const toolbox = options.toolbox as unknown as {
      addEventListener?: <K extends keyof ToolboxEventMap>(
        type: K,
        listener: (e: ToolboxEventMap[K]) => void,
        options?: AddEventListenerOptions,
      ) => () => void;
    };

    const onExecuteStart = (e: ToolboxEventMap['execute-start']) => {
      emitter.dispatchEvent(
        new ToolStartedBubbleEvent(
          { agentName, runId, step: currentStep },
          {
            toolName: e.call.name,
            toolCallId: e.call.id,
            params: e.params,
            startedAt: Date.now(),
          },
        ),
      );
    };

    const onSettled = (e: ToolboxEventMap['settled']) => {
      const hasError = e.error !== undefined;
      const status: 'success' | 'error' = hasError ? 'error' : 'success';
      emitter.dispatchEvent(
        new ToolSettledBubbleEvent(
          { agentName, runId, step: currentStep },
          {
            toolName: e.call.name,
            toolCallId: e.call.id,
            status,
            result: e.result,
            error: e.error,
          },
        ),
      );
      if (hasError) {
        emitter.dispatchEvent(
          new ToolErrorBubbleEvent(
            { agentName, runId, step: currentStep },
            {
              toolName: e.call.name,
              toolCallId: e.call.id,
              error: e.error,
            },
          ),
        );
      }
    };

    const onToolProgress = (e: ToolboxEventMap['progress']) => {
      emitter.dispatchEvent(
        new ToolProgressBubbleEvent(
          { agentName, runId, step: currentStep },
          {
            toolName: e.call.name,
            toolCallId: e.call.id,
            percent: e.percent,
            message: e.message,
          },
        ),
      );
    };

    const onPolicyDenied = (e: ToolboxEventMap['policy-denied']) => {
      emitter.dispatchEvent(
        new ToolPolicyDeniedBubbleEvent(
          { agentName, runId, step: currentStep },
          {
            toolName: e.call.name,
            toolCallId: e.call.id,
            reason: e.reason,
          },
        ),
      );
    };

    if (toolbox.addEventListener) {
      const addListener = toolbox.addEventListener.bind(toolbox);
      const toolboxCleanups = [
        addListener('execute-start', onExecuteStart, { signal: abortController.signal }),
        addListener('settled', onSettled, { signal: abortController.signal }),
        addListener('progress', onToolProgress, { signal: abortController.signal }),
        addListener('policy-denied', onPolicyDenied, { signal: abortController.signal }),
      ];
      cleanups.push(() => {
        for (const cleanup of toolboxCleanups) cleanup?.();
      });
    }
  }

  function complete(): void {
    for (const cleanup of cleanups) cleanup();
    emitter.complete();
  }

  function drive(): Promise<RunResult> {
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
    );
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
      driveStarted = true;
      return drive();
    })
    .finally(complete);

  function abort(reason?: string): void {
    // CRITICAL (B6 — "the link that stops the bill"): fire the AbortController
    // IMMEDIATELY so the in-flight generate() call (inside ctx.memo in the
    // durable workflow) drops its provider connection NOW. This does NOT wait
    // for Weft to honor termination at the next yield* boundary — it reaches
    // the generate() AbortSignal directly and drops the network connection
    // within ~1s regardless of what Weft does.
    abortController.abort(reason);

    // Also terminate the Weft workflow in parallel. Weft termination is honored
    // at the next yield* (AFTER the in-flight ctx.memo step). Calling
    // engine.cancel() here prevents the workflow from starting a second step
    // once the current step's AbortSignal-aborted generate() resolves. The two
    // actions are complementary, not redundant:
    //   AbortController.abort() — stops the current billing call immediately.
    //   engine.cancel()         — stops the next step from starting.
    // We only call engine.cancel() after the deferred microtask has fired,
    // i.e. after drive() was invoked and the workflow was handed to the engine.
    // Before that, the workflow doesn't exist and engine.cancel() is a no-op.
    if (driveStarted) {
      // Fire-and-forget: a failing cancel (run already terminal) is not an
      // error — the AbortController already dropped the in-flight connection.
      void context.engine.cancel(runId).catch(() => {
        // Swallow: run may already be terminal. The AbortController signal is
        // the load-bearing stop; engine.cancel is belt-and-suspenders.
      });
    }
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
  reattach: {
    runId: string;
    handle: RecoveredRunHandle;
    /**
     * The emitter the resolver pre-allocated and injected into the recovered run's
     * rebuilt `services` (#28). When present it IS this ActiveRun's event surface,
     * so the per-step events `runStep` dispatches during resume reach
     * `getRun(runId)` subscribers — instead of the reattach path opening a fresh,
     * disconnected emitter. The resolver and this reattach run on the same boot
     * pass keyed by the same `runId`, so reusing one emitter is the wiring that
     * closes seam #10's step visibility. Omit (fresh emitter) when there is no
     * resolver-built emitter (e.g. a handle reattached outside recovery).
     *
     * Residual race (documented, narrow): an event `runStep` dispatches in the
     * SAME microtask `recoverAll()` drives the generator — i.e. before
     * `recoverDurableRuns` attaches this ActiveRun's listeners synchronously on the
     * next turn — is not observed (CompletableEventTarget does not replay to late
     * subscribers). Only the earliest events of a run that races to its first step
     * inside recoverAll are affected; every subsequent event is live.
     */
    emitter?: CompletableEventTarget<CombinedOperativeEventMap>;
    /**
     * Cleanup for the `toolbox → emitter` forwarding the RESOLVER already wired
     * (#28). The resolver forwards `toolbox:*` events from the moment services are
     * built — closing the window where a fast-resuming run fires its first step
     * before reattach runs — so reattach does NOT re-wire forwarding; it only takes
     * OWNERSHIP of this cleanup and runs it when the run completes. Omit when there
     * is no resolver-built forwarding (a handle reattached outside recovery).
     */
    stopToolboxForward?: () => void;
  },
): ActiveRun {
  const { runId, handle } = reattach;
  const emitter = reattach.emitter ?? new CompletableEventTarget<CombinedOperativeEventMap>();

  // #28: the resolver already forwards the toolbox's action events into `emitter`
  // (race-free, from services-build time). Reattach just owns the teardown so the
  // subscription stops when this run completes.
  const toolboxForwardCleanup = reattach.stopToolboxForward;

  // Resolves `true` only when an adapter-initiated `engine.cancel` SUCCEEDS for
  // this run — i.e. THIS abort terminalized the run. `undefined` means no abort
  // was requested. The result-rejection path classifies as `aborted` ONLY when
  // this proves the cancel caused the termination; if cancel rejected (the run was
  // already terminal for a resolver/teardown reason) it stays on the write-free
  // path and does not clobber that owner's status (committee round-3 finding 1).
  let abortCancelled: Promise<boolean> | undefined;

  function complete(): void {
    toolboxForwardCleanup?.();
    emitter.complete();
  }

  function abortOutcome(): Promise<boolean> | undefined {
    return abortCancelled;
  }

  function drive(): Promise<RunResult> {
    return driveReattachedRun(context, runId, handle, emitter, abortOutcome);
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
    abortCancelled ??= context.engine.cancel(runId).then(cancelSucceeded, cancelFailed);
  }

  // Deferred-microtask start — REQUIRED for the registration ordering invariant:
  // the caller (`recoverDurableRuns`) must finish `store.register` +
  // `runSessionIdentifiers.set` in its synchronous turn BEFORE any terminal event
  // microtask fires, so `getRun(runId)` resolves and no subscriber misses the
  // terminal event — even when `handle.result()` already settled before reattach.
  const result = Promise.resolve().then(drive).finally(complete);

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
export async function resumeDurableRunResult(
  context: DurableActiveRunContext,
  runId: string,
): Promise<RunResult> {
  const handle = await context.engine.resume(runId);
  const summary = (await (handle as RecoveredRunHandle).result()) as AgentRunWorkflowResult;
  const { result } = await reconstructRunResult(context, runId, summary);
  return result;
}

/** Options for {@link startDurableRunResult}. */
export interface StartDurableRunResultOptions {
  /** Stable id for the run; also the durable workflow id (suspend/resume key). */
  runId: string;
  /** The owning session id, carried in the durable input for boot recovery. */
  sessionId: string;
  /**
   * The name of the agent running this workflow (F2 — RunRef.agentName).
   * Defaults to `options.agentName ?? ''` when omitted.
   */
  agentName?: string;
  /** The run behavior (generate, toolbox, hooks, stopWhen, …). */
  options: RunOptions;
  /** First user message to seed a brand-new run. */
  prompt?: string;
  /** Abort signal for the run (the scheduler's combined signal). */
  signal?: AbortSignal;
  /**
   * Tags for the durable workflow start (e.g. {@link SCHEDULER_ORIGIN_TAG}). The
   * scheduler stamps its origin tag here so boot recovery can distinguish these
   * runs from session runs and the boot sweep can find suspended residue.
   */
  tags?: string[];
}

/**
 * START a fresh durable run and return a `RunResult` promise that settles when it
 * completes — the HOOKS-FREE, RESULT-ONLY sibling of {@link resumeDurableRunResult}
 * for the scheduler's preemptable durable dispatch.
 *
 * Why this exists instead of `createDurableActiveRun`: that adapter fires the run's
 * `options.hooks` (`onRunStart`/`onRunComplete`) via the run-lifecycle whenever
 * `handle.result()` resolves. But `engine.suspend` does NOT settle that handle —
 * so on a preempt→resume, the ORIGINAL `createDurableActiveRun` driver stays alive
 * and fires `onRunComplete` a SECOND time when the resumed run finally completes,
 * even though the resume dispatch owns task completion (committee/Bugbot:
 * "suspended run duplicates lifecycle hooks"). Driving a preemptable run with this
 * result-only function — symmetric with the resume path — means NEITHER the
 * original nor the resume driver fires run hooks, so they cannot double-fire. The
 * scheduler is the single lifecycle owner for scheduled tasks (its own
 * Task*Events + `task.onComplete` fire exactly once); run-level `options.hooks` do
 * not fire for a preemptable scheduler run, by design.
 *
 * Step-level events still flow: the emitter is passed in `services` so `runStep`
 * (inline mode) dispatches to it, exactly as the fresh `createDurableActiveRun`
 * path does. Failure PROPAGATES (rejects) so a failed run surfaces as a failed
 * task.
 */
export async function startDurableRunResult(
  context: DurableActiveRunContext,
  durableRun: StartDurableRunResultOptions,
): Promise<RunResult> {
  const { runId, sessionId, options, prompt, signal, tags } = durableRun;
  // F2: resolve agentName for durable input — explicit > RunOptions.agentName > ''.
  const agentName = durableRun.agentName ?? options.agentName ?? '';

  // 'start-new' is a DATA-LOSS policy (it purges a prior terminal run under the
  // same id) and must be scoped to runs that legitimately reuse an id — i.e.
  // SCHEDULER-ORIGIN runs, which reuse a synthetic, counter-suffixed id that can
  // collide with a TERMINAL prior run after a crash+restart. For any other
  // durable run a terminal-id collision is a genuine error to surface, NOT to
  // silently overwrite, so we only opt into 'start-new' when the scheduler tag is
  // present. NOTE: 'start-new' covers only TERMINAL conflicts — a `suspended`
  // prior run is not terminal, so id-collision with suspended residue is prevented
  // by the boot sweep (sweepSuspendedSchedulerRuns), not by this policy.
  const isSchedulerOrigin = tags?.includes(SCHEDULER_ORIGIN_TAG) ?? false;

  const handle = await context.engine.start(
    'agentRun',
    { runId, sessionId, agentName, prompt, maximumSteps: options.maximumSteps },
    {
      id: runId,
      ...(tags ? { tags } : {}),
      ...(isSchedulerOrigin ? { onTerminalConflict: 'start-new' as const } : {}),
      services: {
        options: { ...options, signal },
        toolbox: options.toolbox,
        // No emitter: a preemptable scheduler run has no run-level event surface
        // (the scheduler drives Task*Events itself). Step events simply do not
        // fire — `emitter` is optional in DurableRunDeps and runStep accepts
        // `undefined`.
      },
    },
  );
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
    // A `history.maxEvents` circuit-breaker (or a genuine execution-deadline
    // timeout) rejects `handle.result()` with a `WorkflowTimeoutError`. On a
    // RECOVERED run this is an ENGINE-policy terminal that fired AFTER recovery —
    // nothing else owns reconciling it (unlike a pre-replay resolver failure,
    // which the resolver already reconciled to `error`, or an EngineDisposedError
    // teardown). So, symmetric with `driveDurableRun`, classify it as `error` and
    // fire the terminal lifecycle here; otherwise the session is left stuck
    // `running` for a run that is actually terminal (Bugbot #38). `hooks: undefined`
    // per the reattach contract; the conversation comes from the checkpoint.
    if (isWeftErrorLike(error) && error.code === 'WorkflowTimeoutError') {
      const message = await classifyTimeoutMessage(context, runId, error);
      let conversation: Conversation;
      try {
        const snapshot = await context.checkpointStore.loadConversation(runId);
        conversation = snapshot ? Conversation.from(snapshot) : new Conversation();
      } catch {
        conversation = new Conversation();
      }
      return finalizeRunResult({
        finishReason: 'error',
        runState: emptyRunState(),
        conversation,
        hooks: undefined,
        emitter,
        runStartTime,
        errorMessage: message,
      });
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
  agentName: string,
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
      // F2: thread agentName into the durable input so boot recovery can
      // identify which agent ran this workflow without reading the session store.
      agentName,
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
        const reconstructed = await reconstructRunResult(context, runId, {
          runId,
          steps: 0,
          content: '',
          finishReason: 'aborted',
        });
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
        abortReason: signal.aborted ? String(signal.reason) : undefined,
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
      errorMessage: message,
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
 * Build the error message for a `WorkflowTimeoutError`, distinguishing a history
 * circuit-breaker kill from a genuine execution-deadline timeout. The error class
 * itself carries no `terminationReason`, so the distinction comes from the
 * engine's stored {@link WorkflowState}: `'history-circuit-breaker'` means the
 * run's event-log breached `history.maxEvents`. A failed/absent state read falls
 * back to the raw error message rather than guessing.
 */
async function classifyTimeoutMessage(
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
  const schemaValidation = args.schemaValidation
    ? {
        success: args.schemaValidation.success,
        ...(args.schemaValidation.error !== undefined
          ? { error: new Error(args.schemaValidation.error) }
          : {}),
      }
    : undefined;

  return makeCompletedResult(
    runState,
    conversation,
    hooks,
    emitter,
    finishReason === 'stop-condition' ? 'stop-condition' : 'maximum-steps',
    runStartTime,
    schemaValidation,
  );
}
