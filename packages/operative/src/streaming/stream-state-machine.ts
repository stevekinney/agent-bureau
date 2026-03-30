import type { TokenUsage } from 'conversationalist';

import type { StreamBlock, StreamCommand, StreamState, StreamStateMachine } from './types';

/**
 * Creates a state machine that tracks block-level progress through an LLM stream.
 *
 * The machine processes commands (block-start, block-delta, block-complete, set-usage,
 * complete) and maintains a read-only snapshot of the current stream state including
 * active blocks, aggregated text content, filtered tool calls, and completion status.
 */
export function createStreamStateMachine(): StreamStateMachine {
  let blocks: StreamBlock[] = [];
  let usage: TokenUsage | undefined;
  let complete = false;

  function findBlock(id: string): StreamBlock | undefined {
    return blocks.find((block) => block.id === id);
  }

  function computeActiveBlock(): StreamBlock | undefined {
    // Walk backwards to find the most recently started incomplete block
    for (let i = blocks.length - 1; i >= 0; i--) {
      const block = blocks[i];
      if (block && !block.complete) return block;
    }
    return undefined;
  }

  function computeTextContent(): string {
    return blocks
      .filter((block) => block.type === 'text')
      .map((block) => block.content)
      .join('');
  }

  function computeToolCalls(): ReadonlyArray<StreamBlock> {
    return blocks.filter((block) => block.type === 'tool-call');
  }

  function buildState(): StreamState {
    return {
      blocks: [...blocks],
      activeBlock: computeActiveBlock(),
      textContent: computeTextContent(),
      toolCalls: computeToolCalls(),
      complete,
      usage,
    };
  }

  function process(command: StreamCommand): StreamState {
    switch (command.type) {
      case 'block-start': {
        const block: StreamBlock = {
          id: command.id,
          type: command.blockType,
          index: blocks.length,
          content: '',
          complete: false,
          toolName: command.toolName,
          partialArguments: command.blockType === 'tool-call' ? '' : undefined,
        };
        blocks.push(block);
        break;
      }

      case 'block-delta': {
        const block = findBlock(command.id);
        if (!block) break;
        block.content += command.delta;
        if (block.type === 'tool-call') {
          block.partialArguments = (block.partialArguments ?? '') + command.delta;
        }
        break;
      }

      case 'block-complete': {
        const block = findBlock(command.id);
        if (!block) break;
        block.complete = true;
        break;
      }

      case 'set-usage': {
        usage = { ...command.usage };
        break;
      }

      case 'complete': {
        complete = true;
        break;
      }
    }

    return buildState();
  }

  function getState(): StreamState {
    return buildState();
  }

  function reset(): void {
    blocks = [];
    usage = undefined;
    complete = false;
  }

  return { process, getState, reset };
}
