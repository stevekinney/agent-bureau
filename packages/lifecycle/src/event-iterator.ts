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
export function eventIterator<E extends Event>(
  target: EventTarget,
  type: string,
  options?: EventIteratorOptions,
): AsyncIterableIterator<E> {
  const bufferSize = options?.bufferSize ?? 256;
  const signal = options?.signal;

  const queue: E[] = [];
  let resolve: ((value: IteratorResult<E>) => void) | null = null;
  let done = false;

  function onEvent(event: Event): void {
    const typed = event as E;
    if (resolve) {
      const pending = resolve;
      resolve = null;
      pending({ value: typed, done: false });
    } else if (queue.length < bufferSize) {
      queue.push(typed);
    }
  }

  function cleanup(): void {
    if (done) return;
    done = true;
    target.removeEventListener(type, onEvent);
    if (resolve) {
      const pending = resolve;
      resolve = null;
      pending({ value: undefined as unknown as E, done: true });
    }
  }

  // If signal is already aborted, mark done immediately
  if (signal?.aborted) {
    done = true;
  } else {
    target.addEventListener(type, onEvent);
    signal?.addEventListener('abort', cleanup, { once: true });
  }

  const iterator: AsyncIterableIterator<E> = {
    next(): Promise<IteratorResult<E>> {
      if (queue.length > 0) {
        return Promise.resolve({ value: queue.shift()!, done: false });
      }
      if (done) {
        return Promise.resolve({ value: undefined as unknown as E, done: true });
      }
      return new Promise<IteratorResult<E>>((_resolve) => {
        resolve = _resolve;
      });
    },

    return(): Promise<IteratorResult<E>> {
      cleanup();
      return Promise.resolve({ value: undefined as unknown as E, done: true });
    },

    [Symbol.asyncIterator]() {
      return this;
    },
  };

  return iterator;
}
