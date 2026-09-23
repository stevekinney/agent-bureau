import {
  type AsyncEstimateConversationTokensOptions,
  type EstimateConversationTokensOptions,
  type EstimateOptions,
  type MaybePromise,
  estimateMessageBlockTokens,
  hasConversationTokenEstimator,
} from './context-blocks';
import type { ConversationEnvironment } from './environment';
import {
  isConversationEnvironmentParameter,
  resolveConversationEnvironment,
  simpleTokenEstimator,
} from './environment';
import type { ConversationHistory as Conversation, TokenEstimator } from './types';
import { getOrderedMessages } from './utilities/message-store';

export { simpleTokenEstimator };
export type { AsyncEstimateConversationTokensOptions, EstimateConversationTokensOptions };

/**
 * Estimates total tokens in a conversation using the provided estimator function.
 * If no estimator is provided, the environment's default estimator is used.
 */
export function estimateConversationTokens(
  conversation: Conversation,
  estimateTokens?: TokenEstimator,
  environment?: Partial<ConversationEnvironment>,
): number;
export function estimateConversationTokens(
  conversation: Conversation,
  options: EstimateConversationTokensOptions,
  environment?: Partial<ConversationEnvironment>,
): number;
export function estimateConversationTokens(
  conversation: Conversation,
  options: AsyncEstimateConversationTokensOptions,
  environment?: Partial<ConversationEnvironment>,
): Promise<number>;
export function estimateConversationTokens(
  conversation: Conversation,
  optionsOrEstimator?: EstimateOptions | TokenEstimator | Partial<ConversationEnvironment>,
  environment?: Partial<ConversationEnvironment>,
): MaybePromise<number> {
  let options: EstimateOptions = {};
  let env = environment;

  if (typeof optionsOrEstimator === 'function') {
    options = { estimateTokens: optionsOrEstimator };
  } else if (optionsOrEstimator) {
    if (
      !environment &&
      !hasConversationTokenEstimator(optionsOrEstimator) &&
      isConversationEnvironmentParameter(optionsOrEstimator)
    ) {
      env = optionsOrEstimator;
    } else {
      options = optionsOrEstimator;
    }
  }

  const resolvedEnvironment = resolveConversationEnvironment(env);
  return estimateMessageBlockTokens(getOrderedMessages(conversation), options, resolvedEnvironment);
}
