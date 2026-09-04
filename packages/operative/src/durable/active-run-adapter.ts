import { HISTORY_CIRCUIT_BREAKER_REASON, isWeftErrorLike } from '@lostgradient/weft';
import type { AnyToolbox, ToolboxEventMap } from 'armorer';
import { Conversation, isConversation } from 'conversationalist';
import type { RuntimeServices } from 'lifecycle';
import { CompletableEventTarget, createDefaultRuntimeServices } from 'lifecycle';

import type { ChildRunRegistry } from '../child-run';
import { createClosedAcknowledgement } from '../closed-acknowledgement';
import type { ActiveRun } from '../create-run';
import {
  AbortAgentRunError,
  AgentRunError,
  BudgetExceededError,
  ElicitationDeniedError,
  GuardrailTripwireError,
  MaximumStepsExceededError,
  toAgentRunError,
} from '../errors';
import type { CombinedOperativeEventMap, OperativeEventEmitter } from '../events';
import {
  HumanWaitParkedEvent,
  StepStartedEvent,
  ToolErrorBubbleEvent,
  ToolPolicyDeniedBubbleEvent,
  ToolProgressBubbleEvent,
  ToolSettledBubbleEvent,
  ToolStartedBubbleEvent,
} from '../events';
import type { ActiveRunLiveness, StallWatchdogClock } from '../liveness';
import { createActiveRunLiveness } from '../liveness';
import { createRunState } from '../loop';
import { UnsupportedRunResultVersionError } from '../run-envelope';
import {
  makeAbortResult,
  makeCompletedResult,
  makeErrorResult,
  startRunLifecycle,
} from '../run-lifecycle';
import type { RunState } from '../run-step';
import { createToolboxEventForwarder } from '../toolbox-event-forwarding';
import {
  type CleanupAcknowledgement,
  type FinishReason,
  type RunOptions,
  type RunResult,
  toRedactedRunResultSummary,
} from '../types';
import type { CheckpointStore } from './checkpoint-store';
import type { RegistryAgnosticEngine } from './create-run-engine';
import {
  AGENT_RUN_WORKFLOW_RESULT_SCHEMA_VERSION,
  type AgentRunWorkflowResult,
  normalizeAgentRunWorkflowResult,
} from './run-workflow';
import type { DurableRunDeps } from './types';

/**
 * Tag stamped on every durable run launched by the operative scheduler (via
 * {@link startDurableRunResult}). Weft 0.7 recovery reads it from
 * `WorkflowServicesResolverInfo.launchOptions.tags` to discriminate
 * scheduler-origin runs from genuine session runs — a scheduler run is a
 * live-process concern with no bureau session behind it, so on a crash it is
 * cancelled, never reattached as a session run. Direct handle metadata carries
 * the same tag; the boot sweep still uses the stable id prefix so legacy untagged
 * suspended residue remains cleanupable. Exported through `@lostgradient/operative/durable`
 * (no `@lostgradient/operative/scheduler` subpath export exists) so the gateway recovery path
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

/**
 * Terminal `WorkflowStatus` values (Weft `identity.ts`) — everything that is
 * NOT one of `'pending' | 'running' | 'suspended'`. Used by `closed()`'s
 * post-cancel re-read (AC7 / a code-review finding on the AB-204 pull
 * request): `engine.cancel` resolving is not proof the cancellation record
 * committed, and a re-read that still reports a NONTERMINAL status means
 * the workflow has not actually stopped yet — reporting `completed` there
 * would let a caller proceed while the workflow is still active.
 */
const TERMINAL_WORKFLOW_STATUSES = new Set<string>([
  'completed',
  'failed',
  'cancelled',
  'timed-out',
]);

function isTerminalWorkflowStatus(status: string): boolean {
  return TERMINAL_WORKFLOW_STATUSES.has(status);
}

/** Dependencies the adapter needs from bureau composition. */
export interface DurableActiveRunContext {
  engine: RegistryAgnosticEngine;
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
  /**
   * A pre-built emitter for this run's event surface. When provided, this
   * adapter dispatches to it instead of minting its own — so a caller that
   * built a toolbox tool bound to this SAME emitter (e.g. `requestHumanInput`
   * via `createRequestHumanInputTool({ emitter })`) sees that tool's events
   * (like `HumanWaitParkedEvent`) flow onto the exact emitter this `ActiveRun`
   * exposes via `addEventListener`/`toObservable`. Omit for a fresh internal
   * emitter (the pre-existing default behavior).
   */
  emitter?: OperativeEventEmitter;
  /**
   * Optional synchronous hook invoked with the freshly-built per-run
   * {@link DurableRunDeps} — the exact object Weft hands back as `ctx.services`
   * — immediately BEFORE `engine.start`. This is the only point at which a
   * caller can obtain a live reference to that object: it is minted inside
   * `driveDurableRun`, after the toolbox (and any tools closed over a mutable
   * "context" slot, like `requestHumanInput`'s `pendingHumanWait`) has already
   * been constructed. A caller wanting a tool's mutation of `deps.pendingHumanWait`
   * (or `deps.pendingWakeup`) to actually reach `ctx.services` — the only copy
   * the durable workflow reads — must capture this reference here and point the
   * tool's context at it (see bureau's `createRunFromRequest` for the pattern).
   */
  onServices?: (services: DurableRunDeps) => void;
  /**
   * Test-only clock seam for this run's `LivenessObservable` watchdogs
   * (AB-214/obs-01). Composition-root only — production callers omit this
   * and get the real (`RuntimeServices`-backed) clock.
   */
  livenessClock?: StallWatchdogClock;
  /** See `CreateActiveRunDependencies.owner` (`create-run.ts`) — threaded through unchanged for a durable run. */
  livenessOwner?: string;
}

/**
 * Rebuild a {@link RunState} (accumulated usage + step records) and its
 * {@link Conversation} from the durable checkpoint — the shared core of
 * {@link reconstructRunResult}. Factored out so every fallback path that fires
 * a terminal lifecycle event from a checkpoint (a normal completion, an
 * adapter-initiated abort that raced a rejecting `handle.result()`, or a
 * `WorkflowTimeoutError`) carries the SAME accumulated `usage` a live run
 * would — not a zeroed {@link createRunState}, which would under-report usage
 * for a recovered run that had already checkpointed steps before it settled.
 * At RUNTIME `checkpoint.cursor.totalUsage` is the exact object `run-step.ts`'s
 * accumulator writes (including AB-92's `cacheCreationTokens`/`cacheReadTokens`
 * when a step reports them — `saveCursor` JSON-serializes it verbatim, no
 * stripping), even though `types.ts`'s `RunCursor.totalUsage` is typed
 * narrower than `TokenUsage` and doesn't say so (a tracked type-hygiene gap,
 * not a runtime data loss). On a checkpoint read failure (e.g. no checkpoint
 * was ever written), falls back to an empty run state + conversation —
 * callers already tolerate that shape from `createRunState()`/`new
 * Conversation()`.
 */
async function loadRunStateFromCheckpoint(
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
async function reconstructRunResult(
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
  errorMessage?: string;
  abortReason?: string;
  schemaValidation?: { success: boolean; error?: string };
  tripwire?: AgentRunWorkflowResult['tripwire'];
}

function reconstructTerminalRunError(
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
    const kind = args.schemaValidation?.success === false ? 'output' : 'generate';
    const code = args.schemaValidation?.success === false ? 'INVALID_OUTPUT' : 'UNKNOWN';
    return new AgentRunError(message, { kind, code });
  }
  return undefined;
}

function reconstructSchemaValidation(
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
/**
 * AB-336 — wires a `requestHumanInput` park into `liveness`'s declared-wait
 * dimension: the durable park mechanism itself was already correct
 * (AB-44/AB-45's loop-break and `ctx.waitForSignal`), but nothing moved
 * `LivenessSnapshot.status` off `'running'` for it, leaving
 * `deriveAssessment`'s `'waiting'` branch unreachable. Shared by
 * `createDurableActiveRun` and {@link reattachDurableActiveRun}'s
 * {@link createRecoveredRunEventSurface} (per the repository's No Duplicated
 * Code rule) — both construct their own `ActiveRunLiveness` over their own
 * emitter, and both need the identical pairing: `HumanWaitParkedEvent` opens
 * the wait, and the run's OWN next `StepStartedEvent` — exactly the AB-44
 * continuation the workflow promises once the signal is delivered — closes
 * it. `endWait()` no-ops when no wait is active, so listening on every step
 * start (not only a resumed one) is safe. Returns the matching cleanup.
 */
function wireHumanWaitLiveness(
  emitter: OperativeEventEmitter,
  liveness: ActiveRunLiveness,
): () => void {
  const onHumanWaitParked = (event: HumanWaitParkedEvent) => {
    liveness.beginWait({
      reason: 'signal',
      dependency: event.signalName,
      wakeCondition: `signal:${event.signalName}`,
    });
  };
  const onStepStartedEndWait = () => liveness.endWait();
  emitter.addEventListener(HumanWaitParkedEvent.type, onHumanWaitParked);
  emitter.addEventListener(StepStartedEvent.type, onStepStartedEndWait);
  return () => {
    emitter.removeEventListener(HumanWaitParkedEvent.type, onHumanWaitParked);
    emitter.removeEventListener(StepStartedEvent.type, onStepStartedEndWait);
  };
}

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
  // TODO(weft-integration): #10 (in-process streaming progress).
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
  const isOwnEvent = (event: { ownerId?: string }): boolean => event.ownerId === runId;
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
  const toolboxForwarder = (() => {
    let currentStep = 0;

    const stepListener = (e: StepStartedEvent) => {
      currentStep = e.step;
    };
    emitter.addEventListener(StepStartedEvent.type, stepListener);
    cleanups.push(() => emitter.removeEventListener(StepStartedEvent.type, stepListener));

    const onExecuteStart = (e: ToolboxEventMap['execute-start']) => {
      // AB-290: only this run's own events — see `isOwnEvent` above and
      // the identical guard in `create-run.ts`'s `onExecuteStart`.
      if (!isOwnEvent(e)) return;
      inFlightTools += 1;
      // AB-214 review (PRRT_kwDORvupsc6esZRy): the tool-call watchdog exists
      // only while a tool call is actually in flight — see the identical
      // reasoning in `create-run.ts`.
      liveness.beginToolCall();
      emitter.dispatchEvent(
        new ToolStartedBubbleEvent(
          { agentName, runId, step: currentStep },
          {
            toolName: e.call.name,
            toolCallId: e.call.id,
            params: e.params,
            startedAt: runtime.clock.now(),
          },
        ),
      );
    };

    const onSettled = (e: ToolboxEventMap['settled']) => {
      // AB-290: mirrors the `onExecuteStart` guard above.
      if (!isOwnEvent(e)) return;
      // Same reasoning as the identical call in create-run.ts's `onSettled`:
      // the tool-call watchdog tracks whether the run is still waiting on
      // this call, not whether the callback has physically returned, so
      // ending it here (when the cancellation race settles) rather than
      // waiting on a possibly-never-resolving abort-ignoring callback is
      // correct.
      liveness.endToolCall();
      // AB-289: armorer's `settled` event fires as soon as the
      // cancellation race against the execution signal settles, not once
      // the tool callback's own returned promise has genuinely settled —
      // see the identical deferral and reasoning in `create-run.ts`'s
      // `onSettled`. Deferring this decrement matters here for
      // `hasInFlightWork()`'s `not-required` fast-path gate below: without
      // it, that gate could read zero in-flight work while a local
      // abort-ignoring callback is still actually running, even though the
      // durable cancellation record this run's own `completed`
      // classification depends on (`resolveDurableOutcome`) is unaffected
      // by local tool tracking. A `settled` event with no
      // `callbackCompletion` (e.g. a hand-constructed test event) drains
      // synchronously, right here, matching the pre-AB-289 behavior exactly
      // rather than deferring by a spurious microtask.
      const release = () => {
        // Clamped: same reasoning as the identical counter in
        // create-run.ts — armorer can emit 'settled' with no preceding
        // 'execute-start' for a tool call cancelled before execution
        // begins.
        inFlightTools = Math.max(0, inFlightTools - 1);
      };
      if (e.callbackCompletion) {
        void e.callbackCompletion.then(release, release);
      } else {
        release();
      }
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
      // AB-290: mirrors the `onExecuteStart` guard above.
      if (!isOwnEvent(e)) return;
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
      liveness.recordToolProgressPulse({
        toolCallId: e.call.id,
        toolName: e.call.name,
        percent: e.percent,
        message: e.message,
      });
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

    // Attach the curated listeners onto one toolbox instance (the base
    // toolbox, or a `selectTools`-swapped step toolbox — AB-294) and return a
    // function that detaches them again. Guards against mock/custom toolboxes
    // that omit `addEventListener`. Not bound to `abortController.signal` —
    // `toolboxForwarder.stop()` (via the `cleanups` entry below, which runs
    // on every termination path once `result` settles via `.finally(complete)`)
    // is the single removal path, so the same subscription lifecycle applies
    // whether the toolbox is the base instance or a swapped step toolbox.
    const attachToolboxCuratedListeners = (toolboxInstance: AnyToolbox): (() => void) => {
      const toolboxWithListener = toolboxInstance as unknown as {
        addEventListener?: <K extends keyof ToolboxEventMap>(
          type: K,
          listener: (e: ToolboxEventMap[K]) => void,
          options?: AddEventListenerOptions,
        ) => () => void;
      };
      if (!toolboxWithListener.addEventListener) return () => {};
      const addListener = toolboxWithListener.addEventListener.bind(toolboxWithListener);
      const toolboxCleanups = [
        addListener('execute-start', onExecuteStart),
        addListener('settled', onSettled),
        addListener('progress', onToolProgress),
        addListener('policy-denied', onPolicyDenied),
      ];
      return () => {
        for (const cleanup of toolboxCleanups) cleanup?.();
      };
    };

    // AB-239: the base subscription covers the whole run; `toolboxForwarder.onStepToolbox`
    // (threaded through `driveDurableRun` into `services.onStepToolbox`, then into
    // per-step `StepDeps` by `run-workflow.ts`) additionally covers any step whose
    // `selectTools` hook swaps in a different toolbox for that step — including,
    // since AB-294, the curated listeners defined above.
    return createToolboxEventForwarder(options.toolbox, emitter, attachToolboxCuratedListeners);
  })();
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

  // closed()'s AC7 (AB-204): a durable `completed` acknowledgement is
  // withheld until the post-cancel re-read of `getDurableRun` observes the
  // committed transition, never merely because `engine.cancel` resolved
  // without rejecting. `cancelRequested` records that a cancellation was
  // asked for at all; `cancelSettled` — when abort() itself already fired
  // `engine.cancel` — lets `closed()` reuse that same call instead of racing
  // a second one.
  let cancelRequested = false;
  let cancelSettled: Promise<void> | undefined;
  // AB-291 (AC3): a workflow parked in `ctx.sleep`/`ctx.waitForSignal` can
  // ONLY be unblocked by a resolving `engine.cancel()` call — if that call
  // itself rejects, the workflow never advances, so `result` (the public,
  // unmodified run-completion promise) never settles either, and `closed()`
  // — gated on `result` — would hang forever, unable to unblock on a
  // workflow that can't unblock itself. `cancelRejectionGate` only ever
  // REJECTS (never resolves) with that `engine.cancel` failure; raced below
  // against `result` for `closed()`'s OWN gate (`closedGate`) so a genuine
  // cancel failure surfaces `{ status: 'failed', error }` instead of a
  // silent, permanent hang. Matches AB-205's `cancelDurableRun` precedent: a
  // rejecting `engine.cancel()` classifies `failed` with the caught error,
  // never swallowed.
  let rejectCancelGate: ((error: unknown) => void) | undefined;
  const cancelRejectionGate = new Promise<never>((_resolve, reject) => {
    rejectCancelGate = reject;
  });

  function abort(reason?: string): void {
    cancelRequested = true;
    liveness.setStatus('aborting');
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
      // Kept on `cancelSettled` too, so closed()'s post-cancel re-read awaits
      // THIS call rather than firing a redundant one. `??=`, not `=`: a
      // second abort() (e.g. an explicit abort() followed by dispose())
      // must not overwrite an already-in-flight (or already-settled) first
      // cancellation with a fresh, possibly slower or non-settling, one —
      // closed() would otherwise wait on the wrong promise.
      cancelSettled ??= context.engine.cancel(runId).catch(async (error: unknown) => {
        // Swallowed for THIS promise unconditionally: a failing cancel (run
        // already terminal, or racing the in-flight step's own
        // AbortController-driven completion — see "still settles when
        // engine.cancel rejects during durable abort cleanup" below) is not
        // an error for `cancelSettled`'s own callers — the AbortController
        // signal is the load-bearing stop, and the post-cancel re-read
        // still disambiguates a genuine no-op from a real problem.
        //
        // AC3 is specifically about a workflow PARKED in `ctx.sleep`/
        // `ctx.waitForSignal` that a rejecting `engine.cancel()` fails to
        // unblock — not every cancel rejection. A cancel can also
        // legitimately reject against a workflow that's already terminal,
        // or mid-step and about to settle cleanly via its own
        // AbortController-driven abort path; tripping `cancelRejectionGate`
        // for THOSE would misclassify a clean cleanup as `failed` (review
        // finding on this pull request). Only trip it when the durable
        // engine's own record confirms the workflow is genuinely
        // `suspended` at the moment of the failure — the one state a
        // rejecting cancel truly cannot unblock on its own.
        try {
          const state = await context.engine.get(runId);
          if (state?.status === 'suspended') {
            rejectCancelGate?.(error);
          }
        } catch {
          // The engine read itself failed — nothing more can be determined
          // here; `result` settles (or doesn't) on its own, same as every
          // other case this catch already swallows.
        }
      });
    }
  }

  // A cancellation delivered through `RunOptions.signal` alone (never
  // calling this ActiveRun's own `abort()`) must still route through
  // `abort()` — and do so THE MOMENT the signal fires, not merely be
  // observed later by `resolveDurableOutcome`'s fallback. That fallback
  // only runs after `result` has settled, but a workflow parked in
  // `ctx.sleep`/`ctx.waitForSignal` cannot advance on the in-process signal
  // alone — only `engine.cancel()` can unblock it. Deferring to the
  // fallback would deadlock closed() (and `result`) forever. Firing here,
  // synchronously the same tick the signal fires, is what actually
  // terminates the parked workflow.
  if (combinedSignal.aborted) {
    abort(typeof combinedSignal.reason === 'string' ? combinedSignal.reason : undefined);
  } else {
    const onCombinedSignalAbort = (): void =>
      abort(typeof combinedSignal.reason === 'string' ? combinedSignal.reason : undefined);
    combinedSignal.addEventListener('abort', onCombinedSignalAbort, { once: true });
    // AB-291 (AC2, matching create-run.ts's identical fix, AB-204 review
    // PRRT_kwDORvupsc6erGS9): `options.signal` can be a long-lived signal a
    // caller reuses across many runs. Left attached, this listener fires
    // `abort()` — and issues a redundant `engine.cancel()` — on THIS
    // already-terminal run whenever that shared signal later aborts for an
    // unrelated reason. Detach once `result` settles; while the run is
    // still in flight the listener stays live exactly as before.
    cleanups.push(() => combinedSignal.removeEventListener('abort', onCombinedSignalAbort));
  }

  async function resolveDurableOutcome(): Promise<CleanupAcknowledgement> {
    if (reachability.unreachable) return { status: 'unresolved', reason: 'unreachable' };
    // `cancelRequested` alone misses a cancellation delivered through
    // `RunOptions.signal` with `abort()` never called — the same gap the
    // not-required disqualifier above closes, but here it matters more: a
    // signal-only cancellation never fired `engine.cancel` (only `abort()`
    // does that), so skipping straight to `completed` would report a
    // successful durable acknowledgement for a cancellation that was never
    // recorded or confirmed. `cancelSettled ?? context.engine.cancel(...)`
    // below already handles firing that first call when nothing else has.
    if (!cancelRequested && !combinedSignal.aborted) {
      // AB-291 (AC1): a run-owned hook can still be running when `result`
      // settles — `runHookSilently` is fire-and-forget — so `completed`
      // must wait for genuine hook completion, matching `create-run.ts`'s
      // identical `Promise.allSettled(pendingHookPromises)` await.
      // AB-304: and, matching `create-run.ts`'s identical AB-211 fold-in, a
      // registered child's own `closed()` must also settle — not merely its
      // `result()` — before this durable parent reports `completed`.
      await Promise.all([
        Promise.allSettled(pendingHookPromises),
        childRegistry?.awaitChildrenClosed() ?? Promise.resolve(),
      ]);
      return { status: 'completed' };
    }
    // AB-339: `driveDurableRun` saw `signal.aborted` before ever calling
    // `context.engine.start` — no durable workflow was launched at all, so
    // there is no record for `engine.cancel`/`engine.get` to confirm (a
    // `cancel` against an unknown id, or a `get` returning `null`, would
    // otherwise misclassify this `unresolved`/`persistence-failed`). The
    // cancellation IS acknowledged: cleanup consisted of never starting.
    if (neverLaunched.value) {
      await Promise.all([
        Promise.allSettled(pendingHookPromises),
        childRegistry?.awaitChildrenClosed() ?? Promise.resolve(),
      ]);
      return { status: 'completed' };
    }
    // `cancelSettled` is always set by this point. `neverLaunched` above
    // has already returned for the one case that used to leave it unset —
    // `abort()` (direct or signal-triggered) firing before `driveStarted`
    // flipped true, when the workflow did not exist yet and `abort()`'s own
    // `if (driveStarted)` guard skipped `engine.cancel()`. Every other way
    // to reach this line — `cancelRequested` or `combinedSignal.aborted`
    // becoming true — only happens through that same `abort()` function
    // (there is no other writer), and by the time `result` has settled
    // `driveDurableRun` has certainly already reached the deferred
    // microtask, so `driveStarted` was already true when `abort()` ran and
    // its `cancelSettled ??= context.engine.cancel(...)` assignment above
    // already fired.
    await cancelSettled;
    try {
      const state = await context.engine.get(runId);
      // `engine.cancel` resolving void is not proof the cancellation record
      // committed (it is also a documented no-op against an already-terminal
      // workflow) — only a re-read can disambiguate. `state.status ===
      // 'cancelled'` is this closed()'s cancellation, any OTHER TERMINAL
      // status means the workflow settled on its own before the cancel
      // could apply; either way the durable record exists and cleanup is
      // complete. A NONTERMINAL status (pending/running/suspended) means
      // the cancellation has not actually taken effect yet — reporting
      // `completed` there would let a caller proceed while the workflow is
      // still active, so this stays `unresolved`/`persistence-failed`
      // instead (the durable write could not yet be confirmed).
      if (!state || !isTerminalWorkflowStatus(state.status)) {
        return { status: 'unresolved', reason: 'persistence-failed' };
      }
      // AB-291 (AC1): same hook-completion wait as the uncancelled branch
      // above — a cancelled run's `onRunAbort`/`onRunError` hook can still
      // be in flight even after the durable record confirms `cancelled`.
      // AB-304: same children-closed fold-in as the uncancelled branch too.
      await Promise.all([
        Promise.allSettled(pendingHookPromises),
        childRegistry?.awaitChildrenClosed() ?? Promise.resolve(),
      ]);
      return { status: 'completed' };
    } catch (error) {
      return { status: 'unresolved', reason: 'persistence-failed', error };
    }
  }

  // AB-291 (AC3): `closed()`'s own gate — races the run's real completion
  // against `cancelRejectionGate` so a rejecting `engine.cancel()` against a
  // genuinely parked workflow surfaces `{ status: 'failed', error }` instead
  // of leaving `closed()` waiting on a `result` that will never settle. When
  // `result` settles first (the ordinary case, including a harmless cancel
  // rejection against an already-terminal run whose `result` was already on
  // its way to settling), this behaves exactly as passing `result` directly
  // would have.
  const closedGate = Promise.race([result, cancelRejectionGate]);

  const closed = createClosedAcknowledgement({
    result: closedGate,
    // `cancelRequested` alone misses a cancellation that arrived through
    // `RunOptions.signal` rather than a direct `abort()` call —
    // `combinedSignal` covers both, matching create-run.ts's identical fix.
    disqualifiesFastPath: () =>
      cancelRequested || combinedSignal.aborted || reachability.unreachable,
    // AB-304: a registered child disqualifies the `not-required` fast path
    // the same way an in-flight tool does — its own `closed()` can still be
    // pending even once its `result()` has resolved — matching
    // `create-run.ts`'s identical `hasInFlightWork` extension for AB-211.
    hasInFlightWork: () => inFlightTools > 0 || (childRegistry?.children().length ?? 0) > 0,
    resolveOutcome: resolveDurableOutcome,
  });

  return {
    result,
    abort,
    closed,
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
      abort();
      complete();
    },
  };
}

/**
 * The minimal recovered-handle surface {@link reattachDurableActiveRun} needs: a
 * pinned id (== runId) and the settling `result()`. `engine.recoverAll()` returns
 * full `WorkflowHandle`s; this narrow shape avoids depending on Weft's invariant
 * `WorkflowHandle` generics (matching the `RegistryAgnosticEngine` widening convention).
 */
export interface RecoveredRunHandle {
  readonly id: string;
  result(): Promise<unknown>;
}

export interface RecoveredRunEventSurface {
  emitter: OperativeEventEmitter;
  abort: (reason?: string) => void;
  stopToolboxForward: () => void;
}

/**
 * Build the live event surface for a recovered run during Weft's
 * `onRecoveredWorkflow` hook, before the recovered generator advances.
 */
export function createRecoveredRunEventSurface(
  services: DurableRunDeps,
  runId: string,
  agentName: string,
): RecoveredRunEventSurface {
  // AB-92/AB-252/AB-253: resolved exactly once, here — omitted, falls back
  // to the real globals, matching `createDurableActiveRun`'s own default.
  const runtime = services.options.runtime ?? createDefaultRuntimeServices();
  const emitter = new CompletableEventTarget<CombinedOperativeEventMap>();
  const abortController = new AbortController();
  services.options = {
    ...services.options,
    signal: services.options.signal
      ? AbortSignal.any([services.options.signal, abortController.signal])
      : abortController.signal,
  };
  services.emitter = emitter;
  const cleanups: Array<(() => void) | undefined> = [];

  let currentStep = 0;
  const stepListener = (event: StepStartedEvent) => {
    currentStep = event.step;
  };
  emitter.addEventListener(StepStartedEvent.type, stepListener);
  cleanups.push(() => emitter.removeEventListener(StepStartedEvent.type, stepListener));

  // AB-294: the curated tool.* bubble listeners move onto the same per-step
  // subscription `toolboxForwarder` uses for the low-level `toolbox.*`
  // forward (AB-239) — `attachToolboxCuratedListeners` below is passed to
  // `createToolboxEventForwarder` as its `attachCurated` argument.
  //
  // AB-290: mirrors `createDurableActiveRun`'s identically-named helper —
  // see its comment.
  const isOwnEvent = (event: { ownerId?: string }): boolean => event.ownerId === runId;
  const attachToolboxCuratedListeners = (toolboxInstance: AnyToolbox): (() => void) => {
    const toolboxWithListener = toolboxInstance as unknown as {
      addEventListener?: <K extends keyof ToolboxEventMap>(
        type: K,
        listener: (event: ToolboxEventMap[K]) => void,
        options?: AddEventListenerOptions,
      ) => () => void;
    };
    if (!toolboxWithListener.addEventListener) return () => {};
    const addListener = toolboxWithListener.addEventListener.bind(toolboxWithListener);
    const toolboxCleanups = [
      addListener('execute-start', (event) => {
        if (!isOwnEvent(event)) return;
        emitter.dispatchEvent(
          new ToolStartedBubbleEvent(
            { agentName, runId, step: currentStep },
            {
              toolName: event.call.name,
              toolCallId: event.call.id,
              params: event.params,
              startedAt: runtime.clock.now(),
            },
          ),
        );
      }),
      addListener('settled', (event) => {
        if (!isOwnEvent(event)) return;
        const hasError = event.error !== undefined;
        emitter.dispatchEvent(
          new ToolSettledBubbleEvent(
            { agentName, runId, step: currentStep },
            {
              toolName: event.call.name,
              toolCallId: event.call.id,
              status: hasError ? 'error' : 'success',
              result: event.result,
              error: event.error,
            },
          ),
        );
        if (hasError) {
          emitter.dispatchEvent(
            new ToolErrorBubbleEvent(
              { agentName, runId, step: currentStep },
              {
                toolName: event.call.name,
                toolCallId: event.call.id,
                error: event.error,
              },
            ),
          );
        }
      }),
      addListener('progress', (event) => {
        if (!isOwnEvent(event)) return;
        emitter.dispatchEvent(
          new ToolProgressBubbleEvent(
            { agentName, runId, step: currentStep },
            {
              toolName: event.call.name,
              toolCallId: event.call.id,
              percent: event.percent,
              message: event.message,
            },
          ),
        );
      }),
      addListener('policy-denied', (event) => {
        emitter.dispatchEvent(
          new ToolPolicyDeniedBubbleEvent(
            { agentName, runId, step: currentStep },
            {
              toolName: event.call.name,
              toolCallId: event.call.id,
              reason: event.reason,
            },
          ),
        );
      }),
    ];
    return () => {
      for (const cleanup of toolboxCleanups) cleanup?.();
    };
  };

  // AB-239: same base-plus-per-step forwarding as the fresh-start path
  // (`createDurableActiveRun` → `driveDurableRun`), wired directly onto the
  // recovered `services` object rather than threaded through a `drive()` call —
  // the recovered generator reads `services.onStepToolbox` via `ctx.services`
  // on its very next step. Chains any `onStepToolbox` the resolver already
  // installed on `services` rather than clobbering it, so this forwarder can
  // never silently drop another caller's per-step toolbox instrumentation.
  // Since AB-294, `attachToolboxCuratedListeners` above rides the same
  // base-plus-swap bracket as the low-level `toolbox.*` forward.
  const priorOnStepToolbox = services.onStepToolbox;
  const toolboxForwarder = createToolboxEventForwarder(
    services.toolbox,
    emitter,
    attachToolboxCuratedListeners,
  );
  services.onStepToolbox = (toolbox) => {
    priorOnStepToolbox?.(toolbox);
    toolboxForwarder.onStepToolbox(toolbox);
  };
  cleanups.push(() => toolboxForwarder.stop());

  return {
    emitter,
    stopToolboxForward: () => {
      for (const cleanup of cleanups) cleanup?.();
    },
    abort: (reason?: string) => abortController.abort(reason),
  };
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
 * Contract (deliberately narrower than a fresh run):
 * - `run.completed` / `run.aborted` / `run.error` fire when the recovered run
 *   settles. When the caller supplies the event surface installed by Weft's
 *   pre-resume hook, per-step and toolbox events use that same surface too.
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
export async function resumeDurableRunResult(
  context: DurableActiveRunContext,
  runId: string,
  // AB-321: optional — a caller that already resolved a `RuntimeServices`
  // (e.g. the scheduler's own composed instance) forwards it here so a
  // reconstructed fallback conversation reads through the SAME runtime
  // rather than a fresh default; omitting it preserves prior behavior.
  runtime: RuntimeServices = createDefaultRuntimeServices(),
): Promise<RunResult> {
  const handle = await context.engine.resume(runId);
  const summary = normalizeAgentRunWorkflowResult(await (handle as RecoveredRunHandle).result());
  const { result } = await reconstructRunResult(context, runId, summary, runtime);
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
  // AB-321: resolved exactly once here, matching every other durable entry
  // point's own `options.runtime ?? createDefaultRuntimeServices()`.
  const runtime = options.runtime ?? createDefaultRuntimeServices();

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
        // AB-321: snapshots the SAME resolved `runtime` this function reads
        // for `reconstructRunResult` below, so the workflow-side run and this
        // reconstruction agree on one runtime instance rather than each
        // independently defaulting to its own.
        options: { ...options, signal, runtime },
        toolbox: options.toolbox,
        // No emitter: a preemptable scheduler run has no run-level event surface
        // (the scheduler drives Task*Events itself). Step events simply do not
        // fire — `emitter` is optional in DurableRunDeps and runStep accepts
        // `undefined`.
      },
    },
  );
  const summary = normalizeAgentRunWorkflowResult(await (handle as RecoveredRunHandle).result());
  const { result } = await reconstructRunResult(context, runId, summary, runtime);
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
  emitter: OperativeEventEmitter,
  abortOutcome: () => Promise<boolean> | undefined,
  reachability: { unreachable: boolean },
  runtime: RuntimeServices,
): Promise<RunResult> {
  const runStartTime = runtime.monotonic.now();

  let summary: AgentRunWorkflowResult;
  try {
    summary = normalizeAgentRunWorkflowResult(await handle.result());
  } catch (error) {
    if (error instanceof UnsupportedRunResultVersionError) {
      throw error;
    }
    // An ADAPTER-INITIATED abort (bureau.abortRun → engine.cancel) that ACTUALLY
    // terminalized this run is a real terminal: fire `run.aborted` so the gateway
    // listener persists `aborted`, rather than leaving the session looking
    // `running` (committee round-2 finding 2). Classify as aborted ONLY when the
    // cancel succeeded (committee round-3 finding 1): if the cancel rejected, this
    // rejection came from a resolver/teardown failure that merely raced abort(),
    // and that owner's status must not be clobbered.
    const cancelSucceeded = await (abortOutcome() ?? Promise.resolve(false));
    if (cancelSucceeded) {
      // Reconstruct the checkpointed usage + steps (not a zeroed
      // `createRunState()`), so an abort that raced a run with prior checkpointed
      // steps reports the SAME accumulated usage the eventual terminal
      // `RunResult` would have — `loadRunStateFromCheckpoint` already tolerates a
      // failed/absent checkpoint by falling back to an empty run state +
      // conversation, satisfying the "must NOT suppress the abort lifecycle"
      // requirement (committee round-3 finding 2).
      const { runState, conversation } = await loadRunStateFromCheckpoint(context, runId, runtime);
      const lastStep = runState.steps[runState.steps.length - 1];
      return makeAbortResult(
        runState,
        conversation,
        undefined,
        emitter,
        lastStep ? lastStep.step + 1 : 0,
        'aborted',
        undefined,
        reconstructTerminalRunError({
          finishReason: 'aborted',
          steps: runState.steps.length,
          abortReason: 'aborted',
        }),
      );
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
      // Same checkpointed-usage reconstruction as the abort branch above — a
      // circuit-breaker/deadline timeout after prior checkpointed steps must not
      // under-report the run's accumulated usage.
      const { runState, conversation } = await loadRunStateFromCheckpoint(context, runId, runtime);
      return finalizeRunResult({
        finishReason: 'error',
        runState,
        conversation,
        hooks: undefined,
        emitter,
        runStartTime,
        runtime,
        errorMessage: message,
      });
    }
    // Otherwise write-free. EngineDisposedError = bureau teardown mid-resume
    // (leave running for a later boot). Any other rejection = the engine
    // terminally failed this run pre-replay because the resolver returned
    // services-unavailable, and the resolver ALREADY reconciled that session to
    // `error`. Firing a terminal lifecycle here would clobber what the
    // resolver/teardown owns, so we only log and resolve quiet.
    if (isWeftErrorLike(error) && error.code === 'EngineDisposedError') {
      // AB-204 AC8: closed() classifies this as unresolved/unreachable,
      // never failed — see `reachability`'s doc comment above.
      reachability.unreachable = true;
    } else {
      console.error(
        `[operative] Reattached durable run "${runId}" did not settle cleanly: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return makeInterruptedRunResult(new Conversation(undefined, { runtime }));
  }

  const {
    result,
    runState,
    conversation: durableConversation,
  } = await reconstructRunResult(context, runId, summary, runtime);

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
    runtime,
    errorMessage: summary.errorMessage,
    abortReason: summary.abortReason,
    schemaValidation: summary.schemaValidation,
    output: summary.output,
    tripwire: summary.tripwire,
    terminalError: result.error instanceof AgentRunError ? result.error : undefined,
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
  const startError = await startRunLifecycle(options, conversation, emitter);
  if (startError !== undefined) {
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
    options: { ...options, signal },
    toolbox: options.toolbox,
    emitter,
    onStepToolbox,
  };
  // Give the caller a live reference to the EXACT object Weft will hand back as
  // `ctx.services` — see `DurableActiveRunOptions.onServices`. Must fire before
  // `engine.start` so a tool the caller wired against this reference (e.g.
  // `requestHumanInput`) can mutate it the moment `runStep` executes.
  onServices?.(services);

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
      services,
    },
  );

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
  errorMessage?: string;
  /** The exact terminal error object captured from the live run event, when available. */
  terminalError?: AgentRunError;
  /** The abort reason (when the durable run was aborted). */
  abortReason?: string;
  /**
   * The structured-output validation outcome carried out of the workflow, so a
   * completed durable run's `RunResult.schemaValidation` matches the in-memory
   * loop. Its serialized error message is rebuilt into an `Error` for parity.
   */
  schemaValidation?: { success: boolean; error?: string };
  /**
   * The `output`-validated structured output carried out of the
   * workflow, mirroring `RunResult.output` on the in-memory path.
   * Unlike `schemaValidation.error`, this crosses the checkpoint as plain
   * (already-JSON) data, so no reconstruction is needed here.
   */
  output?: unknown;
  /** Forwarded from `RunOptions.costEstimation` so a durable run's terminal
   * `RunResult.costEstimate` matches the in-memory loop's. */
  costEstimation?: RunOptions['costEstimation'];
  /**
   * The tripped guardrail's identity, carried out of the workflow summary when
   * `finishReason` is `'tripwire'`. Used to rebuild the same `GuardrailTripwireError`
   * subclass the workflow classified, so `makeErrorResult`'s `instanceof` check
   * lands on `finishReason: 'tripwire'` again and `RunTripwireEvent` fires.
   */
  tripwire?: {
    guardrailName: string;
    category: string;
    phase: 'input' | 'output';
    confidence: number;
    detail?: string;
  };
  /**
   * AB-291 (AC1): collects every run-owned hook's fire-and-forget promise so
   * `createDurableActiveRun`'s `resolveDurableOutcome` can await genuine hook
   * completion before reporting `closed()` `completed` — the durable
   * counterpart of `create-run.ts`'s `pendingHookPromises`. Omitted by
   * `driveReattachedRun`'s call sites (`hooks: undefined` there — reattach
   * never fires run hooks, so nothing to track).
   */
  hookTracker?: (promise: Promise<unknown>) => void;
}

/**
 * Map a durable run's `finishReason` to the matching run-lifecycle terminal, so
 * `RunCompleted`/`Aborted`/`Error` and the run hooks fire identically to the
 * in-memory loop — carrying the real abort reason and error message out of the
 * workflow summary, not a synthetic placeholder.
 */
function finalizeRunResult(args: FinalizeArgs): RunResult {
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
