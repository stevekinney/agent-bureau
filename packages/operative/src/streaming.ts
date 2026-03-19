import type { Conversation } from 'conversationalist';

import type {
  GenerateContext,
  GenerateFunction,
  GenerateResponse,
  StreamingGenerateFunction,
  StreamingHandle,
} from './types';

/**
 * Wraps a streaming generate function into a standard GenerateFunction.
 *
 * The wrapper manages the streaming lifecycle on the Conversation:
 * appendStreamingMessage → updateStreamingMessage → finalizeStreamingMessage.
 */
export function withStreaming(fn: StreamingGenerateFunction): GenerateFunction {
  return async (context: GenerateContext): Promise<GenerateResponse> => {
    const { conversation } = context;

    const messageId = conversation.appendStreamingMessage('assistant');

    const handle: StreamingHandle = {
      messageId,
      update(content: string): void {
        conversation.updateStreamingMessage(messageId, content);
      },
    };

    try {
      const response = await fn({ ...context, streaming: handle });

      conversation.finalizeStreamingMessage(messageId, {
        tokenUsage: response.usage,
        metadata: response.metadata,
      });

      return response;
    } catch (error) {
      cancelStreamingIfActive(conversation, messageId);
      throw error;
    }
  };
}

function cancelStreamingIfActive(conversation: Conversation, messageId: string): void {
  const message = conversation.getStreamingMessage();
  if (message && message.id === messageId) {
    conversation.cancelStreamingMessage(messageId);
  }
}
