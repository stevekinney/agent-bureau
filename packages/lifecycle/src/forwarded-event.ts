import type { ObservableLike } from './event-observable';

/**
 * A wrapper event that preserves the original event while creating
 * a new event type string (typically prefixed).
 *
 * Example: a ToolboxCallEvent with type 'call' becomes a
 * ForwardedEvent with type 'toolbox.call' and originalEvent
 * pointing to the ToolboxCallEvent.
 */
export class ForwardedEvent<TOriginal extends Event = Event> extends Event {
  readonly originalEvent: TOriginal;

  constructor(type: string, originalEvent: TOriginal) {
    super(type);
    this.originalEvent = originalEvent;
  }
}

export interface ForwardableSource {
  toObservable(): ObservableLike<Event>;
}

/**
 * Creates a forwarding subscription that listens to all events on
 * `source` (via toObservable) and dispatches ForwardedEvent instances
 * on `target` with the given prefix.
 *
 * Returns an object with a stop() method to halt forwarding.
 */
export function forwardEvents(
  source: ForwardableSource,
  target: EventTarget,
  prefix: string,
  options?: { signal?: AbortSignal },
): { stop(): void } {
  const subscription = source.toObservable().subscribe({
    next(event: Event) {
      const forwarded = new ForwardedEvent(`${prefix}.${event.type}`, event);
      target.dispatchEvent(forwarded);
    },
  });

  const signal = options?.signal;
  const abortHandler = () => {
    subscription.unsubscribe();
  };

  signal?.addEventListener('abort', abortHandler, { once: true });

  return {
    stop() {
      subscription.unsubscribe();
      signal?.removeEventListener('abort', abortHandler);
    },
  };
}
