import {
  type ConversationEnvironment,
  simpleTokenEstimator,
} from '../environment';
import { Conversation, type ConversationEvent } from '../history';
import { createConversationHistory } from '../conversation';
import type {
  ConversationHistory,
  MessagePlugin,
  TokenEstimator,
} from '../types';

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

export function createTestConversation(
  initial?: ConversationHistory,
  options: TestConversationEnvironmentOptions = {},
): Conversation {
  const environment = createTestConversationEnvironment(options);
  return new Conversation(initial ?? createConversationHistory(undefined, environment), environment);
}

export type ConversationRecorder = {
  events: ConversationEvent[];
  clear: () => void;
};

export function createConversationRecorder(
  conversation: Conversation,
): ConversationRecorder {
  const events: ConversationEvent[] = [];
  const subscriptions = [
    conversation.addEventListener('change', (event: ConversationEvent) => {
      events.push(event);
    }),
    conversation.addEventListener('push', (event: ConversationEvent) => {
      events.push(event);
    }),
    conversation.addEventListener('undo', (event: ConversationEvent) => {
      events.push(event);
    }),
  ];

  return {
    events,
    clear: () => {
      events.length = 0;
    },
    [Symbol.dispose]: () => {
      subscriptions.forEach((unsubscribe) => unsubscribe?.());
    },
  } as ConversationRecorder;
}
