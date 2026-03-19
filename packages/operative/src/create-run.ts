import type {
  AddEventListenerOptionsLike,
  AsyncIteratorOptions,
  EmissionEvent,
} from 'event-emission';
import { createEventTarget } from 'event-emission';
import type { ObservableLike, Observer, Subscription } from 'event-emission/types';

import type { OperativeEvents, OperativeEventType } from './events';
import { executeLoop } from './loop';
import type { RunOptions, RunResult } from './types';

/**
 * An active, event-emitting agent loop run.
 */
export interface ActiveRun {
  result: Promise<RunResult>;
  abort: (reason?: string) => void;
  addEventListener: <K extends OperativeEventType>(
    type: K,
    listener: (event: EmissionEvent<OperativeEvents[K], K>) => void | Promise<void>,
    options?: AddEventListenerOptionsLike,
  ) => () => void;
  on: <K extends OperativeEventType>(
    type: K,
    options?: AddEventListenerOptionsLike | boolean,
  ) => ObservableLike<EmissionEvent<OperativeEvents[K], K>>;
  once: <K extends OperativeEventType>(
    type: K,
    listener: (event: EmissionEvent<OperativeEvents[K], K>) => void | Promise<void>,
    options?: Omit<AddEventListenerOptionsLike, 'once'>,
  ) => () => void;
  subscribe: <K extends OperativeEventType>(
    type: K,
    observerOrNext?:
      | Observer<EmissionEvent<OperativeEvents[K], K>>
      | ((value: EmissionEvent<OperativeEvents[K], K>) => void),
    error?: (err: unknown) => void,
    complete?: () => void,
  ) => Subscription;
  events: <K extends OperativeEventType>(
    type: K,
    options?: AsyncIteratorOptions,
  ) => AsyncIterableIterator<EmissionEvent<OperativeEvents[K], K>>;
  toObservable: () => ObservableLike<
    EmissionEvent<OperativeEvents[OperativeEventType], OperativeEventType>
  >;
  complete: () => void;
  [Symbol.dispose]: () => void;
}

/**
 * Creates an event-emitting agent loop run.
 */
export function createRun(options: RunOptions): ActiveRun {
  const emitter = createEventTarget<OperativeEvents>();
  const abortController = new AbortController();

  const combinedSignal = options.signal
    ? AbortSignal.any([options.signal, abortController.signal])
    : abortController.signal;

  const loopOptions: RunOptions = {
    ...options,
    signal: combinedSignal,
  };

  // Defer the loop start to the next microtask so callers can attach listeners first.
  const result = Promise.resolve().then(() => executeLoop(loopOptions, emitter));

  function abort(reason?: string): void {
    abortController.abort(reason);
  }

  function complete(): void {
    emitter.complete();
  }

  return {
    result,
    abort,
    addEventListener: emitter.addEventListener.bind(emitter) as ActiveRun['addEventListener'],
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
