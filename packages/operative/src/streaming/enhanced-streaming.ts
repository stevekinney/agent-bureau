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

/** One tool-call block a `StreamingGenerateFunction` reported while streaming. */
type ReportedToolCall = { blockId: string; toolName: string };

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
     * Each is paired with a resolved tool call once the response lands; any
     * left over was reported but dropped from the response — a caller aborting
     * mid-stream — and stays open rather than being completed with invented
     * arguments.
     */
    const reportedToolCalls: ReportedToolCall[] = [];

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
          // A delta can arrive before its own start and open the block itself
          // (below). Starting it again would emit duplicate events, push a
          // second `reportedToolCalls` entry, and leave a duplicate state
          // machine block that nothing ever completes.
          if (!findBlock(event.blockId)) startToolCallBlock(event.blockId, event.toolName);
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

      // Pair every resolved tool call with the live block that reported it, if
      // any. Identity first: adapters use the provider's tool-call id as the
      // block id whenever the provider supplied one, so this stays correct even
      // when live starts fired in a different order than the response lists
      // them — OpenAI can hold one parallel call's start waiting for its name
      // while a later index's name has already arrived.
      const unmatchedReported = [...reportedToolCalls];
      const pairings = response.toolCalls.map((toolCall) => {
        const matchIndex =
          toolCall.id === undefined
            ? -1
            : unmatchedReported.findIndex((reported) => reported.blockId === toolCall.id);
        const reported = matchIndex === -1 ? undefined : unmatchedReported.splice(matchIndex, 1)[0];
        return { toolCall, reported };
      });

      // Arrival order is the only remaining signal, and it is trustworthy in
      // exactly one situation: no leftover call carries an id at all (so
      // identity was never available to anyone) and the two sets are the same
      // size (so the correspondence is forced). Pairing positionally outside
      // that — a streaming function reporting only some of its calls, with a
      // synthesized block id — would publish one call's name and arguments on
      // another call's block. An unmatched call is reconstructed instead, which
      // is wrong only in announcing a call twice, never in mislabelling one.
      const unpaired = pairings.filter((pairing) => pairing.reported === undefined);
      const orderIsUnambiguous =
        unpaired.length === unmatchedReported.length &&
        unpaired.every((pairing) => pairing.toolCall.id === undefined);
      if (orderIsUnambiguous) {
        for (const pairing of unpaired) pairing.reported = unmatchedReported.shift();
      }

      for (const [index, { toolCall, reported }] of pairings.entries()) {
        if (reported) {
          // The live path already emitted this block's start and deltas. Only
          // the completion is left, because its parsed `arguments` did not
          // exist until the response resolved.

          // A block may have been started before its name was known. The
          // response is authoritative, so reconcile it before completing —
          // otherwise `stream:block-complete` and the final
          // `stream:complete` state would keep the provisional name even
          // though `stream:tool-call-complete` carries the real one.
          if (toolCall.name && toolCall.name !== reported.toolName) {
            stateMachine.process({
              type: 'set-block-tool-name',
              id: reported.blockId,
              toolName: toolCall.name,
            });
          }

          stateMachine.process({ type: 'block-complete', id: reported.blockId });

          const completedLiveBlock = findBlock(reported.blockId);
          if (completedLiveBlock) {
            emitEvent(eventTarget, 'stream:block-complete', {
              type: 'stream:block-complete',
              block: { ...completedLiveBlock },
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
          continue;
        }

        // Never reported live — either nothing was reported at all, or the
        // streaming function reported only some of its calls. Reconstruct the
        // whole sequence so no call in the response goes unannounced.
        const toolBlockId = `tool-${toolCall.name}-${index}-${messageId}`;
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

        stateMachine.process({ type: 'block-complete', id: toolBlockId });

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
