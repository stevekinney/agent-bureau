import type { EventMap, TypedEventTarget } from './typed-event-target';

export interface EventIteratorOptions {
  signal?: AbortSignal;
  bufferSize?: number;
}

/**
 * Returns an AsyncIterableIterator that yields events of the given type
 * from a native EventTarget.
 *
 * The iterator terminates when:
 * - The AbortSignal fires
 * - The caller calls iterator.return()
 *
 * Uses a pull-based queue: events are buffered until the consumer calls next().
 */
export function eventIterator<M extends EventMap, K extends keyof M & string>(
  target: TypedEventTarget<M>,
  type: K,
  options?: EventIteratorOptions,
): AsyncIterableIterator<M[K]>;
export function eventIterator(
  target: EventTarget,
  type: string,
  options?: EventIteratorOptions,
): AsyncIterableIterator<Event>;
export function eventIterator(
  target: EventTarget,
  type: string,
  options?: EventIteratorOptions,
): AsyncIterableIterator<Event> {
  const bufferSize = options?.bufferSize ?? 256;
  const signal = options?.signal;

  const queue: Event[] = [];
  let resolve: ((value: IteratorResult<Event>) => void) | null = null;
  let done = false;

  function onEvent(event: Event): void {
    if (resolve) {
      const pending = resolve;
      resolve = null;
      pending({ value: event, done: false });
    } else if (queue.length < bufferSize) {
      queue.push(event);
    }
  }

  function cleanup(): void {
    if (done) return;
    done = true;
    target.removeEventListener(type, onEvent);
    if (resolve) {
      const pending = resolve;
      resolve = null;
      pending({ value: undefined, done: true });
    }
  }

  // If signal is already aborted, mark done immediately
  if (signal?.aborted) {
    done = true;
  } else {
    target.addEventListener(type, onEvent);
    signal?.addEventListener('abort', cleanup, { once: true });
  }

  const iterator: AsyncIterableIterator<Event> = {
    next(): Promise<IteratorResult<Event>> {
      if (queue.length > 0) {
        return Promise.resolve({ value: queue.shift()!, done: false });
      }
      if (done) {
        return Promise.resolve({ value: undefined, done: true });
      }
      return new Promise<IteratorResult<Event>>((_resolve) => {
        resolve = _resolve;
      });
    },

    return(): Promise<IteratorResult<Event>> {
      cleanup();
      return Promise.resolve({ value: undefined, done: true });
    },

    [Symbol.asyncIterator]() {
      return this;
    },
  };

  return iterator;
}
