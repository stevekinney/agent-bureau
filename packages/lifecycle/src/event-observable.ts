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

export interface EventObservableOptions {
  signal?: AbortSignal;
}

/**
 * Returns a TC39-style Observable for events of the given type
 * from a native EventTarget.
 *
 * The observable completes when the AbortSignal fires or the
 * subscription is unsubscribed.
 */
export function eventObservable<E extends Event>(
  target: EventTarget,
  type: string,
  options?: EventObservableOptions,
): ObservableLike<E> {
  return {
    subscribe(
      observerOrNext?: Observer<E> | ((value: E) => void),
      error?: (err: unknown) => void,
      complete?: () => void,
    ): Subscription {
      const observer: Observer<E> =
        typeof observerOrNext === 'function'
          ? { next: observerOrNext, error, complete }
          : (observerOrNext ?? {});

      const controller = new AbortController();
      let closed = false;

      const subscription: Subscription = {
        unsubscribe() {
          if (closed) return;
          closed = true;
          controller.abort();
          observer.complete?.();
        },
        get closed() {
          return closed;
        },
      };

      observer.start?.(subscription);

      // If start() synchronously unsubscribed, don't add any listener
      if (closed) return subscription;

      function onEvent(event: Event): void {
        observer.next?.(event as E);
      }

      // Combine with external signal if provided
      const combinedSignal = options?.signal
        ? AbortSignal.any([options.signal, controller.signal])
        : controller.signal;

      target.addEventListener(type, onEvent, { signal: combinedSignal });

      // When the combined signal fires (from external abort),
      // mark as closed and call complete
      if (options?.signal) {
        options.signal.addEventListener(
          'abort',
          () => {
            if (!closed) {
              closed = true;
              observer.complete?.();
            }
          },
          { once: true },
        );
      }

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
export function allEventsObservable<E extends Event>(
  target: EventTarget,
  eventTypes: readonly string[],
  options?: EventObservableOptions,
): ObservableLike<E> {
  return {
    subscribe(
      observerOrNext?: Observer<E> | ((value: E) => void),
      error?: (err: unknown) => void,
      complete?: () => void,
    ): Subscription {
      const observer: Observer<E> =
        typeof observerOrNext === 'function'
          ? { next: observerOrNext, error, complete }
          : (observerOrNext ?? {});

      const controller = new AbortController();
      let closed = false;

      const subscription: Subscription = {
        unsubscribe() {
          if (closed) return;
          closed = true;
          controller.abort();
          observer.complete?.();
        },
        get closed() {
          return closed;
        },
      };

      observer.start?.(subscription);
      if (closed) return subscription;

      function onEvent(event: Event): void {
        observer.next?.(event as E);
      }

      const combinedSignal = options?.signal
        ? AbortSignal.any([options.signal, controller.signal])
        : controller.signal;

      for (const type of eventTypes) {
        target.addEventListener(type, onEvent, { signal: combinedSignal });
      }

      if (options?.signal) {
        options.signal.addEventListener(
          'abort',
          () => {
            if (!closed) {
              closed = true;
              observer.complete?.();
            }
          },
          { once: true },
        );
      }

      return subscription;
    },
  };
}
