import { createTestToolbox } from 'armorer/test';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';

import { noToolCalls } from '../src/conditions/predicates';
import { createRun } from '../src/create-run';
import { run } from '../src/run';
import { createMockGenerate, createRunRecorder } from '../src/test/index';
import type { GenerateResponse } from '../src/types';

function textResponse(content: string): GenerateResponse {
  return { content, toolCalls: [] };
}

describe('context window management', () => {
  it('calls onCompact when tokens exceed threshold', async () => {
    let compacted = false;
    const conversation = new Conversation();
    // Pre-fill conversation to exceed threshold
    conversation.appendUserMessage('A'.repeat(500));

    const generate = createMockGenerate([textResponse('Done')]);

    const result = await run({
      generate,
      toolbox: createTestToolbox([]),
      conversation,
      stopWhen: noToolCalls(),
      contextManagement: {
        maxTokens: 10,
        onCompact: async (conv) => {
          compacted = true;
          // Simulate compaction — no-op in test, but we record it was called
        },
      },
    });

    expect(compacted).toBe(true);
    expect(result.finishReason).toBe('stop-condition');
  });

  it('does not call onCompact when under threshold', async () => {
    let compacted = false;
    const conversation = new Conversation();

    const generate = createMockGenerate([textResponse('Short')]);

    await run({
      generate,
      toolbox: createTestToolbox([]),
      conversation,
      stopWhen: noToolCalls(),
      contextManagement: {
        maxTokens: 100000,
        onCompact: async () => {
          compacted = true;
        },
      },
    });

    expect(compacted).toBe(false);
  });

  it('uses custom token estimator', async () => {
    let estimatorCalled = false;
    const conversation = new Conversation();
    conversation.appendUserMessage('Hello');

    const generate = createMockGenerate([textResponse('Done')]);

    await run({
      generate,
      toolbox: createTestToolbox([]),
      conversation,
      stopWhen: noToolCalls(),
      contextManagement: {
        maxTokens: 5,
        tokenEstimator: (conv) => {
          estimatorCalled = true;
          return 100; // Always over threshold
        },
        onCompact: async () => {
          // Compaction happens
        },
      },
    });

    expect(estimatorCalled).toBe(true);
  });

  it('emits context.compacted event with before/after token counts', async () => {
    const conversation = new Conversation();
    conversation.appendUserMessage('A'.repeat(400));

    let estimateCount = 0;
    const generate = createMockGenerate([textResponse('Done')]);

    const activeRun = createRun({
      generate,
      toolbox: createTestToolbox([]),
      conversation,
      stopWhen: noToolCalls(),
      contextManagement: {
        maxTokens: 10,
        tokenEstimator: () => {
          estimateCount++;
          // First call: over threshold; second call (after compaction): under
          return estimateCount === 1 ? 100 : 5;
        },
        onCompact: async () => {
          // Simulate compaction
        },
      },
    });

    const recorder = createRunRecorder(activeRun);
    await activeRun.result;

    const compactEvents = recorder.events.filter((e) => e.type === 'context.compacted');
    expect(compactEvents).toHaveLength(1);
    const detail = compactEvents[0].detail as {
      tokensBefore: number;
      tokensAfter: number;
    };
    expect(detail.tokensBefore).toBe(100);
    expect(detail.tokensAfter).toBe(5);
  });

  it('terminates the loop when onCompact throws', async () => {
    const conversation = new Conversation();
    conversation.appendUserMessage('A'.repeat(400));

    const generate = createMockGenerate([textResponse('Done')]);

    const result = await run({
      generate,
      toolbox: createTestToolbox([]),
      conversation,
      stopWhen: noToolCalls(),
      contextManagement: {
        maxTokens: 10,
        onCompact: async () => {
          throw new Error('Compaction failed');
        },
      },
    });

    expect(result.finishReason).toBe('error');
  });
});
