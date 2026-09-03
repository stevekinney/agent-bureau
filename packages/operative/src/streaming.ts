import {
  readBackendDescriptors,
  withBackendDescriptors,
} from './providers/backend-descriptor-attachment';
import { cancelStreamingIfActive } from './streaming/cancel-streaming';
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
 *
 * Propagates `fn`'s attached `BackendDescriptor`(s) (AB-64, AB-245) onto the
 * returned wrapper — without this, `createAgent({ generate:
 * withStreaming(createOpenAIProviderStream(...)) })`, the documented way to
 * use a streaming provider factory as an Agent's `generate`, would silently
 * lose the descriptor the factory attached and report `mode: 'opaque'`.
 */
export function withStreaming(fn: StreamingGenerateFunction): GenerateFunction {
  const wrapped: GenerateFunction = async (context: GenerateContext): Promise<GenerateResponse> => {
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

      return { ...response, messageAppended: true };
    } catch (error) {
      cancelStreamingIfActive(conversation, messageId);
      throw error;
    }
  };

  return withBackendDescriptors(wrapped, readBackendDescriptors(fn));
}
