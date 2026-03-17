import {
  type ConversationEnvironment,
  simpleTokenEstimator,
} from '../environment';
import type { MessagePlugin, TokenEstimator } from '../types';

export interface TestConversationEnvironmentOptions {
  identifiers?: readonly string[];
  now?: string | (() => string);
  estimateTokens?: TokenEstimator;
  plugins?: readonly MessagePlugin[];
  identifierPrefix?: string;
}

export function createTestConversationEnvironment(
  options: TestConversationEnvironmentOptions = {},
): ConversationEnvironment {
  let identifierIndex = 0;
  const identifierPrefix = options.identifierPrefix ?? 'test-id';
  const nowValue = options.now;

  return {
    now:
      typeof nowValue === 'function'
        ? nowValue
        : () => nowValue ?? '2024-01-01T00:00:00.000Z',
    randomId: () => {
      const identifier = options.identifiers?.[identifierIndex];
      identifierIndex += 1;
      return identifier ?? `${identifierPrefix}-${identifierIndex}`;
    },
    estimateTokens: options.estimateTokens ?? simpleTokenEstimator,
    plugins: [...(options.plugins ?? [])],
  };
}

export type TestConversationEnvironment = ReturnType<
  typeof createTestConversationEnvironment
>;
