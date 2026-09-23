import type { CompletableEventTarget, Observer, Subscription } from '@lostgradient/lifecycle';
import { ConversationChangeEvent, type ConversationEventMap } from './events';
import type { ConversationLifecycle, HistoryTransaction } from './history-transaction';
import type { ConversationHistory } from './types';

type ObservationHooks = {
  readonly emitter: CompletableEventTarget<ConversationEventMap>;
  readonly current: () => ConversationHistory;
};

export function createSubscriptionAction(
  emitter: CompletableEventTarget<ConversationEventMap>,
  transaction: HistoryTransaction,
  lifecycle: () => ConversationLifecycle,
): {
  (onStoreChange: () => void): () => void;
  <K extends keyof ConversationEventMap & string>(
    type: K,
    observerOrNext?: Observer<ConversationEventMap[K]> | ((value: ConversationEventMap[K]) => void),
    error?: (err: unknown) => void,
    complete?: () => void,
  ): Subscription;
} {
  function subscribe(onStoreChange: () => void): () => void;
  function subscribe<K extends keyof ConversationEventMap & string>(
    type: K,
    observerOrNext?: Observer<ConversationEventMap[K]> | ((value: ConversationEventMap[K]) => void),
    error?: (err: unknown) => void,
    complete?: () => void,
  ): Subscription;
  function subscribe(
    typeOrListener: (keyof ConversationEventMap & string) | (() => void),
    observerOrNext?:
      | Observer<ConversationEventMap[keyof ConversationEventMap & string]>
      | ((value: ConversationEventMap[keyof ConversationEventMap & string]) => void),
    error?: (err: unknown) => void,
    complete?: () => void,
  ): Subscription | (() => void) {
    if (typeof typeOrListener === 'function')
      return transaction.subscribe(typeOrListener, lifecycle());
    return emitter.subscribe(typeOrListener, observerOrNext, error, complete);
  }
  return subscribe;
}

export function createObservationActions(hooks: ObservationHooks) {
  const watch = (run: (value: ConversationHistory) => void): (() => void) => {
    run(hooks.current());
    const handler = (event: Event) => {
      if (event instanceof ConversationChangeEvent) run(event.conversation);
    };
    hooks.emitter.addEventListener('change', handler);
    return () => hooks.emitter.removeEventListener('change', handler);
  };
  return {
    addEventListener: hooks.emitter.addEventListener.bind(hooks.emitter),
    removeEventListener: hooks.emitter.removeEventListener.bind(hooks.emitter),
    dispatchEvent: (event: Event): boolean => hooks.emitter.dispatchEvent(event),
    watch,
    on: hooks.emitter.on.bind(hooks.emitter),
    once: hooks.emitter.once.bind(hooks.emitter),
    toObservable: hooks.emitter.toObservable.bind(hooks.emitter),
    events: hooks.emitter.events.bind(hooks.emitter),
  };
}
