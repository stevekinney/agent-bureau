/**
 * A map from event type strings to their corresponding Event subclass.
 */
export type EventMap = Record<string, Event>;

/**
 * Type-safe wrapper around the native EventTarget.
 *
 * Provides typed addEventListener, removeEventListener, and dispatch.
 * Does not wrap or abstract EventTarget — it IS an EventTarget.
 */
export class TypedEventTarget<M extends EventMap> extends EventTarget {
  constructor() {
    super();
  }

  override addEventListener<K extends keyof M & string>(
    type: K,
    listener: ((event: M[K]) => void) | null,
    options?: boolean | AddEventListenerOptions,
  ): void;
  override addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ): void;
  override addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | ((event: never) => void) | null,
    options?: boolean | AddEventListenerOptions,
  ): void {
    super.addEventListener(type, listener as EventListener, options);
  }

  override removeEventListener<K extends keyof M & string>(
    type: K,
    listener: ((event: M[K]) => void) | null,
    options?: boolean | EventListenerOptions,
  ): void;
  override removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions,
  ): void;
  override removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | ((event: never) => void) | null,
    options?: boolean | EventListenerOptions,
  ): void {
    super.removeEventListener(type, listener as EventListener, options);
  }

  /**
   * Type-safe dispatch. Accepts only events whose type is in the map.
   */
  dispatch<K extends keyof M & string>(event: M[K] & { type: K }): boolean {
    return this.dispatchEvent(event);
  }
}
