import type { ToolboxEventMap } from 'armorer';
import { Conversation, isConversation } from 'conversationalist';
import type { ObservableLike, Observer, Subscription } from 'lifecycle';
import { CompletableEventTarget, forwardEvents } from 'lifecycle';

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
import { executeLoop } from './loop';
import { toOutputJsonSchema } from './structured-output/response-schema';
import { createToolboxEventForwarder } from './toolbox-event-forwarding';
import type { CleanupAcknowledgement, ClosedOptions, RunOptions, RunResult } from './types';

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
  [Symbol.dispose]: () => void;
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
 */
export function createActiveRun(options: RunOptions, durable?: DurableRunRouting): ActiveRun {
  // AB-18: an unrepresentable `output` schema fails synchronously here,
  // before either driver's async work begins — `createAgent` already runs
  // this same guard at its own call time; this covers `createActiveRun`
  // callers who bypass `createAgent` (bureau, sessions, durable routing).
  if (options.output) {
    toOutputJsonSchema(options.output);
  }

  if (durable) {
    return createDurableActiveRun(
      { engine: durable.engine, checkpointStore: durable.checkpointStore },
      {
        runId: durable.runId,
        sessionId: durable.sessionId ?? durable.runId,
        // F2: thread agentName from RunOptions into the durable input. Falls
        // back to '' inside createDurableActiveRun if undefined here.
        agentName: options.agentName,
        options,
        prompt: durable.prompt,
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

  const loopOptions: RunOptions = {
    ...options,
    conversation,
    signal: combinedSignal,
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
  // AB-204 review (PRRT_kwDORvupsc6erisq): a caller can supply the SAME
  // `Toolbox` instance to more than one concurrent run — `create-agent.ts`
  // explicitly preserves the supplied toolbox across `.run()` calls — and
  // the toolbox's `execute-start`/`settled` events are toolbox-wide, not
  // scoped to any one run. Without this, `inFlightTools` would also count
  // another run's tool calls on the shared toolbox, so THIS run's
  // `closed()` could wait on work it doesn't own (and never settle if that
  // other run's tool hangs). `trackToolCallIds` (wired through
  // `executeLoop` → `StepDeps`, called from `run-step.ts` right before
  // `Toolbox.execute()`) records exactly the call ids this run itself
  // dispatches, and `onExecuteStart`/`onSettled` below only count those.
  const ownedToolCallIds = new Set<string>();
  const trackToolCallIds = (ids: readonly string[]): void => {
    for (const id of ids) ownedToolCallIds.add(id);
  };
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

  // AB-239: the base subscription covers the whole run; `toolboxForwarder.onStepToolbox`
  // (wired below via `executeLoop`) additionally covers any step whose `selectTools`
  // hook swaps in a different toolbox for that step.
  const toolboxForwarder = createToolboxEventForwarder(options.toolbox, emitter);
  cleanups.push(() => toolboxForwarder.stop());

  const conversationForward = forwardEvents(conversation, emitter, 'conversation');
  cleanups.push(() => conversationForward.stop());

  // C3 — curated tool.* bubble events stamped with {agentName, runId, step}.
  // We track the current step by listening to StepStartedEvent (which fires at
  // the start of each step). The agentName and runId come from RunOptions
  // (optional — supplied by bureau.agent / createAgent / SessionHandle).
  {
    const agentName = options.agentName ?? '';
    const runId = options.runId ?? '';
    let currentStep = 0;
    const stepListener = (e: StepStartedEvent) => (currentStep = e.step);
    emitter.addEventListener(StepStartedEvent.type, stepListener);
    cleanups.push(() => emitter.removeEventListener(StepStartedEvent.type, stepListener));
    // Wire the curated toolbox events onto the run emitter.
    // The toolbox addEventListener returns a cleanup function and also accepts
    // an AbortSignal for automatic cleanup. We guard against mock/custom toolboxes
    // that omit addEventListener (e.g. minimal stubs used in tests) — if the method
    // is absent the bubbling simply does not happen; no exception.
    const toolbox = options.toolbox as unknown as {
      addEventListener?: <K extends keyof ToolboxEventMap>(
        type: K,
        listener: (e: ToolboxEventMap[K]) => void,
        options?: AddEventListenerOptions,
      ) => () => void;
    };

    // Map 'execute-start' → tool.started (reliably emitted for all tools, regardless of telemetry flag)
    const onExecuteStart = (e: ToolboxEventMap['execute-start']) => {
      // AB-204 review (PRRT_kwDORvupsc6erisq): only count calls this run
      // itself dispatched — see `ownedToolCallIds` above. Bubble events
      // still fire for every toolbox call regardless, unchanged.
      if (ownedToolCallIds.has(e.call.id)) {
        inFlightTools += 1;
      }
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

    // Map 'settled' → tool.settled (fired after every tool call regardless of outcome)
    const onSettled = (e: ToolboxEventMap['settled']) => {
      // AB-204 review (PRRT_kwDORvupsc6erisq): only decrement for a call
      // this run itself dispatched (mirrors the `onExecuteStart` guard
      // above) — otherwise a concurrent run sharing the same toolbox could
      // drive this negative (masked by the clamp below, but still wrong)
      // or spuriously satisfy this run's drain wait for work it never
      // started.
      if (ownedToolCallIds.has(e.call.id)) {
        // Clamped: armorer can emit 'settled' with no preceding 'execute-start'
        // for a tool call cancelled before execution begins (an already-
        // aborted signal path), which would otherwise drive this negative and
        // corrupt hasInFlightWork()'s later reads.
        inFlightTools = Math.max(0, inFlightTools - 1);
        if (inFlightTools === 0 && toolDrainWaiters.length > 0) {
          const waiters = toolDrainWaiters;
          toolDrainWaiters = [];
          for (const resolve of waiters) resolve();
        }
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

    // Each call returns a cleanup function; guard against stubs without addEventListener.
    if (toolbox.addEventListener) {
      const addListener = toolbox.addEventListener.bind(toolbox);
      // AB-204 review (PRRT_kwDORvupsc6erisn): these must NOT be bound to
      // `abortController.signal` — armorer's `addEventListener` merges a
      // supplied signal for automatic removal, so `abort()` would strip
      // `onExecuteStart`/`onSettled` immediately, synchronously, on the
      // same tick, before a tool already in flight can ever emit its
      // `settled` event. `inFlightTools` would then never reach zero and
      // `awaitToolDrain()` (used by `resolveOutcome` below) would hang
      // forever after an abort. Removal is handled entirely by the
      // explicit, already-drain-aware `cleanups` entry below instead,
      // which still runs on every termination path (abort included) once
      // `result` settles via `.finally(complete)`.
      const toolboxCleanups = [
        addListener('execute-start', onExecuteStart),
        addListener('settled', onSettled),
        addListener('progress', onToolProgress),
        addListener('policy-denied', onPolicyDenied),
      ];
      const removeToolboxListeners = (): void => {
        for (const cleanup of toolboxCleanups) cleanup?.();
      };
      cleanups.push(() => {
        // AB-204 (PRRT_kwDORvupsc6elvRf): a `failFast` parallel tool batch
        // can settle `result` (via `makeErrorResult`) while sibling tool
        // calls are still executing. Tearing this listener down right here,
        // unconditionally, would mean `onSettled` never sees those siblings'
        // `settled` events, so `inFlightTools` would never reach zero and
        // `awaitToolDrain()` (used by `resolveOutcome` below) would hang
        // forever. Defer the teardown until the counter actually drains;
        // the common case (no in-flight tools left) tears down immediately,
        // same as before.
        if (inFlightTools === 0) {
          removeToolboxListeners();
        } else {
          void awaitToolDrain().then(removeToolboxListeners);
        }
      });
    }
  }

  const result = Promise.resolve()
    .then(() =>
      executeLoop(loopOptions, emitter, hookTracker, trackToolCallIds, (toolbox) =>
        toolboxForwarder.onStepToolbox(toolbox),
      ),
    )
    .finally(complete);

  let cancelRequested = false;

  function abort(reason?: string): void {
    cancelRequested = true;
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
  }

  // The in-memory loop resolves `result` for every terminal shape (stop,
  // abort, error) — see `run-lifecycle.ts`'s `make*Result` helpers — so
  // cleanup is `completed` whenever `result` settles at all; a genuine
  // rejection (e.g. a cleanup listener itself throwing inside `complete()`,
  // which `.finally()` surfaces as the settlement) is the only `failed` case.
  const closed = createClosedAcknowledgement({
    result,
    // `cancelRequested` alone misses a cancellation that arrived through
    // `RunOptions.signal` (e.g. `AgentRunContext.signal`) rather than a
    // direct `abort()` call — `combinedSignal` covers both.
    disqualifiesFastPath: () => cancelRequested || combinedSignal.aborted,
    hasInFlightWork: () => inFlightTools > 0,
    // AB-204: `result` settling is not, by itself, proof that cleanup is
    // done — a `failFast` tool batch can leave siblings executing
    // (PRRT_kwDORvupsc6elvRf) and a run-owned hook can still be running
    // (PRRT_kwDORvupsc6ekmeT). Await both before reporting `completed`.
    resolveOutcome: async () => {
      await Promise.all([awaitToolDrain(), Promise.allSettled(pendingHookPromises)]);
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
