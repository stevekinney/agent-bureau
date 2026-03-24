import type { EventTargetLike } from 'event-emission';

/**
 * The five standard event-emission methods shared by operative factories.
 */
export type BoundEmitter<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  E extends Record<string, any>,
> = Pick<EventTargetLike<E>, 'addEventListener' | 'on' | 'once' | 'subscribe' | 'toObservable'>;

/**
 * Binds the five standard event-emission methods from an emitter so they can
 * be spread directly onto a return object. This eliminates the repetitive
 * `.bind(emitter) as ...` boilerplate found in multiple operative factories.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function bindEmitter<E extends Record<string, any>>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  emitter: EventTargetLike<any>,
): BoundEmitter<E> {
  return {
    addEventListener: emitter.addEventListener.bind(emitter),
    on: emitter.on.bind(emitter),
    once: emitter.once.bind(emitter),
    subscribe: emitter.subscribe.bind(emitter),
    toObservable: emitter.toObservable.bind(emitter),
  } as BoundEmitter<E>;
}
