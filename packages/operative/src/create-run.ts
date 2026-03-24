import { Conversation, isConversation } from 'conversationalist';
import type {
  AddEventListenerOptionsLike,
  AsyncIteratorOptions,
  EmissionEvent,
} from 'event-emission';
import { createEventTarget } from 'event-emission';
import type { ObservableLike, Observer, Subscription } from 'event-emission/types';

import { bindEmitter } from './bind-emitter';
import type {
  CombinedOperativeEvents,
  CombinedOperativeEventType,
  OperativeEvents,
  OperativeEventType,
} from './events';
import { executeLoop } from './loop';
import type { RunOptions, RunResult } from './types';

type LoopEmitter = {
  emit: <K extends OperativeEventType>(type: K, detail: OperativeEvents[K]) => boolean;
};

/**
 * An active, event-emitting agent loop run.
 */
export interface ActiveRun {
  result: Promise<RunResult>;
  abort: (reason?: string) => void;
  addEventListener: <K extends CombinedOperativeEventType>(
    type: K,
    listener: (event: EmissionEvent<CombinedOperativeEvents[K], K>) => void | Promise<void>,
    options?: AddEventListenerOptionsLike,
  ) => () => void;
  on: <K extends CombinedOperativeEventType>(
    type: K,
    options?: AddEventListenerOptionsLike | boolean,
  ) => ObservableLike<EmissionEvent<CombinedOperativeEvents[K], K>>;
  once: <K extends CombinedOperativeEventType>(
    type: K,
    listener: (event: EmissionEvent<CombinedOperativeEvents[K], K>) => void | Promise<void>,
    options?: Omit<AddEventListenerOptionsLike, 'once'>,
  ) => () => void;
  subscribe: <K extends CombinedOperativeEventType>(
    type: K,
    observerOrNext?:
      | Observer<EmissionEvent<CombinedOperativeEvents[K], K>>
      | ((value: EmissionEvent<CombinedOperativeEvents[K], K>) => void),
    error?: (err: unknown) => void,
    complete?: () => void,
  ) => Subscription;
  events: <K extends CombinedOperativeEventType>(
    type: K,
    options?: AsyncIteratorOptions,
  ) => AsyncIterableIterator<EmissionEvent<CombinedOperativeEvents[K], K>>;
  toObservable: () => ObservableLike<
    EmissionEvent<CombinedOperativeEvents[CombinedOperativeEventType], CombinedOperativeEventType>
  >;
  complete: () => void;
  [Symbol.dispose]: () => void;
}

/**
 * Creates an event-emitting agent loop run.
 */
export function createRun(options: RunOptions): ActiveRun {
  const emitter = createEventTarget<CombinedOperativeEvents>();
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

  const toolboxSubscription = options.toolbox.toObservable().subscribe({
    next(event) {
      emitter.emit(
        `toolbox.${event.type}` as CombinedOperativeEventType,
        (event as { detail: CombinedOperativeEvents[CombinedOperativeEventType] }).detail,
      );
    },
  });
  cleanups.push(() => toolboxSubscription.unsubscribe());

  const conversationSubscription = conversation.toObservable().subscribe({
    next(event) {
      emitter.emit(
        `conversation.${event.type}` as CombinedOperativeEventType,
        (event as { detail: CombinedOperativeEvents[CombinedOperativeEventType] }).detail,
      );
    },
  });
  cleanups.push(() => conversationSubscription.unsubscribe());

  // Defer the loop start to the next microtask so callers can attach listeners first.
  // Cast the emitter: the loop only emits native OperativeEvents; the wider
  // CombinedOperativeEvents type is used for forwarded events outside the loop.
  const result = Promise.resolve()
    .then(() => executeLoop(loopOptions, emitter as unknown as LoopEmitter))
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
    ...bindEmitter<CombinedOperativeEvents>(emitter),
    events: emitter.events.bind(emitter) as ActiveRun['events'],
    complete,
    [Symbol.dispose](): void {
      abort();
      complete();
    },
  };
}
