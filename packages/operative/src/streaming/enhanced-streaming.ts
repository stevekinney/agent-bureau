import type { TypedEventTarget } from 'lifecycle';

import type {
  GenerateContext,
  GenerateFunction,
  GenerateResponse,
  StreamingGenerateFunction,
  StreamingHandle,
} from '../types';
import { cancelStreamingIfActive } from './cancel-streaming';
import { createStreamStateMachine } from './stream-state-machine';
import type {
  EnhancedStreamingOptions,
  LiveStreamEvent,
  StreamBlock,
  StreamEvent,
  StreamEventMap,
} from './types';
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
 * Tool-call events are reconstructed from the resolved `GenerateResponse` by
 * default, which means they land after the provider response has closed. Set
 * `liveToolCalls` to install `StreamingHandle.report` instead, so an adapter
 * that reports tool calls as it sees them — Anthropic and OpenAI both do —
 * surfaces them while the response is still open. The reconstruction stays as
 * the fallback for any streaming function that reports nothing.
 *
 * The existing `withStreaming()` remains unchanged — this is a separate,
 * opt-in wrapper.
 */
export function withEnhancedStreaming(
  fn: StreamingGenerateFunction,
  options: EnhancedStreamingOptions = {},
): GenerateFunction {
  const { eventTarget, onTextDelta, onToolCallStart, onToolCallDelta, liveToolCalls } = options;

  return async (context: GenerateContext): Promise<GenerateResponse> => {
    const { conversation } = context;
    const stateMachine = createStreamStateMachine();

    const messageId = conversation.appendStreamingMessage('assistant');
    const textBlockId = `text-${messageId}`;

    let previousContent = '';

    /**
     * Tool-call blocks the wrapped function reported live, in arrival order.
     * Non-empty means the live path ran, so the reconstruct-on-resolve path
     * must stay out of the way.
     */
    const reportedToolCalls: Array<{ blockId: string; toolName: string }> = [];

    /**
     * Looks a tracked block up by id.
     *
     * Every event payload below identifies its block this way rather than
     * reading `activeBlock`, because a tool block can open while the text
     * block is still accumulating — OpenAI interleaves `delta.content` and
     * `delta.tool_calls` — and the most recently started block would then be
     * the wrong one to describe in a text event. Call sites that have just
     * processed a `block-start` for the id assert the result with `!`.
     */
    function findBlock(id: string): StreamBlock | undefined {
      return stateMachine.getState().blocks.find((block) => block.id === id);
    }

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
              id: textBlockId,
              blockType: 'text',
            });

            emitEvent(eventTarget, 'stream:block-start', {
              type: 'stream:block-start',
              block: { ...findBlock(textBlockId)! },
            });
          }

          stateMachine.process({
            type: 'block-delta',
            id: textBlockId,
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
            block: { ...findBlock(textBlockId)! },
            delta,
          });
        }
      },
    };

    /**
     * Opens a reported tool-call block and emits its start events.
     *
     * Shared by the reported `stream:tool-call-start` and by a delta that
     * arrives for a block no start was reported for — see `handle.report`.
     */
    function startToolCallBlock(blockId: string, toolName: string): void {
      reportedToolCalls.push({ blockId, toolName });

      stateMachine.process({
        type: 'block-start',
        id: blockId,
        blockType: 'tool-call',
        toolName,
      });

      emitEvent(eventTarget, 'stream:block-start', {
        type: 'stream:block-start',
        block: { ...findBlock(blockId)! },
      });

      onToolCallStart?.(toolName);

      emitEvent(eventTarget, 'stream:tool-call-start', {
        type: 'stream:tool-call-start',
        toolName,
        blockId,
      });
    }

    if (liveToolCalls) {
      handle.report = (event: LiveStreamEvent): void => {
        if (event.type === 'stream:tool-call-start') {
          startToolCallBlock(event.blockId, event.toolName);
          return;
        }

        // A delta for a block that never started. The state machine would no-op
        // and the emitted payload would describe a block that does not exist,
        // so open it first: `report` is public surface, and a hand-written
        // `StreamingGenerateFunction` can reach here by reporting out of order.
        if (!findBlock(event.blockId)) {
          startToolCallBlock(event.blockId, event.toolName);
        }

        // `partialArguments` is cumulative, so diff it against what the state
        // machine already holds to recover the incremental fragment — the same
        // shape `update` uses for text.
        const accumulated = findBlock(event.blockId)?.partialArguments ?? '';
        const delta = event.partialArguments.slice(accumulated.length);

        stateMachine.process({
          type: 'block-delta',
          id: event.blockId,
          delta,
        });

        emitEvent(eventTarget, 'stream:block-delta', {
          type: 'stream:block-delta',
          block: { ...findBlock(event.blockId)! },
          delta,
        });

        onToolCallDelta?.(event.toolName, event.partialArguments);

        emitEvent(eventTarget, 'stream:tool-call-delta', event);
      };
    }

    try {
      const response = await fn({ ...context, streaming: handle });

      // Complete the text block if one was started
      if (previousContent.length > 0) {
        stateMachine.process({
          type: 'block-complete',
          id: textBlockId,
        });

        const completedTextBlock = findBlock(textBlockId);
        if (completedTextBlock) {
          emitEvent(eventTarget, 'stream:block-complete', {
            type: 'stream:block-complete',
            block: { ...completedTextBlock },
          });
        }
      }

      if (reportedToolCalls.length > 0) {
        // The live path already emitted start and delta for each block. All
        // that is left is the completion, whose parsed `arguments` only exist
        // now — paired with the reported block at the same ordinal position,
        // since adapters report and resolve tool calls in the same order.
        // A response with fewer tool calls than were reported means the caller
        // aborted mid-stream and the adapter dropped the truncated calls; those
        // blocks stay open rather than being completed with invented arguments.
        for (const [index, reported] of reportedToolCalls.entries()) {
          const toolCall = response.toolCalls[index];
          if (!toolCall) break;

          stateMachine.process({
            type: 'block-complete',
            id: reported.blockId,
          });

          const completedToolBlock = findBlock(reported.blockId);
          if (completedToolBlock) {
            emitEvent(eventTarget, 'stream:block-complete', {
              type: 'stream:block-complete',
              block: { ...completedToolBlock },
            });
          }

          emitEvent(eventTarget, 'stream:tool-call-complete', {
            type: 'stream:tool-call-complete',
            // The resolved response is authoritative for the name; the reported
            // one is the fallback for a streaming function that reported a
            // block the response then left unnamed.
            toolName: toolCall.name || reported.toolName,
            blockId: reported.blockId,
            arguments: toolCall.arguments,
          });
        }
      } else if (response.toolCalls.length > 0) {
        // Nothing was reported live: reconstruct the whole tool-call event
        // sequence from the resolved response.
        for (let i = 0; i < response.toolCalls.length; i++) {
          const toolCall = response.toolCalls[i]!;
          const toolBlockId = `tool-${toolCall.name}-${i}-${messageId}`;
          const toolName = toolCall.name;

          stateMachine.process({
            type: 'block-start',
            id: toolBlockId,
            blockType: 'tool-call',
            toolName,
          });

          emitEvent(eventTarget, 'stream:block-start', {
            type: 'stream:block-start',
            block: { ...findBlock(toolBlockId)! },
          });

          onToolCallStart?.(toolName);

          emitEvent(eventTarget, 'stream:tool-call-start', {
            type: 'stream:tool-call-start',
            toolName,
            blockId: toolBlockId,
          });

          const argsString =
            toolCall.arguments === undefined
              ? ''
              : typeof toolCall.arguments === 'string'
                ? toolCall.arguments
                : JSON.stringify(toolCall.arguments);

          stateMachine.process({
            type: 'block-delta',
            id: toolBlockId,
            delta: argsString,
          });

          emitEvent(eventTarget, 'stream:block-delta', {
            type: 'stream:block-delta',
            block: { ...findBlock(toolBlockId)! },
            delta: argsString,
          });

          onToolCallDelta?.(toolName, argsString);

          emitEvent(eventTarget, 'stream:tool-call-delta', {
            type: 'stream:tool-call-delta',
            toolName,
            blockId: toolBlockId,
            partialArguments: argsString,
          });

          stateMachine.process({
            type: 'block-complete',
            id: toolBlockId,
          });

          const completedToolBlock = findBlock(toolBlockId);
          if (completedToolBlock) {
            emitEvent(eventTarget, 'stream:block-complete', {
              type: 'stream:block-complete',
              block: { ...completedToolBlock },
            });
          }

          emitEvent(eventTarget, 'stream:tool-call-complete', {
            type: 'stream:tool-call-complete',
            toolName,
            blockId: toolBlockId,
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
