import { eventIterator, type EventIteratorOptions } from './event-iterator';
import {
  eventObservable,
  type EventObservableOptions,
  type ObservableLike,
  type Observer,
  type Subscription,
} from './event-observable';
import { type EventMap, TypedEventTarget } from './typed-event-target';

function toObserver<T>(
  observerOrNext: Observer<T> | ((value: T) => void) | undefined,
  error: ((err: unknown) => void) | undefined,
  complete: (() => void) | undefined,
): Observer<T> {
  if (typeof observerOrNext !== 'function') return observerOrNext ?? {};
  const observer: Observer<T> = { next: observerOrNext };
  if (error) observer.error = error;
  if (complete) observer.complete = complete;
  return observer;
}

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
    return eventObservable(this, type, {
      signal: options?.signal ?? this.signal,
    });
  }

  /**
   * Registers a one-shot listener using the native { once: true } option.
   * The listener is tied to this target's completion signal so that calling
   * complete() removes the listener if the event never fires.
   */
  once<K extends keyof M & string>(type: K, listener: (event: M[K]) => void): void {
    this.addEventListener(type, listener, { once: true, signal: this.signal });
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
        const observer = toObserver(observerOrNext, error, complete);

        let closed = false;

        let onAbort: (() => void) | undefined;
        const onEvent = (event: Event): void => {
          if (!closed && observer.next) {
            Reflect.apply(observer.next, observer, [event]);
          }
        };

        const close = (): void => {
          if (closed) return;
          closed = true;
          this.#allEventListeners.delete(onEvent);
          if (onAbort) this.signal.removeEventListener('abort', onAbort);
          observer.complete?.();
        };

        const subscription: Subscription = {
          unsubscribe: close,
          get closed() {
            return closed;
          },
        };

        observer.start?.(subscription);
        if (closed) return subscription;
        if (this.signal.aborted) {
          close();
          return subscription;
        }

        this.#allEventListeners.add(onEvent);

        onAbort = close;

        this.signal.addEventListener('abort', onAbort, { once: true });

        return subscription;
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
    return eventIterator(this, type, {
      signal: options?.signal ?? this.signal,
      ...(options?.bufferSize === undefined ? {} : { bufferSize: options.bufferSize }),
    });
  }
}
