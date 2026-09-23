import type { EventMap, TypedEventTarget } from './typed-event-target';

export interface Subscription {
  unsubscribe(): void;
  readonly closed: boolean;
}

export interface Observer<T> {
  start?: (subscription: Subscription) => void;
  next?: (value: T) => void;
  error?: (err: unknown) => void;
  complete?: () => void;
}

export interface ObservableLike<T> {
  subscribe(
    observerOrNext?: Observer<T> | ((value: T) => void),
    error?: (err: unknown) => void,
    complete?: () => void,
  ): Subscription;
}

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

export interface EventObservableOptions {
  signal?: AbortSignal;
}

function attachExternalAbort(
  signal: AbortSignal | undefined,
  controller: AbortController,
  close: () => void,
): AbortSignal {
  const combinedSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  signal?.addEventListener('abort', close, {
    once: true,
    signal: controller.signal,
  });
  return combinedSignal;
}

/**
 * Returns a TC39-style Observable for events of the given type
 * from a native EventTarget.
 *
 * The observable completes when the AbortSignal fires or the
 * subscription is unsubscribed.
 */
export function eventObservable<M extends EventMap, K extends keyof M & string>(
  target: TypedEventTarget<M>,
  type: K,
  options?: EventObservableOptions,
): ObservableLike<M[K]>;
export function eventObservable(
  target: EventTarget,
  type: string,
  options?: EventObservableOptions,
): ObservableLike<Event>;
export function eventObservable(
  target: EventTarget,
  type: string,
  options?: EventObservableOptions,
): ObservableLike<Event> {
  return {
    subscribe(
      observerOrNext?: Observer<Event> | ((value: Event) => void),
      error?: (err: unknown) => void,
      complete?: () => void,
    ): Subscription {
      const observer = toObserver(observerOrNext, error, complete);

      const controller = new AbortController();
      let closed = false;

      const close = (): void => {
        if (closed) return;
        closed = true;
        controller.abort();
        observer.complete?.();
      };

      const subscription: Subscription = {
        unsubscribe: close,
        get closed() {
          return closed;
        },
      };

      observer.start?.(subscription);

      // If start() synchronously unsubscribed, don't add any listener
      if (closed) return subscription;
      if (options?.signal?.aborted) {
        close();
        return subscription;
      }

      function onEvent(event: Event): void {
        observer.next?.(event);
      }

      // Combine with external signal if provided
      const combinedSignal = attachExternalAbort(options?.signal, controller, close);

      target.addEventListener(type, onEvent, { signal: combinedSignal });

      return subscription;
    },
  };
}

/**
 * Returns an ObservableLike that emits ALL events dispatched on a
 * target for the given list of event type strings.
 *
 * Replaces event-emission's toObservable() when used with explicit type lists.
 */
export function allEventsObservable<M extends EventMap, K extends keyof M & string>(
  target: TypedEventTarget<M>,
  eventTypes: readonly K[],
  options?: EventObservableOptions,
): ObservableLike<M[K]>;
export function allEventsObservable(
  target: EventTarget,
  eventTypes: readonly string[],
  options?: EventObservableOptions,
): ObservableLike<Event>;
export function allEventsObservable(
  target: EventTarget,
  eventTypes: readonly string[],
  options?: EventObservableOptions,
): ObservableLike<Event> {
  return {
    subscribe(
      observerOrNext?: Observer<Event> | ((value: Event) => void),
      error?: (err: unknown) => void,
      complete?: () => void,
    ): Subscription {
      const observer = toObserver(observerOrNext, error, complete);

      const controller = new AbortController();
      let closed = false;

      const close = (): void => {
        if (closed) return;
        closed = true;
        controller.abort();
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
      if (options?.signal?.aborted) {
        close();
        return subscription;
      }

      function onEvent(event: Event): void {
        observer.next?.(event);
      }

      const combinedSignal = attachExternalAbort(options?.signal, controller, close);

      for (const type of eventTypes) {
        target.addEventListener(type, onEvent, { signal: combinedSignal });
      }

      return subscription;
    },
  };
}
