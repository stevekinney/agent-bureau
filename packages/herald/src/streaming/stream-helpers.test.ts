import { describe, expect, it } from 'bun:test';
import type { StreamBlock } from 'operative';

import { buildState, findBlock } from './stream-helpers';

describe('stream-helpers', () => {
  it('finds a block by id', () => {
    const blocks: StreamBlock[] = [
      { id: 'text-0', type: 'text', index: 0, content: 'Hello', complete: true },
      {
        id: 'call-1',
        type: 'tool-call',
        index: 1,
        content: '{"query":"weather"}',
        complete: false,
        toolName: 'search',
        partialArguments: '{"query":"weather"}',
      },
    ];

    expect(findBlock(blocks, 'call-1')).toEqual(blocks[1]);
    expect(findBlock(blocks, 'missing')).toBeUndefined();
  });

  it('builds state snapshots with usage data', () => {
    const toolBlock: StreamBlock = {
      id: 'call-1',
      type: 'tool-call',
      index: 1,
      content: '{"query":"weather"}',
      complete: false,
      toolName: 'search',
      partialArguments: '{"query":"weather"}',
    };
    const blocks: StreamBlock[] = [
      { id: 'text-0', type: 'text', index: 0, content: 'Hello', complete: true },
      toolBlock,
    ];

    const state = buildState({
      blocks,
      hasUsageData: true,
      promptTokens: 3,
      completionTokens: 4,
    });

    expect(state).toEqual({
      blocks,
      activeBlock: toolBlock,
      textContent: 'Hello',
      toolCalls: [toolBlock],
      complete: false,
      usage: {
        prompt: 3,
        completion: 4,
        total: 7,
      },
    });
  });
});
