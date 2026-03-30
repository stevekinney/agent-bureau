import type { StreamBlock, StreamEvent, StreamState } from 'operative';

import type { OpenAIChatCompletionChunk } from '../types';
import type { NormalizerState } from './stream-helpers';
import { buildState, findBlock } from './stream-helpers';

/** Tracked state for an in-progress OpenAI tool call. */
type ToolCallTracker = {
  blockId: string;
  toolName: string;
  arguments: string;
};

/**
 * Normalizes an OpenAI Chat Completions streaming response into a
 * provider-agnostic AsyncIterable of StreamEvents.
 *
 * Handles `delta.content` for text, `delta.tool_calls` for tool calls,
 * `finish_reason` for completion, and `usage` for token tracking.
 */
export async function* normalizeOpenAIStream(
  stream: AsyncIterable<OpenAIChatCompletionChunk>,
): AsyncIterable<StreamEvent> {
  const state: NormalizerState = {
    blocks: [],
    hasUsageData: false,
    promptTokens: undefined,
    completionTokens: undefined,
  };
  const { blocks } = state;
  /** Map from OpenAI tool call index → our tracker */
  const toolTrackers = new Map<number, ToolCallTracker>();

  let accumulatedText = '';
  let textBlockId: string | undefined;

  for await (const chunk of stream) {
    // Handle usage before checking for choices — OpenAI sends a final
    // usage-only chunk with choices: [] when stream_options.include_usage
    // is enabled.
    if (chunk.usage) {
      state.hasUsageData = true;
      state.promptTokens = chunk.usage.prompt_tokens ?? 0;
      state.completionTokens = chunk.usage.completion_tokens ?? 0;
      yield {
        type: 'stream:usage',
        usage: {
          prompt: state.promptTokens,
          completion: state.completionTokens,
          total: chunk.usage.total_tokens ?? state.promptTokens + state.completionTokens,
        },
      };
    }

    const choice = chunk.choices[0];
    if (!choice) continue;

    const { delta, finish_reason } = choice;

    // Handle text content
    if (delta.content !== undefined && delta.content !== null && delta.content !== '') {
      // Lazily create a text block
      if (!textBlockId) {
        textBlockId = `text-${blocks.length}`;
        const block: StreamBlock = {
          id: textBlockId,
          type: 'text',
          index: blocks.length,
          content: '',
          complete: false,
        };
        blocks.push(block);
        yield { type: 'stream:block-start', block: { ...block } };
      }

      const block = findBlock(blocks, textBlockId);
      if (block) {
        block.content += delta.content;
        accumulatedText += delta.content;

        yield {
          type: 'stream:block-delta',
          block: { ...block },
          delta: delta.content,
        };
        yield {
          type: 'stream:text-delta',
          content: delta.content,
          accumulated: accumulatedText,
        };
      }
    }

    // Handle tool calls
    if (delta.tool_calls) {
      for (const toolCall of delta.tool_calls) {
        const { index } = toolCall;
        let tracker = toolTrackers.get(index);

        if (!tracker && toolCall.id && toolCall.function?.name) {
          // New tool call
          const blockId = toolCall.id;
          const toolName = toolCall.function.name;

          tracker = { blockId, toolName, arguments: '' };
          toolTrackers.set(index, tracker);

          const block: StreamBlock = {
            id: blockId,
            type: 'tool-call',
            index: blocks.length,
            content: '',
            complete: false,
            toolName,
            partialArguments: '',
          };
          blocks.push(block);

          yield { type: 'stream:block-start', block: { ...block } };
          yield { type: 'stream:tool-call-start', toolName, blockId };
        }

        if (tracker && toolCall.function?.arguments) {
          const args = toolCall.function.arguments;
          tracker.arguments += args;

          const block = findBlock(blocks, tracker.blockId);
          if (block) {
            block.content += args;
            block.partialArguments = tracker.arguments;
          }

          yield {
            type: 'stream:block-delta',
            block: block
              ? { ...block }
              : {
                  id: tracker.blockId,
                  type: 'tool-call',
                  index: 0,
                  content: tracker.arguments,
                  complete: false,
                  toolName: tracker.toolName,
                  partialArguments: tracker.arguments,
                },
            delta: args,
          };
          yield {
            type: 'stream:tool-call-delta',
            toolName: tracker.toolName,
            partialArguments: tracker.arguments,
          };
        }
      }
    }

    // Handle finish — complete blocks immediately but defer the
    // stream:complete event until after the loop so that a trailing
    // usage-only chunk (OpenAI's stream_options.include_usage) is captured.
    if (finish_reason) {
      // Complete the text block if one exists
      if (textBlockId) {
        const textBlock = findBlock(blocks, textBlockId);
        if (textBlock) {
          textBlock.complete = true;
          yield { type: 'stream:block-complete', block: { ...textBlock } };
        }
      }

      // Complete all tool call blocks
      for (const [, tracker] of toolTrackers) {
        const block = findBlock(blocks, tracker.blockId);
        if (block) {
          block.complete = true;
          yield { type: 'stream:block-complete', block: { ...block } };
        }

        let parsedArgs: unknown = tracker.arguments;
        try {
          parsedArgs = JSON.parse(tracker.arguments);
        } catch {
          // Keep as string if not valid JSON
        }
        yield {
          type: 'stream:tool-call-complete',
          toolName: tracker.toolName,
          arguments: parsedArgs,
        };
      }
    }
  }

  // Emit stream:complete after the loop so any trailing usage-only chunk
  // has been processed and buildState() includes the final usage data.
  const finalState: StreamState = {
    ...buildState(state),
    complete: true,
  };
  yield { type: 'stream:complete', state: finalState };
}
