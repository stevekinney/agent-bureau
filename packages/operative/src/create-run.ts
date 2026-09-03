import type { AnyToolbox, ToolboxEventMap } from 'armorer';
import { Conversation, isConversation } from 'conversationalist';
import type { ObservableLike, Observer, Subscription } from 'lifecycle';
import { CompletableEventTarget, createDefaultRuntimeServices, forwardEvents } from 'lifecycle';

import { createClosedAcknowledgement } from './closed-acknowledgement';
import type { DurableActiveRunContext } from './durable/active-run-adapter';
import { createDurableActiveRun } from './durable/active-run-adapter';
import type { DurableRunDeps } from './durable/types';
import type {
  CombinedOperativeEventMap,
  CombinedOperativeEventType,
  OperativeEventEmitter,
} from './events';
import {
  StepStartedEvent,
  ToolErrorBubbleEvent,
  ToolPolicyDeniedBubbleEvent,
  ToolProgressBubbleEvent,
  ToolSettledBubbleEvent,
  ToolStartedBubbleEvent,
} from './events';
import type { AgentRunLivenessSnapshot, RunIdentifierSeam, StallWatchdogClock } from './liveness';
import { createActiveRunLiveness } from './liveness';
import { executeLoop } from './loop';
import { toOutputJsonSchema } from './structured-output/response-schema';
import { createToolboxEventForwarder } from './toolbox-event-forwarding';
import {
  type CleanupAcknowledgement,
  type ClosedOptions,
  type RunOptions,
  type RunResult,
  toRedactedRunResultSummary,
} from './types';

/**
 * The internal event-emitting agent loop run. This is the low-level engine
 * that owns the event emitter and the result Promise. External callers
 * consume the higher-level `AgentRun` wrapper (from `agent-run.ts`), which
 * adds async-iteration and enforces the non-thenable contract. Internal
 * modules (durable, store, instrumentation, scheduler) work directly with
 * `ActiveRun` because they need the full event surface.
 */
export interface ActiveRun {
  result: Promise<RunResult>;
  abort: (reason?: string) => void;
  /**
   * A truthful cleanup acknowledgement (AB-37 / AB-204), backed by the same
   * settlement `abort()` already uses. Never rejects; idempotent after
   * genuine settlement — see `closed-acknowledgement.ts` for the full
   * contract.
   */
  closed: (options?: ClosedOptions) => Promise<CleanupAcknowledgement>;
  addEventListener: <K extends CombinedOperativeEventType>(
    type: K,
    listener: (event: CombinedOperativeEventMap[K]) => void,
    options?: boolean | AddEventListenerOptions,
  ) => void;
  removeEventListener: <K extends CombinedOperativeEventType>(
    type: K,
    listener: (event: CombinedOperativeEventMap[K]) => void,
    options?: boolean | EventListenerOptions,
  ) => void;
  on: <K extends CombinedOperativeEventType>(
    type: K,
  ) => ObservableLike<CombinedOperativeEventMap[K]>;
  once: <K extends CombinedOperativeEventType>(
    type: K,
    listener: (event: CombinedOperativeEventMap[K]) => void,
  ) => void;
  subscribe: <K extends CombinedOperativeEventType>(
    type: K,
    observerOrNext?:
      Observer<CombinedOperativeEventMap[K]> | ((value: CombinedOperativeEventMap[K]) => void),
    error?: (err: unknown) => void,
    complete?: () => void,
  ) => Subscription;
  events: <K extends CombinedOperativeEventType>(
    type: K,
    options?: { signal?: AbortSignal; bufferSize?: number },
  ) => AsyncIterableIterator<CombinedOperativeEventMap[K]>;
  toObservable: () => ObservableLike<CombinedOperativeEventMap[CombinedOperativeEventType]>;
  complete: () => void;
  /**
   * Synchronous, never starts work, never blocks, never mutates
   * (AB-88's `LivenessObservable`, implemented by AB-214/obs-01).
   */
  snapshot: () => AgentRunLivenessSnapshot;
  /**
   * Independent, non-consuming observer (AB-88's `LivenessObservable`).
   * Delivers the current snapshot synchronously before returning, then a
   * new snapshot on every revision change; already-terminal work delivers
   * the terminal snapshot once.
   */
  subscribeSnapshot: (
    observer: (snapshot: AgentRunLivenessSnapshot) => void,
    options?: { signal?: AbortSignal },
  ) => Subscription;
  [Symbol.dispose]: () => void;
}

/**
 * Dependencies for the liveness identifier/clock seams (AB-88's Amendment 1,
 * corrected by AB-214's coordinator rulings). Composition-root only — never
 * reached from inside run logic a test would need to replace. Tests inject
 * their own {@link RunIdentifierSeam} and/or clock instead of relying on the
 * process-wide defaults.
 */
export interface CreateActiveRunDependencies {
  identifiers?: RunIdentifierSeam;
  clock?: StallWatchdogClock;
  /**
   * The authenticated principal or Bureau identifier that owns this run
   * (`LivenessSnapshot.owner`, AC4). Absent for a standalone run (AB-88's
   * standalone-run resolution) — Bureau supplies its own `request.principal`
   * here when starting a run.
   */
  owner?: string;
}

/**
 * Creates an event-emitting agent loop run.
 *
 * Public, documented API — the full-control factory behind `createAgent`,
 * `createSessionHandle`, and bureau-owned agents alike. It accepts the
 * complete `RunOptions` bag directly: an existing `Conversation` or
 * `ConversationHistory`, a pre-built `Toolbox` instance, hooks, and durable
 * routing. `bureau` and `evaluation` both depend on it as first-party
 * consumers, not just internal plumbing.
 *
 * Most callers should reach for `createAgent({...}).run(...)` instead — it
 * wraps this in the higher-level `AgentRun` handle and covers the common
 * bureau-less cases (fresh string input, name-keyed tools, headless
 * permissions, or a resumed `ConversationHistory` with an injected
 * `Toolbox`). Use `createActiveRun` directly when you need something
 * `createAgent` doesn't expose — e.g. an already-live `Conversation`
 * instance (rather than a plain `ConversationHistory`), durable routing, or
 * a pre-built emitter to bind tool dispatches to.
 *
 * When `durable` is provided (engine + checkpoint store + runId), the run is
 * driven through the Weft durable engine so it survives a crash and resumes.
 * Without `durable`, the in-memory loop runs.
 *
 * A standalone (non-Bureau) in-memory run — one whose `options.runId` is
 * absent — mints a process-local id here from the `RunIdentifierSeam`
 * (AB-88's Amendment 1, corrected by AB-214's coordinator rulings 2026-09-02
 * to a local seam in `liveness/identifiers.ts` rather than the not-yet-built
 * `RuntimeServices.identifiers`). The minted id becomes both
 * `LivenessSnapshot.id` and `RunOptions.runId` for the rest of this run —
 * including the curated `tool.*` bubble-event stamping and
 * `createSubagentTool`'s per-call `parentRunId` — so a bare
 * `createAgent().run()` has a stable run identity end to end. A Bureau- or
 * caller-supplied `options.runId` is always used as-is, keeping this id
 * identical to whatever id `store.register` later uses for the same run.
 */
export function createActiveRun(
  options: RunOptions,
  durable?: DurableRunRouting,
  dependencies?: CreateActiveRunDependencies,
): ActiveRun {
  // AB-18: an unrepresentable `output` schema fails synchronously here,
  // before either driver's async work begins — `createAgent` already runs
  // this same guard at its own call time; this covers `createActiveRun`
  // callers who bypass `createAgent` (bureau, sessions, durable routing).
  if (options.output) {
    toOutputJsonSchema(options.output);
  }

  // AB-92/AB-252/AB-253: resolved exactly once, here, at construction — BEFORE
  // branching on `durable` — and snapshotted into `options` for both the
  // durable and in-memory paths below, so neither driver ever falls back to a
  // global independently of the other.
  const runtime = options.runtime ?? createDefaultRuntimeServices();

  if (durable) {
    return createDurableActiveRun(
      { engine: durable.engine, checkpointStore: durable.checkpointStore },
      {
        runId: durable.runId,
        sessionId: durable.sessionId ?? durable.runId,
        // F2: thread agentName from RunOptions into the durable input. Falls
        // back to '' inside createDurableActiveRun if undefined here.
        agentName: options.agentName,
        options: { ...options, runtime },
        prompt: durable.prompt,
        ...(dependencies?.clock ? { livenessClock: dependencies.clock } : {}),
        ...(dependencies?.owner !== undefined ? { livenessOwner: dependencies.owner } : {}),
        ...(durable.emitter
          ? {
              emitter: durable.emitter,
            }
          : {}),
        ...(durable.onServices ? { onServices: durable.onServices } : {}),
      },
    );
  }

  const emitter = new CompletableEventTarget<CombinedOperativeEventMap>();
  const abortController = new AbortController();

  const combinedSignal = options.signal
    ? AbortSignal.any([options.signal, abortController.signal])
    : abortController.signal;

  const conversation = isConversation(options.conversation)
    ? options.conversation
    : // Snapshot a plain `ConversationHistory` on the way in, matching
      // `createAgent` and the durable path. `Conversation` keeps the object it
      // is constructed with, and the run starts on a later microtask, so a
      // stateless host that mutates its stored history after this returns would
      // otherwise corrupt the in-flight run. `ConversationHistory` is a
      // structuredClone-safe tree — see `durable/types.ts`.
      new Conversation(structuredClone(options.conversation));

  // AB-88's Amendment 1, rebound by AB-252 (per AB-214's coordinator-ruling
  // promise) onto `RuntimeServices.identifiers`: mint a process-local id for
  // every standalone (no explicit `options.runId`) in-memory run through the
  // resolved runtime's identifier seam, never a bare `crypto.randomUUID()`
  // reached from inside run logic. `dependencies?.identifiers` (the
  // narrower AB-214 seam) still takes precedence when a caller explicitly
  // supplies one, for backward compatibility. A Bureau- or caller-supplied
  // `runId` is always used as-is, so this id stays identical to whatever id
  // `store.register` uses for a Bureau-started run.
  const runId =
    options.runId ?? dependencies?.identifiers?.next() ?? runtime.identifiers.next('run');

  const liveness = createActiveRunLiveness({
    id: runId,
    durability: 'process-local',
    clock: dependencies?.clock,
    owner: dependencies?.owner,
    // AB-216 — backs `LivenessSnapshot.worstChildAssessment`. Opt-in: a run
    // started without `options.childRegistry` never populates the field,
    // matching `children()`/`abortChild()`'s own opt-in default (AB-50).
    childRegistry: options.childRegistry,
  });

  const loopOptions: RunOptions = {
    ...options,
    conversation,
    signal: combinedSignal,
    runId,
    runtime,
  };

  const cleanups: (() => void)[] = [];

  // closed()'s not-required fast path (coordinator ruling, AB-204): until
  // AB-88 ships a `cancellable` snapshot field, in-flight tool executions are
  // this run's own signal that cleanup is not trivially unnecessary.
  let inFlightTools = 0;
  // AB-204 (PRRT_kwDORvupsc6elvRf): `inFlightTools` alone only gated
  // `closed()`'s not-required fast path — it did not stop `resolveOutcome`
  // from reporting `completed` while a sibling tool in a `failFast` batch
  // was still executing after the run's `result` had already settled.
  // `toolDrainWaiters` lets `resolveOutcome` actually wait for the counter
  // to return to zero before acknowledging cleanup.
  let toolDrainWaiters: Array<() => void> = [];
  function awaitToolDrain(): Promise<void> {
    if (inFlightTools === 0) return Promise.resolve();
    return new Promise((resolve) => toolDrainWaiters.push(resolve));
  }
  // AB-204 review (PRRT_kwDORvupsc6erisq), superseded by AB-290: a caller
  // can supply the SAME `Toolbox` instance to more than one concurrent run
  // — `create-agent.ts` explicitly preserves the supplied toolbox across
  // `.run()` calls — and the toolbox's `execute-start`/`settled`/`progress`
  // events are toolbox-wide, not scoped to any one run. Without scoping,
  // `inFlightTools` would also count another run's tool calls on the
  // shared toolbox, so THIS run's `closed()` could wait on work it doesn't
  // own (and never settle if that other run's tool hangs) — and the bubble
  // events below would leak another run's tool activity onto this run's own
  // emitter. AB-290 replaces the old `ownedToolCallIds`/`ToolCall.id`
  // tracking (a provider-supplied id, never guaranteed unique across
  // concurrent runs) with `event.ownerId === runId`: `run-step.ts` stamps
  // this run's own id as `ownerId` on every `Toolbox.execute()` call it
  // makes, and armorer echoes it back verbatim on `execute-start`,
  // `progress`, and `settled`.
  const isOwnEvent = (event: { ownerId?: string }): boolean => event.ownerId === runId;
  // AB-204 (PRRT_kwDORvupsc6ekmeT / PRRT_kwDORvupsc6elvRf): every run-owned
  // hook (`onRunComplete`/`onRunAbort`/`onRunError`/`onLLMInput`/
  // `onLLMOutput`) fires via `runHookSilently`'s fire-and-forget
  // `Promise.allSettled`, so `result` can settle while one is still running.
  // `hookTracker` collects each hook's promise (threaded through
  // `executeLoop` → `StepDeps`/`run-lifecycle.ts`) so `resolveOutcome` can
  // await genuine hook completion before acknowledging cleanup.
  const pendingHookPromises: Promise<unknown>[] = [];
  const hookTracker = (promise: Promise<unknown>): void => {
    pendingHookPromises.push(promise);
  };

  const conversationForward = forwardEvents(conversation, emitter, 'conversation');
  cleanups.push(() => conversationForward.stop());

  // Provider I/O activity — the only source that populates `provider-io`
  // evidence (AC11). A locally scheduled pulse is never labeled this way.
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

  // C3 — curated tool.* bubble events stamped with {agentName, runId, step}.
  // We track the current step by listening to StepStartedEvent (which fires at
  // the start of each step). The agentName comes from RunOptions (optional —
  // supplied by bureau.agent / createAgent / SessionHandle); runId is always
  // the minted-or-supplied id resolved above.
  //
  // AB-294: these listeners move onto the same per-step subscription
  // `toolboxForwarder` uses for the low-level `toolbox.*` forward (AB-239) —
  // `attachToolboxCuratedListeners` below is passed to
  // `createToolboxEventForwarder` as its `attachCurated` argument, so a
  // `selectTools`-swapped step toolbox gets these listeners for exactly the
  // duration of the step that resolved it, with no duplicate delivery when
  // the step toolbox is the original (same base+swap bracket as AB-239).
  const toolboxForwarder = (() => {
    const agentName = options.agentName ?? '';
    let currentStep = 0;
    const stepListener = (e: StepStartedEvent) => (currentStep = e.step);
    emitter.addEventListener(StepStartedEvent.type, stepListener);
    cleanups.push(() => emitter.removeEventListener(StepStartedEvent.type, stepListener));

    // Map 'execute-start' → tool.started (reliably emitted for all tools, regardless of telemetry flag)
    const onExecuteStart = (e: ToolboxEventMap['execute-start']) => {
      // AB-290: `e.ownerId` is armorer's echo of the `ownerId` `run-step.ts`
      // stamped on THIS run's own `Toolbox.execute()` calls. A concurrent
      // run sharing the same toolbox stamps its own id, so this event is
      // skipped entirely here — both the accounting below AND the bubble
      // dispatch — rather than only gating the accounting as the old
      // `ownedToolCallIds`/`ToolCall.id` tracking did, which let another
      // run's tool activity leak onto this run's own `tool.started` stream.
      if (!isOwnEvent(e)) return;
      inFlightTools += 1;
      // AB-214 review (PRRT_kwDORvupsc6esZRy): the tool-call watchdog
      // exists only while a tool call this run owns is actually in
      // flight — an idle run producing no tool-progress events must not
      // be reported stalled/unreachable for it.
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

    // Map 'settled' → tool.settled (fired after every tool call regardless of outcome)
    const onSettled = (e: ToolboxEventMap['settled']) => {
      // AB-290: mirrors the `onExecuteStart` guard above — see its comment.
      if (!isOwnEvent(e)) return;
      // The tool-call watchdog (AB-214) tracks whether the RUN is still
      // waiting on this call, not whether the callback has physically
      // returned — once the cancellation race settles, the run itself has
      // moved on (the call produced a result, even a cancelled one) and
      // stops waiting, so ending the watchdog here is correct: keeping it
      // alive until an abort-ignoring callback's own promise eventually
      // returns (which may be never, for a genuinely leaked background
      // task) would report the whole run stalled/unreachable for work the
      // run no longer waits on.
      liveness.endToolCall();
      // AB-289: armorer's `settled` event fires as soon as the
      // cancellation race against the execution signal settles — not
      // once the tool callback's own returned promise has genuinely
      // settled. A callback that ignores its abort signal keeps running
      // after this event fires, and `e.callbackCompletion` is the promise
      // that observes its real completion (see armorer's
      // `ExecutionHandle.whenSettled`). Defer the drain decrement until
      // that promise resolves so `awaitToolDrain()` — and therefore
      // `resolveOutcome` below — never reports this call done while it is
      // still actually running. A `settled` event with no
      // `callbackCompletion` (e.g. a hand-constructed test event) drains
      // synchronously, right here, matching the pre-AB-289 behavior
      // exactly rather than deferring by a spurious microtask.
      const release = () => {
        // Clamped: armorer can emit 'settled' with no preceding
        // 'execute-start' for a tool call cancelled before execution
        // begins (an already-aborted signal path), which would otherwise
        // drive this negative and corrupt hasInFlightWork()'s later reads.
        inFlightTools = Math.max(0, inFlightTools - 1);
        if (inFlightTools === 0 && toolDrainWaiters.length > 0) {
          const waiters = toolDrainWaiters;
          toolDrainWaiters = [];
          for (const resolve of waiters) resolve();
        }
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
      // Also emit the dedicated tool.error event for failed tools
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
      // AB-290: mirrors the `onExecuteStart` guard above — see its comment.
      // A caller can supply the SAME `Toolbox` instance to more than one
      // concurrent run (`create-agent.ts`), so both the bubble dispatch and
      // the liveness pulse below must skip a call this run doesn't own.
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
      // AB-214/obs-01: a pulse arriving through this ingestion point is
      // always labeled 'tool-progress', never 'provider-io', even when the
      // tool internally wraps a provider call — the tool-call `StallPolicy`
      // row is the one this pulse is recorded against.
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
    // that omit `addEventListener` (e.g. minimal stubs used in tests) — if
    // the method is absent the bubbling simply does not happen; no exception.
    //
    // AB-204 review (PRRT_kwDORvupsc6erisn): these must NOT be bound to
    // `abortController.signal` — armorer's `addEventListener` merges a
    // supplied signal for automatic removal, so `abort()` would strip
    // `onExecuteStart`/`onSettled` immediately, synchronously, on the same
    // tick, before a tool already in flight can ever emit its `settled`
    // event. `inFlightTools` would then never reach zero and
    // `awaitToolDrain()` (used by `resolveOutcome` below) would hang forever
    // after an abort. Removal is handled entirely by the returned detach
    // function instead.
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
      const removeToolboxListeners = (): void => {
        for (const cleanup of toolboxCleanups) cleanup?.();
      };
      // Drain-aware removal (AB-204, PRRT_kwDORvupsc6elvRf) applies only to
      // the run's base toolbox — a `failFast` parallel tool batch can settle
      // `result` while sibling tool calls on the base toolbox are still
      // executing, and tearing this listener down right here, unconditionally,
      // would mean `onSettled` never sees those siblings' `settled` events, so
      // `inFlightTools` would never reach zero and `awaitToolDrain()` (used by
      // `resolveOutcome` below) would hang forever. A step-swap toolbox's
      // detach instead runs at the step's actual end (mirroring the low-level
      // `toolbox.*` forward's swap-close in `toolbox-event-forwarding.ts`),
      // by which point `runStep` has already awaited that step's own tool
      // calls to completion, so no drain wait is needed there.
      const isBaseToolbox = toolboxInstance === options.toolbox;
      return () => {
        if (!isBaseToolbox || inFlightTools === 0) {
          removeToolboxListeners();
        } else {
          void awaitToolDrain().then(removeToolboxListeners);
        }
      };
    };

    // AB-239: the base subscription covers the whole run; `toolboxForwarder.onStepToolbox`
    // (wired below via `executeLoop`) additionally covers any step whose `selectTools`
    // hook swaps in a different toolbox for that step — including, since AB-294, the
    // curated listeners defined above.
    return createToolboxEventForwarder(options.toolbox, emitter, attachToolboxCuratedListeners);
  })();
  cleanups.push(() => toolboxForwarder.stop());

  const result = Promise.resolve()
    .then(() =>
      executeLoop(loopOptions, emitter, hookTracker, (toolbox) =>
        toolboxForwarder.onStepToolbox(toolbox),
      ),
    )
    .then(
      (runResult) => {
        // Atomic (AB-214 review PRRT_kwDORvupsc6esZSx): attach `result` and
        // transition to `terminal` as one revision, never two, so no
        // subscriber ever observes `status: 'running'` with a populated
        // `result`. Redacted (AB-214 review PRRT_kwDORvupsc6es7pl): every
        // standalone run's projection is `'redacted'` permanently, so the
        // raw `RunResult` — full conversation, tool arguments/results,
        // arbitrary errors — never reaches the snapshot; only the safe
        // summary does.
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

  function abort(reason?: string): void {
    cancelRequested = true;
    liveness.setStatus('aborting');
    abortController.abort(reason);
  }

  // A cancellation delivered through `RunOptions.signal` alone (never
  // calling this ActiveRun's own `abort()`) must still route through
  // `abort()` — not just be observed later by `disqualifiesFastPath`'s
  // `combinedSignal.aborted` read. `evaluateNotRequired()` and
  // `resolveOutcome` are on `closed()`'s async path, so relying on either
  // to set `cancelRequested` would be an ordering hazard; this makes the
  // signal itself the trigger, synchronously, the same tick it fires.
  if (combinedSignal.aborted) {
    abort(typeof combinedSignal.reason === 'string' ? combinedSignal.reason : undefined);
  } else {
    const onCombinedSignalAbort = (): void =>
      abort(typeof combinedSignal.reason === 'string' ? combinedSignal.reason : undefined);
    combinedSignal.addEventListener('abort', onCombinedSignalAbort, { once: true });
    // AB-204 review (PRRT_kwDORvupsc6erGS9): `options.signal` can be a
    // long-lived signal a caller reuses across many runs. Left attached,
    // this listener fires `abort()` on THIS already-terminal run whenever
    // that shared signal later aborts for an unrelated reason — retroactively
    // marking a historical, completed run cancelled (and, in the identical
    // durable block in `active-run-adapter.ts`, issuing `engine.cancel()`
    // for an already-terminal workflow). Detach once `result` settles;
    // while the run is still in flight the listener stays live exactly as
    // before.
    cleanups.push(() => combinedSignal.removeEventListener('abort', onCombinedSignalAbort));
  }

  function complete(): void {
    for (const cleanup of cleanups) cleanup();
    emitter.complete();
    // `complete()` is documented to complete only the event stream, not to
    // abort or otherwise end the underlying run (AB-214 review
    // PRRT_kwDORvupsc6esZSM) — liveness disposal happens exclusively via
    // `setStatus('terminal')`/`settle()` above, which always run before this
    // `.finally(complete)` callback does. No separate `liveness.dispose()`
    // call belongs here.
  }

  // The in-memory loop resolves `result` for every terminal shape (stop,
  // abort, error) — see `run-lifecycle.ts`'s `make*Result` helpers — so
  // cleanup is `completed` whenever `result` settles at all; a genuine
  // rejection (e.g. a cleanup listener itself throwing inside `complete()`,
  // which `.finally()` surfaces as the settlement) is the only `failed` case.
  // AB-211: a parent does not resolve `closed()`'s `completed` while any
  // addressable child (AB-50's `ChildRunRegistry`, opt-in via
  // `options.childRegistry`) is still cleanup-pending — gated on each
  // child's own `closed()` via `awaitChildrenClosed` (`child-run.ts`), not
  // merely its terminal `result()`, matching AB-204's own "settlement, not
  // just result" standard. A run started without `options.childRegistry`
  // (or one with zero registered children) is untouched: `children().length`
  // is `0`, so the fast path below behaves identically to before this
  // issue, with zero added latency.
  const childRegistry = options.childRegistry;

  const closed = createClosedAcknowledgement({
    result,
    // `cancelRequested` alone misses a cancellation that arrived through
    // `RunOptions.signal` (e.g. `AgentRunContext.signal`) rather than a
    // direct `abort()` call — `combinedSignal` covers both.
    disqualifiesFastPath: () => cancelRequested || combinedSignal.aborted,
    // A registered child disqualifies the `not-required` fast path even
    // once its own `result()` has resolved — its `closed()` can still be
    // pending (a slow tool-drain wait or run-owned hook, AB-204's own
    // AC7/AC8), and the fast path has no way to check that without
    // awaiting, which is exactly what `resolveOutcome` below is for.
    hasInFlightWork: () => inFlightTools > 0 || (childRegistry?.children().length ?? 0) > 0,
    // AB-204: `result` settling is not, by itself, proof that cleanup is
    // done — a `failFast` tool batch can leave siblings executing
    // (PRRT_kwDORvupsc6elvRf) and a run-owned hook can still be running
    // (PRRT_kwDORvupsc6ekmeT). AB-211 adds a third: every registered
    // child's own `closed()` must settle too. Await all three before
    // reporting `completed`.
    resolveOutcome: async () => {
      await Promise.all([
        awaitToolDrain(),
        Promise.allSettled(pendingHookPromises),
        childRegistry?.awaitChildrenClosed() ?? Promise.resolve(),
      ]);
      return { status: 'completed' };
    },
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
 * Routing for a durable run.
 */
export interface DurableRunRouting extends DurableActiveRunContext {
  /** Stable id for the run; also the durable workflow id (resume key). */
  runId: string;
  /**
   * The session that owns this run, carried in the durable input so boot recovery
   * can correlate a recovered handle to its session. Defaults to `runId` for a
   * headless run with no distinct session.
   */
  sessionId?: string;
  /** First user message to seed a brand-new run. */
  prompt?: string;
  /**
   * A pre-built emitter for this run's event surface. Threaded through to
   * {@link createDurableActiveRun} — see `DurableActiveRunOptions.emitter` for
   * why a caller would supply one (binding a toolbox tool's dispatches, like
   * `requestHumanInput`'s `HumanWaitParkedEvent`, to the exact emitter this
   * `ActiveRun` exposes).
   */
  emitter?: OperativeEventEmitter;
  /**
   * Synchronous hook invoked with the freshly-built per-run `DurableRunDeps`
   * (`ctx.services`) right before `engine.start`. See
   * `DurableActiveRunOptions.onServices`.
   */
  onServices?: (services: DurableRunDeps) => void;
}
