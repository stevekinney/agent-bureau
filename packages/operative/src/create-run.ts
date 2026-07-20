import type { ToolboxEventMap } from 'armorer';
import { Conversation, isConversation } from 'conversationalist';
import type { ForwardableSource, ObservableLike, Observer, Subscription } from 'lifecycle';
import { CompletableEventTarget, forwardEvents } from 'lifecycle';

import type { DurableActiveRunContext } from './durable/active-run-adapter';
import { createDurableActiveRun } from './durable/active-run-adapter';
import type { DurableRunDeps } from './durable/types';
import type { CombinedOperativeEventMap, CombinedOperativeEventType } from './events';
import {
  StepStartedEvent,
  ToolErrorBubbleEvent,
  ToolPolicyDeniedBubbleEvent,
  ToolProgressBubbleEvent,
  ToolSettledBubbleEvent,
  ToolStartedBubbleEvent,
} from './events';
import { executeLoop } from './loop';
import type { RunOptions, RunResult } from './types';

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
      | Observer<CombinedOperativeEventMap[K]>
      | ((value: CombinedOperativeEventMap[K]) => void),
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
        ...(durable.emitter ? { emitter: durable.emitter } : {}),
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
    : new Conversation(options.conversation);

  const loopOptions: RunOptions = {
    ...options,
    conversation,
    signal: combinedSignal,
  };

  const cleanups: (() => void)[] = [];

  const toolboxForward = forwardEvents(
    options.toolbox as unknown as ForwardableSource,
    emitter,
    'toolbox',
  );
  cleanups.push(() => toolboxForward.stop());

  const conversationForward = forwardEvents(
    conversation as unknown as ForwardableSource,
    emitter,
    'conversation',
  );
  cleanups.push(() => conversationForward.stop());

  // C3 — curated tool.* bubble events stamped with {agentName, runId, step}.
  // We track the current step by listening to StepStartedEvent (which fires at
  // the start of each step). The agentName and runId come from RunOptions
  // (optional — supplied by bureau.agent / createAgent / SessionHandle).
  {
    const agentName = options.agentName ?? '';
    const runId = options.runId ?? '';
    let currentStep = 0;

    // Track step number from StepStartedEvents
    const stepListener = (e: StepStartedEvent) => {
      currentStep = e.step;
    };
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

  const result = Promise.resolve()
    .then(() => executeLoop(loopOptions, emitter))
    .finally(complete);

  function abort(reason?: string): void {
    abortController.abort(reason);
  }

  function complete(): void {
    for (const cleanup of cleanups) cleanup();
    emitter.complete();
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
  emitter?: CompletableEventTarget<CombinedOperativeEventMap>;
  /**
   * Synchronous hook invoked with the freshly-built per-run `DurableRunDeps`
   * (`ctx.services`) right before `engine.start`. See
   * `DurableActiveRunOptions.onServices`.
   */
  onServices?: (services: DurableRunDeps) => void;
}
