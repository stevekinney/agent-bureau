import type { ConversationEnvironment } from './environment';
import { isConversationHistory } from './guards';
import type { ConversationHistory } from './types';

export function createBoundHistoryFunction<T extends unknown[], R>(
  current: () => ConversationHistory,
  environment: () => ConversationEnvironment,
  assertOpen: () => void,
  push: (history: ConversationHistory) => void,
  fn: (conversation: ConversationHistory, ...args: [...T, Partial<ConversationEnvironment>?]) => R,
): (...args: T) => R {
  return (...args: T): R => {
    assertOpen();
    const result = fn(current(), ...args, environment());
    if (isConversationHistory(result)) push(result);
    return result;
  };
}

export type BindAction = {
  readonly bind: <T extends unknown[], R>(
    fn: (
      conversation: ConversationHistory,
      ...args: [...T, Partial<ConversationEnvironment>?]
    ) => R,
  ) => (...args: T) => R;
};

export function createBindAction(
  current: () => ConversationHistory,
  environment: () => ConversationEnvironment,
  assertOpen: () => void,
  push: (history: ConversationHistory) => void,
): BindAction {
  return {
    bind: (fn) => createBoundHistoryFunction(current, environment, assertOpen, push, fn),
  };
}
