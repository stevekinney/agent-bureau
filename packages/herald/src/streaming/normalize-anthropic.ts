import type { StreamBlock, StreamEvent, StreamState } from 'operative';

import type { AnthropicStreamEvent } from '../types';

/**
 * Normalizes an Anthropic Messages API streaming response into a
 * provider-agnostic AsyncIterable of StreamEvents.
 *
 * Consumes `content_block_start`, `content_block_delta`, `content_block_stop`,
 * `message_start`, `message_delta`, and `message_stop` events and produces
 * the unified streaming pipeline events.
 */
export async function* normalizeAnthropicStream(
  stream: AsyncIterable<AnthropicStreamEvent>,
): AsyncIterable<StreamEvent> {
  const blocks: StreamBlock[] = [];
  /** Map from Anthropic index → our block id */
  const indexToBlockId = new Map<number, string>();
  /** Map from block id → tool name for tool-call blocks */
  const blockToolNames = new Map<string, string>();
  /** Accumulated text for stream:text-delta events */
  let accumulatedText = '';
  /** Accumulated partial args per block */
  const blockPartialArgs = new Map<string, string>();

  let promptTokens = 0;
  let completionTokens = 0;

  function findBlock(id: string): StreamBlock | undefined {
    return blocks.find((b) => b.id === id);
  }

  function buildState(): StreamState {
    return {
      blocks: [...blocks],
      activeBlock: [...blocks].reverse().find((b) => !b.complete),
      textContent: blocks
        .filter((b) => b.type === 'text')
        .map((b) => b.content)
        .join(''),
      toolCalls: blocks.filter((b) => b.type === 'tool-call'),
      complete: false,
      usage: {
        prompt: promptTokens,
        completion: completionTokens,
        total: promptTokens + completionTokens,
      },
    };
  }

  for await (const event of stream) {
    switch (event.type) {
      case 'message_start': {
        if (event.message?.usage) {
          promptTokens = event.message.usage.input_tokens ?? 0;
          completionTokens = event.message.usage.output_tokens ?? 0;
          yield {
            type: 'stream:usage',
            usage: {
              prompt: promptTokens,
              completion: completionTokens,
              total: promptTokens + completionTokens,
            },
          };
        }
        break;
      }

      case 'content_block_start': {
        const index = event.index ?? blocks.length;
        const contentBlock = event.content_block;
        const blockId = contentBlock?.id ?? `block-${index}`;
        const rawType = contentBlock?.type ?? 'text';

        let blockType: StreamBlock['type'] = 'text';
        if (rawType === 'tool_use') blockType = 'tool-call';
        else if (rawType === 'thinking') blockType = 'thinking';
        else if (rawType !== 'text') blockType = 'metadata';

        const toolName = contentBlock?.name;

        const block: StreamBlock = {
          id: blockId,
          type: blockType,
          index: blocks.length,
          content: '',
          complete: false,
          toolName,
          partialArguments: blockType === 'tool-call' ? '' : undefined,
        };

        blocks.push(block);
        indexToBlockId.set(index, blockId);
        if (toolName) blockToolNames.set(blockId, toolName);

        yield { type: 'stream:block-start', block: { ...block } };

        if (blockType === 'tool-call' && toolName) {
          yield { type: 'stream:tool-call-start', toolName, blockId };
        }
        break;
      }

      case 'content_block_delta': {
        const index = event.index ?? 0;
        const blockId = indexToBlockId.get(index);
        if (!blockId) break;

        const block = findBlock(blockId);
        if (!block) break;

        const deltaType = event.delta?.type;
        const textDelta = event.delta?.text;
        const jsonDelta = event.delta?.partial_json;

        if (deltaType === 'text_delta' && textDelta) {
          block.content += textDelta;
          accumulatedText += textDelta;

          yield {
            type: 'stream:block-delta',
            block: { ...block },
            delta: textDelta,
          };
          yield {
            type: 'stream:text-delta',
            content: textDelta,
            accumulated: accumulatedText,
          };
        } else if (deltaType === 'input_json_delta' && jsonDelta) {
          block.content += jsonDelta;
          block.partialArguments = (block.partialArguments ?? '') + jsonDelta;

          const accumulated = (blockPartialArgs.get(blockId) ?? '') + jsonDelta;
          blockPartialArgs.set(blockId, accumulated);

          const toolName = blockToolNames.get(blockId) ?? '';

          yield {
            type: 'stream:block-delta',
            block: { ...block },
            delta: jsonDelta,
          };
          yield {
            type: 'stream:tool-call-delta',
            toolName,
            partialArguments: accumulated,
          };
        } else if (deltaType === 'thinking_delta' && textDelta) {
          block.content += textDelta;

          yield {
            type: 'stream:block-delta',
            block: { ...block },
            delta: textDelta,
          };
        }
        break;
      }

      case 'content_block_stop': {
        const index = event.index ?? 0;
        const blockId = indexToBlockId.get(index);
        if (!blockId) break;

        const block = findBlock(blockId);
        if (!block) break;

        block.complete = true;

        yield { type: 'stream:block-complete', block: { ...block } };

        if (block.type === 'tool-call') {
          const toolName = blockToolNames.get(blockId) ?? '';
          const args = blockPartialArgs.get(blockId) ?? '';
          let parsedArgs: unknown = args;
          try {
            parsedArgs = JSON.parse(args);
          } catch {
            // Keep as string if not valid JSON
          }
          yield {
            type: 'stream:tool-call-complete',
            toolName,
            arguments: parsedArgs,
          };
        }
        break;
      }

      case 'message_delta': {
        if (event.usage?.output_tokens !== undefined) {
          completionTokens = event.usage.output_tokens;
          yield {
            type: 'stream:usage',
            usage: {
              prompt: promptTokens,
              completion: completionTokens,
              total: promptTokens + completionTokens,
            },
          };
        }
        break;
      }

      case 'message_stop': {
        const finalState: StreamState = {
          ...buildState(),
          complete: true,
        };
        yield { type: 'stream:complete', state: finalState };
        break;
      }
    }
  }
}
