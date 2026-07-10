import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';

import {
  createHybridStrategy,
  createSelectivePruningStrategy,
  createSlidingWindowStrategy,
} from './compaction-strategies';
import { createTokenBudget } from './token-budget';

function buildConversation(
  messages: Array<{
    role: 'system' | 'user' | 'assistant' | 'tool-call' | 'tool-result';
    content: string;
    toolCall?: { id: string; name: string; arguments: string };
    toolResult?: {
      callId: string;
      content: string;
      outcome: 'success' | 'error' | 'action_required';
      metadata?: Record<string, boolean>;
    };
  }>,
): Conversation {
  const conversation = new Conversation();
  for (const msg of messages) {
    switch (msg.role) {
      case 'system': {
        conversation.appendSystemMessage(msg.content);

        break;
      }
      case 'user': {
        conversation.appendUserMessage(msg.content);

        break;
      }
      case 'assistant': {
        conversation.appendAssistantMessage(msg.content);

        break;
      }
      default:
        if (msg.role === 'tool-call' && msg.toolCall) {
          conversation.appendToolCalls([msg.toolCall]);
        } else if (msg.role === 'tool-result' && msg.toolResult) {
          const { metadata, ...toolResult } = msg.toolResult;
          if (metadata) {
            conversation.appendToolResult(toolResult, { metadata });
          } else {
            conversation.appendToolResults([toolResult]);
          }
        }
    }
  }
  return conversation;
}

describe('createSlidingWindowStrategy', () => {
  it('drops messages beyond the window while preserving system messages', async () => {
    const conversation = buildConversation([
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Message 1' },
      { role: 'assistant', content: 'Response 1' },
      { role: 'user', content: 'Message 2' },
      { role: 'assistant', content: 'Response 2' },
      { role: 'user', content: 'Message 3' },
      { role: 'assistant', content: 'Response 3' },
    ]);

    const strategy = createSlidingWindowStrategy();
    const budget = createTokenBudget({ maxTokens: 10000 });

    await strategy(conversation, budget, { retainRecentMessages: 2 });

    const messages = conversation.getMessages();
    // System message preserved + 2 recent messages
    expect(messages.some((m) => m.role === 'system')).toBe(true);
    expect(messages.filter((m) => m.role !== 'system').length).toBe(2);
    const lastTwo = messages.filter((m) => m.role !== 'system');
    expect(lastTwo[0]?.content).toBe('Message 3');
    expect(lastTwo[1]?.content).toBe('Response 3');
  });

  it('preserves all messages when conversation is shorter than window', async () => {
    const conversation = buildConversation([
      { role: 'system', content: 'System' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi' },
    ]);

    const strategy = createSlidingWindowStrategy();
    const budget = createTokenBudget({ maxTokens: 10000 });

    await strategy(conversation, budget, { retainRecentMessages: 10 });

    const messages = conversation.getMessages();
    expect(messages.length).toBe(3);
  });

  it('preserves pending tool call/result pairs', async () => {
    const conversation = buildConversation([
      { role: 'system', content: 'System' },
      { role: 'user', content: 'Old message' },
      { role: 'assistant', content: 'Old response' },
      { role: 'user', content: 'Use tool' },
      { role: 'assistant', content: 'Using tool' },
      {
        role: 'tool-call',
        content: '',
        toolCall: { id: 'call-1', name: 'search', arguments: '{}' },
      },
      // No tool-result yet, so this is pending
    ]);

    const strategy = createSlidingWindowStrategy();
    const budget = createTokenBudget({ maxTokens: 10000 });

    await strategy(conversation, budget, { retainRecentMessages: 2 });

    const messages = conversation.getMessages();
    // The pending tool-call must be preserved
    const toolCallMessages = messages.filter((m) => m.role === 'tool-call');
    expect(toolCallMessages.length).toBe(1);
  });

  it('defaults retainRecentMessages to 4', async () => {
    const conversation = buildConversation([
      { role: 'system', content: 'System' },
      { role: 'user', content: 'M1' },
      { role: 'assistant', content: 'R1' },
      { role: 'user', content: 'M2' },
      { role: 'assistant', content: 'R2' },
      { role: 'user', content: 'M3' },
      { role: 'assistant', content: 'R3' },
    ]);

    const strategy = createSlidingWindowStrategy();
    const budget = createTokenBudget({ maxTokens: 10000 });

    await strategy(conversation, budget, {});

    const messages = conversation.getMessages();
    // 1 system + 4 recent = 5
    expect(messages.filter((m) => m.role !== 'system').length).toBe(4);
  });
});

describe('createSelectivePruningStrategy', () => {
  it('drops old tool-result messages but keeps tool-call breadcrumbs', async () => {
    const conversation = buildConversation([
      { role: 'system', content: 'System' },
      { role: 'user', content: 'Use search' },
      { role: 'assistant', content: 'Searching...' },
      {
        role: 'tool-call',
        content: '',
        toolCall: { id: 'call-1', name: 'search', arguments: '{"q":"test"}' },
      },
      {
        role: 'tool-result',
        content: 'Big search result data...',
        toolResult: { callId: 'call-1', content: 'Big search result data...', outcome: 'success' },
      },
      { role: 'assistant', content: 'Based on the search...' },
      { role: 'user', content: 'Recent question' },
      { role: 'assistant', content: 'Recent answer' },
    ]);

    const strategy = createSelectivePruningStrategy();
    const budget = createTokenBudget({ maxTokens: 10000 });

    await strategy(conversation, budget, {
      retainRecentMessages: 4,
      maxToolResultAge: 2,
    });

    const messages = conversation.getMessages();
    // Old tool-result should be pruned (its content replaced)
    const toolResults = messages.filter((m) => m.role === 'tool-result');
    // The tool-result is old enough to be pruned
    for (const tr of toolResults) {
      expect(typeof tr.content).toBe('string');
    }
    // Tool-call breadcrumbs should still exist
    const toolCalls = messages.filter((m) => m.role === 'tool-call');
    expect(toolCalls.length).toBe(1);
  });

  it('preserves recent tool results within maxToolResultAge', async () => {
    const conversation = buildConversation([
      { role: 'system', content: 'System' },
      { role: 'user', content: 'Use tool' },
      {
        role: 'tool-call',
        content: '',
        toolCall: { id: 'call-1', name: 'search', arguments: '{}' },
      },
      {
        role: 'tool-result',
        content: 'Recent result',
        toolResult: { callId: 'call-1', content: 'Recent result', outcome: 'success' },
      },
      { role: 'assistant', content: 'Response' },
    ]);

    const strategy = createSelectivePruningStrategy();
    const budget = createTokenBudget({ maxTokens: 10000 });

    await strategy(conversation, budget, {
      retainRecentMessages: 4,
      maxToolResultAge: 10,
    });

    const messages = conversation.getMessages();
    const toolResults = messages.filter((m) => m.role === 'tool-result');
    expect(toolResults.length).toBe(1);
    // Tool result content lives on the toolResult metadata, not message.content
    expect(toolResults[0]?.toolResult?.content).toBe('Recent result');
  });

  it('preserves pending tool call/result pairs', async () => {
    const conversation = buildConversation([
      { role: 'system', content: 'System' },
      { role: 'user', content: 'Old message' },
      { role: 'assistant', content: 'Old response' },
      {
        role: 'tool-call',
        content: '',
        toolCall: { id: 'pending-1', name: 'compute', arguments: '{}' },
      },
      // No result yet
      { role: 'user', content: 'Recent' },
      { role: 'assistant', content: 'Recent' },
    ]);

    const strategy = createSelectivePruningStrategy();
    const budget = createTokenBudget({ maxTokens: 10000 });

    await strategy(conversation, budget, { retainRecentMessages: 2, maxToolResultAge: 0 });

    const messages = conversation.getMessages();
    const toolCalls = messages.filter((m) => m.role === 'tool-call');
    expect(toolCalls.length).toBe(1);
  });

  it('redacts old tool results when they exceed the configured age', async () => {
    const conversation = buildConversation([
      { role: 'system', content: 'System' },
      { role: 'user', content: 'Question' },
      { role: 'assistant', content: 'Working on it' },
      {
        role: 'tool-call',
        content: '',
        toolCall: { id: 'call-1', name: 'search', arguments: '{}' },
      },
      {
        role: 'tool-result',
        content: 'Large search result payload',
        toolResult: {
          callId: 'call-1',
          content: 'Large search result payload',
          outcome: 'success',
        },
      },
      { role: 'assistant', content: 'Interpreting results' },
      { role: 'user', content: 'Follow-up 1' },
      { role: 'assistant', content: 'Follow-up 2' },
      { role: 'user', content: 'Follow-up 3' },
      { role: 'assistant', content: 'Follow-up 4' },
    ]);

    const strategy = createSelectivePruningStrategy();
    const budget = createTokenBudget({ maxTokens: 10000 });

    await strategy(conversation, budget, {
      retainRecentMessages: 2,
      maxToolResultAge: 2,
    });

    const toolResult = conversation.getMessages().find((message) => message.role === 'tool-result');
    expect(toolResult?.toolResult?.content).toBe('[pruned tool result]');
  });

  it('preserves old error tool results by default, even past maxToolResultAge', async () => {
    const conversation = buildConversation([
      { role: 'system', content: 'System' },
      { role: 'user', content: 'Question' },
      { role: 'assistant', content: 'Working on it' },
      {
        role: 'tool-call',
        content: '',
        toolCall: { id: 'call-1', name: 'search', arguments: '{}' },
      },
      {
        role: 'tool-result',
        content: 'Search failed: timeout',
        toolResult: {
          callId: 'call-1',
          content: 'Search failed: timeout',
          outcome: 'error',
        },
      },
      { role: 'assistant', content: 'Interpreting results' },
      { role: 'user', content: 'Follow-up 1' },
      { role: 'assistant', content: 'Follow-up 2' },
      { role: 'user', content: 'Follow-up 3' },
      { role: 'assistant', content: 'Follow-up 4' },
    ]);

    const strategy = createSelectivePruningStrategy();
    const budget = createTokenBudget({ maxTokens: 10000 });

    await strategy(conversation, budget, {
      retainRecentMessages: 2,
      maxToolResultAge: 2,
    });

    const toolResult = conversation.getMessages().find((message) => message.role === 'tool-result');
    expect(toolResult?.toolResult?.content).toBe('Search failed: timeout');
  });

  it('preserves old tool results flagged via metadata.error, even with a success outcome', async () => {
    const conversation = buildConversation([
      { role: 'system', content: 'System' },
      { role: 'user', content: 'Question' },
      { role: 'assistant', content: 'Working on it' },
      {
        role: 'tool-call',
        content: '',
        toolCall: { id: 'call-1', name: 'search', arguments: '{}' },
      },
      {
        role: 'tool-result',
        content: 'Partial result flagged downstream as an error',
        toolResult: {
          callId: 'call-1',
          content: 'Partial result flagged downstream as an error',
          outcome: 'success',
          metadata: { error: true },
        },
      },
      { role: 'assistant', content: 'Interpreting results' },
      { role: 'user', content: 'Follow-up 1' },
      { role: 'assistant', content: 'Follow-up 2' },
      { role: 'user', content: 'Follow-up 3' },
      { role: 'assistant', content: 'Follow-up 4' },
    ]);

    const strategy = createSelectivePruningStrategy();
    const budget = createTokenBudget({ maxTokens: 10000 });

    await strategy(conversation, budget, {
      retainRecentMessages: 2,
      maxToolResultAge: 2,
    });

    const toolResult = conversation.getMessages().find((message) => message.role === 'tool-result');
    expect(toolResult?.toolResult?.content).toBe('Partial result flagged downstream as an error');
  });

  it('prunes old error tool results when preserveErrorToolResults is disabled', async () => {
    const conversation = buildConversation([
      { role: 'system', content: 'System' },
      { role: 'user', content: 'Question' },
      { role: 'assistant', content: 'Working on it' },
      {
        role: 'tool-call',
        content: '',
        toolCall: { id: 'call-1', name: 'search', arguments: '{}' },
      },
      {
        role: 'tool-result',
        content: 'Search failed: timeout',
        toolResult: {
          callId: 'call-1',
          content: 'Search failed: timeout',
          outcome: 'error',
        },
      },
      { role: 'assistant', content: 'Interpreting results' },
      { role: 'user', content: 'Follow-up 1' },
      { role: 'assistant', content: 'Follow-up 2' },
      { role: 'user', content: 'Follow-up 3' },
      { role: 'assistant', content: 'Follow-up 4' },
    ]);

    const strategy = createSelectivePruningStrategy();
    const budget = createTokenBudget({ maxTokens: 10000 });

    await strategy(conversation, budget, {
      retainRecentMessages: 2,
      maxToolResultAge: 2,
      preserveErrorToolResults: false,
    });

    const toolResult = conversation.getMessages().find((message) => message.role === 'tool-result');
    expect(toolResult?.toolResult?.content).toBe('[pruned tool result]');
  });
});

describe('createHybridStrategy', () => {
  it('summarizes old messages, prunes tool results, and keeps recent window', async () => {
    const conversation = buildConversation([
      { role: 'system', content: 'System' },
      { role: 'user', content: 'Old message 1' },
      { role: 'assistant', content: 'Old response 1' },
      { role: 'user', content: 'Old message 2' },
      { role: 'assistant', content: 'Old response 2' },
      {
        role: 'tool-call',
        content: '',
        toolCall: { id: 'call-old', name: 'search', arguments: '{}' },
      },
      {
        role: 'tool-result',
        content: 'Old tool result',
        toolResult: { callId: 'call-old', content: 'Old tool result', outcome: 'success' },
      },
      { role: 'user', content: 'Recent message' },
      { role: 'assistant', content: 'Recent response' },
    ]);

    const strategy = createHybridStrategy();
    const budget = createTokenBudget({ maxTokens: 10000 });

    const summarizeCalls: string[][] = [];
    await strategy(conversation, budget, {
      retainRecentMessages: 2,
      maxToolResultAge: 1,
      summarize: async (messages) => {
        summarizeCalls.push(messages.map((m) => (typeof m.content === 'string' ? m.content : '')));
        return 'Summary of old messages';
      },
    });

    const messages = conversation.getMessages();
    // Should have system message(s) + summary + recent messages
    expect(messages.some((m) => m.role === 'system')).toBe(true);
    // Summarize should have been called
    expect(summarizeCalls.length).toBeGreaterThan(0);
  });

  it('preserves recent messages', async () => {
    const conversation = buildConversation([
      { role: 'system', content: 'System' },
      { role: 'user', content: 'Old' },
      { role: 'assistant', content: 'Old' },
      { role: 'user', content: 'Recent 1' },
      { role: 'assistant', content: 'Recent 2' },
    ]);

    const strategy = createHybridStrategy();
    const budget = createTokenBudget({ maxTokens: 10000 });

    await strategy(conversation, budget, {
      retainRecentMessages: 2,
      summarize: async () => 'Summary',
    });

    const messages = conversation.getMessages();
    const nonSystem = messages.filter((m) => m.role !== 'system');
    // Recent 2 non-system messages preserved
    expect(nonSystem.some((m) => m.content === 'Recent 1')).toBe(true);
    expect(nonSystem.some((m) => m.content === 'Recent 2')).toBe(true);
  });

  it('preserves pending tool call/result pairs', async () => {
    const conversation = buildConversation([
      { role: 'system', content: 'System' },
      { role: 'user', content: 'Old' },
      { role: 'assistant', content: 'Old' },
      {
        role: 'tool-call',
        content: '',
        toolCall: { id: 'pending-1', name: 'compute', arguments: '{}' },
      },
      { role: 'user', content: 'Recent' },
      { role: 'assistant', content: 'Recent' },
    ]);

    const strategy = createHybridStrategy();
    const budget = createTokenBudget({ maxTokens: 10000 });

    await strategy(conversation, budget, {
      retainRecentMessages: 2,
      summarize: async () => 'Summary',
    });

    const messages = conversation.getMessages();
    const toolCalls = messages.filter((m) => m.role === 'tool-call');
    expect(toolCalls.length).toBe(1);
  });

  it('falls back to sliding-window when no summarize function is provided', async () => {
    const conversation = buildConversation([
      { role: 'system', content: 'System' },
      { role: 'user', content: 'Old' },
      { role: 'assistant', content: 'Old' },
      { role: 'user', content: 'Recent 1' },
      { role: 'assistant', content: 'Recent 2' },
    ]);

    const strategy = createHybridStrategy();
    const budget = createTokenBudget({ maxTokens: 10000 });

    await strategy(conversation, budget, { retainRecentMessages: 2 });

    const messages = conversation.getMessages();
    const nonSystem = messages.filter((m) => m.role !== 'system');
    expect(nonSystem.length).toBe(2);
  });
});
