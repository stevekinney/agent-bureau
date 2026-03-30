import type { Conversation } from 'conversationalist';
import type { TypedEventTarget } from 'lifecycle';

import type {
  GenerateContext,
  GenerateFunction,
  GenerateResponse,
  StreamingGenerateFunction,
  StreamingHandle,
} from '../types';
import { createStreamStateMachine } from './stream-state-machine';
import type { EnhancedStreamingOptions, StreamEvent, StreamEventMap } from './types';
import { StreamCustomEvent } from './types';

/**
 * Wraps a streaming generate function into a standard GenerateFunction with
 * enhanced observability.
 *
 * Like `withStreaming`, it manages the conversation streaming lifecycle
 * (appendStreamingMessage -> updateStreamingMessage -> finalizeStreamingMessage).
 * In addition, it tracks block-level state via a state machine, fires typed
 * callbacks (`onTextDelta`, `onToolCallStart`, `onToolCallDelta`), and emits
 * structured events on an optional `TypedEventTarget`.
 *
 * The existing `withStreaming()` remains unchanged — this is a separate,
 * opt-in wrapper.
 */
export function withEnhancedStreaming(
  fn: StreamingGenerateFunction,
  options: EnhancedStreamingOptions = {},
): GenerateFunction {
  const { eventTarget, onTextDelta, onToolCallStart, onToolCallDelta } = options;

  return async (context: GenerateContext): Promise<GenerateResponse> => {
    const { conversation } = context;
    const stateMachine = createStreamStateMachine();

    const messageId = conversation.appendStreamingMessage('assistant');

    let previousContent = '';

    const handle: StreamingHandle = {
      messageId,
      update(content: string): void {
        conversation.updateStreamingMessage(messageId, content);

        // Compute the delta from the previous update
        const delta = content.slice(previousContent.length);
        if (delta.length > 0) {
          // If this is the first delta, start a text block
          if (previousContent.length === 0) {
            stateMachine.process({
              type: 'block-start',
              id: `text-${messageId}`,
              blockType: 'text',
            });

            emitEvent(eventTarget, 'stream:block-start', {
              type: 'stream:block-start',
              block: stateMachine.getState().activeBlock!,
            });
          }

          stateMachine.process({
            type: 'block-delta',
            id: `text-${messageId}`,
            delta,
          });

          previousContent = content;

          onTextDelta?.(delta, content);

          emitEvent(eventTarget, 'stream:text-delta', {
            type: 'stream:text-delta',
            content: delta,
            accumulated: content,
          });

          emitEvent(eventTarget, 'stream:block-delta', {
            type: 'stream:block-delta',
            block: stateMachine.getState().activeBlock!,
            delta,
          });
        }
      },
    };

    try {
      const response = await fn({ ...context, streaming: handle });

      // Complete the text block if one was started
      if (previousContent.length > 0) {
        stateMachine.process({
          type: 'block-complete',
          id: `text-${messageId}`,
        });
      }

      // Process tool calls from the response
      if (response.toolCalls.length > 0) {
        for (const toolCall of response.toolCalls) {
          const toolBlockId = `tool-${toolCall.name}-${messageId}`;
          const toolName = toolCall.name;

          stateMachine.process({
            type: 'block-start',
            id: toolBlockId,
            blockType: 'tool-call',
            toolName,
          });

          onToolCallStart?.(toolName);

          emitEvent(eventTarget, 'stream:tool-call-start', {
            type: 'stream:tool-call-start',
            toolName,
            blockId: toolBlockId,
          });

          const argsString =
            typeof toolCall.arguments === 'string'
              ? toolCall.arguments
              : JSON.stringify(toolCall.arguments);

          stateMachine.process({
            type: 'block-delta',
            id: toolBlockId,
            delta: argsString,
          });

          onToolCallDelta?.(toolName, argsString);

          emitEvent(eventTarget, 'stream:tool-call-delta', {
            type: 'stream:tool-call-delta',
            toolName,
            partialArguments: argsString,
          });

          stateMachine.process({
            type: 'block-complete',
            id: toolBlockId,
          });

          emitEvent(eventTarget, 'stream:tool-call-complete', {
            type: 'stream:tool-call-complete',
            toolName,
            arguments: toolCall.arguments,
          });
        }
      }

      // Track usage
      if (response.usage) {
        stateMachine.process({ type: 'set-usage', usage: response.usage });
      }

      // Mark complete
      stateMachine.process({ type: 'complete' });

      const finalState = stateMachine.getState();

      emitEvent(eventTarget, 'stream:complete', {
        type: 'stream:complete',
        state: finalState,
      });

      conversation.finalizeStreamingMessage(messageId, {
        tokenUsage: response.usage,
        metadata: response.metadata,
      });

      return { ...response, messageAppended: true };
    } catch (error) {
      emitEvent(eventTarget, 'stream:error', {
        type: 'stream:error',
        error,
      });

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

function emitEvent<K extends StreamEvent['type']>(
  eventTarget: TypedEventTarget<StreamEventMap> | undefined,
  type: K,
  detail: Extract<StreamEvent, { type: K }>,
): void {
  if (!eventTarget) return;
  const event = new StreamCustomEvent(type, detail);
  // The dispatch method requires a narrowed event type. Since we construct
  // the event with a matching type/detail pair, this cast is safe.
  eventTarget.dispatchEvent(event);
}
