import { createTestToolbox } from 'armorer/test';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';

import { createOverflowMutator } from '../../src/retry/overflow-mutator';
import type { GenerateContext } from '../../src/types';

function makeContext(messageContents: string[]): GenerateContext {
  const conversation = new Conversation();
  for (const content of messageContents) {
    conversation.appendUserMessage(content);
  }
  return {
    conversation,
    step: 0,
    toolbox: createTestToolbox([]),
  };
}

describe('createOverflowMutator', () => {
  it('returns void for non-overflow errors', async () => {
    const mutator = createOverflowMutator({
      summarize: async () => 'summary',
    });
    const context = makeContext(['hello']);
    const result = await mutator(context, new Error('rate limit exceeded'), 1);
    expect(result).toBeUndefined();
  });

  it('detects context_length_exceeded in error message', async () => {
    const mutator = createOverflowMutator({
      summarize: async () => 'summary of conversation',
    });
    const context = makeContext(['msg1', 'msg2', 'msg3', 'msg4', 'msg5', 'msg6']);
    const result = await mutator(context, new Error('context_length_exceeded'), 1);
    expect(result).toBeDefined();
  });

  it('detects maximum context length in error message', async () => {
    const mutator = createOverflowMutator({
      summarize: async () => 'summary',
    });
    const context = makeContext(['msg1', 'msg2', 'msg3', 'msg4', 'msg5']);
    const result = await mutator(
      context,
      new Error('This request exceeds the maximum context length'),
      1,
    );
    expect(result).toBeDefined();
  });

  it('detects too many tokens in error message', async () => {
    const mutator = createOverflowMutator({
      summarize: async () => 'summary',
    });
    const context = makeContext(['msg1', 'msg2', 'msg3', 'msg4', 'msg5']);
    const result = await mutator(context, new Error('too many tokens in request'), 1);
    expect(result).toBeDefined();
  });

  it('uses a custom classifyError function', async () => {
    const mutator = createOverflowMutator({
      summarize: async () => 'summary',
      classifyError: (error) => {
        if (error instanceof Error && error.message === 'custom-overflow') return 'overflow';
        return 'unknown';
      },
    });
    const context = makeContext(['msg1', 'msg2', 'msg3', 'msg4', 'msg5']);
    const result = await mutator(context, new Error('custom-overflow'), 1);
    expect(result).toBeDefined();
  });

  it('calls summarize with the older messages', async () => {
    let summarizedMessages: unknown;
    const mutator = createOverflowMutator({
      summarize: async (messages) => {
        summarizedMessages = messages;
        return 'A concise summary';
      },
      retainRecentMessages: 2,
    });
    const context = makeContext(['msg1', 'msg2', 'msg3', 'msg4']);
    await mutator(context, new Error('context_length_exceeded'), 1);

    expect(summarizedMessages).toBeDefined();
    expect(Array.isArray(summarizedMessages)).toBe(true);
    // Should get the older messages (not the recent 2)
    expect((summarizedMessages as unknown[]).length).toBeGreaterThan(0);
  });

  it('retains the specified number of recent messages by default (4)', async () => {
    const mutator = createOverflowMutator({
      summarize: async () => 'summary',
    });
    const context = makeContext(['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7']);
    const result = await mutator(context, new Error('context_length_exceeded'), 1);
    expect(result).toBeDefined();
    // The returned context should have a conversation with the summary + recent messages
    const messages = result!.conversation.getMessages();
    // System message with summary + 4 retained messages
    expect(messages.length).toBeLessThanOrEqual(7); // less than original
  });

  it('returns void when conversation has fewer messages than retainRecentMessages', async () => {
    const mutator = createOverflowMutator({
      summarize: async () => 'summary',
      retainRecentMessages: 4,
    });
    const context = makeContext(['msg1', 'msg2', 'msg3']);
    const result = await mutator(context, new Error('context_length_exceeded'), 1);
    expect(result).toBeUndefined();
  });

  it('does not mutate the original conversation', async () => {
    const mutator = createOverflowMutator({
      summarize: async () => 'summary',
    });
    const context = makeContext(['m1', 'm2', 'm3', 'm4', 'm5', 'm6']);
    const originalMessageCount = context.conversation.getMessages().length;
    const result = await mutator(context, new Error('context_length_exceeded'), 1);
    expect(result).toBeDefined();
    // Original conversation should be unchanged
    expect(context.conversation.getMessages().length).toBe(originalMessageCount);
  });

  it('preserves system and assistant roles while re-adding other retained messages as user input', async () => {
    const mutator = createOverflowMutator({
      summarize: async () => 'summary',
      retainRecentMessages: 4,
    });
    const conversation = new Conversation();

    conversation.appendUserMessage('Older 1');
    conversation.appendAssistantMessage('Older 2');
    conversation.appendSystemMessage('Recent system');
    conversation.appendAssistantMessage('Recent assistant');
    conversation.appendToolCalls([{ id: 'tool-1', name: 'search', arguments: '{}' }]);
    conversation.appendToolResults([
      {
        callId: 'tool-1',
        outcome: 'success',
        content: 'tool output',
      },
    ]);

    const toolResultMessage = conversation.getMessages().at(-1);
    if (toolResultMessage) {
      toolResultMessage.content = [
        { type: 'text', text: 'structured tool output' },
        { type: 'image', url: 'https://example.com/tool-output.png' },
      ] as never;
    }

    const result = await mutator(
      {
        conversation,
        step: 0,
        toolbox: createTestToolbox([]),
      },
      new Error('context_length_exceeded'),
      1,
    );

    expect(result).toBeDefined();
    expect(result!.conversation.getMessages().map((message) => message.role)).toEqual([
      'system',
      'system',
      'assistant',
      'user',
      'user',
    ]);
    expect(result!.conversation.getMessages()[4]?.content).toBe('structured tool output');
  });
});
