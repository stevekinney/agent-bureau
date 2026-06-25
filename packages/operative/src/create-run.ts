import { Conversation, isConversation } from 'conversationalist';
import type { ForwardableSource, ObservableLike, Observer, Subscription } from 'lifecycle';
import { CompletableEventTarget, forwardEvents } from 'lifecycle';

import type { DurableActiveRunContext } from './durable/active-run-adapter';
import { createDurableActiveRun } from './durable/active-run-adapter';
import type { CombinedOperativeEventMap, CombinedOperativeEventType } from './events';
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
 * Internal factory — NOT part of the public API. External callers should use
 * `createAgent` (which wraps this in an `AgentRun`) or `createSessionHandle`
 * (which also wraps the result). Scheduler and durable adapter consume this
 * directly because they need the raw event surface.
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
        options,
        prompt: durable.prompt,
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
}
