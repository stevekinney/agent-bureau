import { eventIterator, type EventIteratorOptions } from './event-iterator';
import {
  eventObservable,
  type EventObservableOptions,
  type ObservableLike,
  type Observer,
  type Subscription,
} from './event-observable';
import { type EventMap, TypedEventTarget } from './typed-event-target';

/**
 * A TypedEventTarget with:
 * - AbortController-based completion (replaces event-emission's complete()/completed)
 * - Convenience methods: on(), once(), subscribe(), toObservable(), events()
 * - An internal dispatch hook for toObservable() to capture all events
 *
 * This is the primary base class that replaces createEventTarget<E>().
 */
export class CompletableEventTarget<M extends EventMap> extends TypedEventTarget<M> {
  readonly #controller = new AbortController();
  readonly #allEventListeners = new Set<(event: Event) => void>();

  get completed(): boolean {
    return this.#controller.signal.aborted;
  }

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  complete(): void {
    if (!this.#controller.signal.aborted) {
      this.#controller.abort();
    }
  }

  /**
   * Override dispatchEvent to also push to toObservable() subscribers.
   * This is the single interception point — dispatch() calls this
   * via super, so both typed and untyped dispatches are captured.
   */
  override dispatchEvent(event: Event): boolean {
    const result = super.dispatchEvent(event);
    for (const listener of this.#allEventListeners) {
      listener(event);
    }
    return result;
  }

  /**
   * Returns an ObservableLike for a single event type.
   */
  on<K extends keyof M & string>(type: K, options?: EventObservableOptions): ObservableLike<M[K]> {
    return eventObservable<M[K]>(this, type, {
      signal: options?.signal ?? this.signal,
    });
  }

  /**
   * Registers a one-shot listener using the native { once: true } option.
   */
  once<K extends keyof M & string>(type: K, listener: (event: M[K]) => void): void {
    this.addEventListener(type, listener, { once: true });
  }

  /**
   * TC39 Observable subscribe shorthand for a single event type.
   */
  subscribe<K extends keyof M & string>(
    type: K,
    observerOrNext?: Observer<M[K]> | ((value: M[K]) => void),
    error?: (err: unknown) => void,
    complete?: () => void,
  ): Subscription {
    const observable = this.on(type);
    return observable.subscribe(observerOrNext, error, complete);
  }

  /**
   * Returns an ObservableLike that emits ALL dispatched events.
   * Replaces event-emission's toObservable().
   */
  toObservable(): ObservableLike<M[keyof M & string]> {
    return {
      subscribe: (
        observerOrNext?: Observer<M[keyof M & string]> | ((value: M[keyof M & string]) => void),
        error?: (err: unknown) => void,
        complete?: () => void,
      ): Subscription => {
        const observer: Observer<M[keyof M & string]> =
          typeof observerOrNext === 'function'
            ? { next: observerOrNext, error, complete }
            : (observerOrNext ?? {});

        let closed = false;

        const onEvent = (event: Event) => {
          if (!closed) {
            observer.next?.(event as M[keyof M & string]);
          }
        };

        this.#allEventListeners.add(onEvent);

        const onAbort = () => {
          if (!closed) {
            closed = true;
            this.#allEventListeners.delete(onEvent);
            observer.complete?.();
          }
        };

        this.signal.addEventListener('abort', onAbort, { once: true });

        return {
          unsubscribe: () => {
            if (closed) return;
            closed = true;
            this.#allEventListeners.delete(onEvent);
            observer.complete?.();
          },
          get closed() {
            return closed;
          },
        };
      },
    };
  }

  /**
   * Returns an AsyncIterableIterator for events of the given type.
   * Replaces event-emission's events('type').
   */
  events<K extends keyof M & string>(
    type: K,
    options?: EventIteratorOptions,
  ): AsyncIterableIterator<M[K]> {
    return eventIterator<M[K]>(this, type, {
      signal: options?.signal ?? this.signal,
      bufferSize: options?.bufferSize,
    });
  }
}
