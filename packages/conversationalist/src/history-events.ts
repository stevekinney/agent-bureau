import type { ConversationActionType, ConversationEventDetail } from './events';
import type { ConversationHistory, MessagePluginIdentity } from './types';

export type ConversationChangeContext = {
  messageIds?: string[];
  toolCallIds?: string[];
  streamSequence?: number;
  correlationId?: string;
  actor?: string;
  durability?: ConversationEventDetail['durability'];
  outcome?: ConversationEventDetail['outcome'];
  reason?: string;
  childConversationId?: string;
  plugin?: MessagePluginIdentity;
};

function buildEventContextFields(
  context: ConversationChangeContext,
): Pick<
  ConversationEventDetail,
  | 'messageIds'
  | 'toolCallIds'
  | 'actor'
  | 'streamSequence'
  | 'childConversationId'
  | 'plugin'
  | 'reason'
> {
  return {
    ...(context.messageIds && context.messageIds.length > 0
      ? { messageIds: context.messageIds }
      : {}),
    ...(context.toolCallIds && context.toolCallIds.length > 0
      ? { toolCallIds: context.toolCallIds }
      : {}),
    ...(context.actor ? { actor: context.actor } : {}),
    ...(context.streamSequence !== undefined ? { streamSequence: context.streamSequence } : {}),
    ...(context.childConversationId ? { childConversationId: context.childConversationId } : {}),
    ...(context.plugin ? { plugin: context.plugin } : {}),
    ...(context.reason ? { reason: context.reason } : {}),
  };
}

export function buildConversationEventDetail(
  action: ConversationActionType,
  current: ConversationHistory,
  previousConversation: ConversationHistory,
  context: ConversationChangeContext,
  revision: number,
  sequence: number,
): ConversationEventDetail {
  return {
    action,
    conversation: current,
    previousConversation,
    revision,
    sequence,
    correlationId: context.correlationId ?? `${current.id}:event:${sequence}`,
    durability: context.durability ?? 'ephemeral',
    outcome: context.outcome ?? 'accepted',
    ...buildEventContextFields(context),
  };
}
