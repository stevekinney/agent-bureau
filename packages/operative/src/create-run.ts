import { Conversation, isConversation } from 'conversationalist';
import type { ForwardableSource, ObservableLike, Observer, Subscription } from 'lifecycle';
import { CompletableEventTarget, forwardEvents } from 'lifecycle';

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
 * Creates an event-emitting agent loop run.
 */
export function createRun(options: RunOptions): ActiveRun {
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
