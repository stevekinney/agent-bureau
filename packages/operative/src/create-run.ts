import { Conversation, isConversation } from 'conversationalist';
import type { ForwardableSource, ObservableLike, Observer, Subscription } from 'lifecycle';
import { CompletableEventTarget, forwardEvents } from 'lifecycle';

import type { DurableActiveRunContext } from './durable/active-run-adapter';
import { createDurableActiveRun } from './durable/active-run-adapter';
import type { CombinedOperativeEventMap, CombinedOperativeEventType } from './events';
import { executeLoop } from './loop';
import type { RunOptions, RunResult } from './types';

/**
 * An active, event-emitting agent loop run.
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
 * Routing for a durable run. When provided to {@link createRun}, the run is
 * driven through the Weft durable engine — checkpointed and resumable — instead
 * of the in-memory loop. The `ActiveRun` surface is identical either way.
 *
 * Mirrors the `executeLoop(options, emitter?)` convention: durability is an
 * optional second argument, NOT a field on `RunOptions`, so the standalone
 * library signature is unchanged and callers without an engine are unaffected.
 */
export interface DurableRunRouting extends DurableActiveRunContext {
  /** Stable id for the run; also the durable workflow id (resume key). */
  runId: string;
  /** First user message to seed a brand-new run. */
  prompt?: string;
}

/**
 * Creates an event-emitting agent loop run.
 *
 * When `durable` is provided (an engine + checkpoint store + runId), the run is
 * driven through the Weft durable engine so it survives a crash and resumes from
 * its last checkpoint. The returned {@link ActiveRun} is identical in both modes.
 * Without `durable`, the in-memory loop runs (the standalone-library default).
 */
export function createRun(options: RunOptions, durable?: DurableRunRouting): ActiveRun {
  if (durable) {
    return createDurableActiveRun(
      { engine: durable.engine, checkpointStore: durable.checkpointStore },
      { runId: durable.runId, options, prompt: durable.prompt },
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

  // Subscribe to toolbox and conversation events, re-emitting with prefixes.
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

  // Defer the loop start to the next microtask so callers can attach listeners first.
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
