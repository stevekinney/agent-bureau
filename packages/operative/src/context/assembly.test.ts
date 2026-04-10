import { describe, expect, it } from 'bun:test';
import type { JSONValue } from 'conversationalist';
import { Conversation } from 'conversationalist';

import { createContextAssembler } from './assembly';
import { createTokenBudget } from './token-budget';

function buildConversation(
  messages: Array<{
    role: 'system' | 'user' | 'assistant' | 'tool-call' | 'tool-result';
    content: string;
    hidden?: boolean;
    metadata?: Record<string, JSONValue>;
    toolCall?: { id: string; name: string; arguments: string };
    toolResult?: {
      callId: string;
      content: string;
      outcome: 'success' | 'error' | 'action_required';
    };
  }>,
): Conversation {
  const conversation = new Conversation();
  for (const msg of messages) {
    switch (msg.role) {
      case 'system': {
        conversation.appendSystemMessage(msg.content, msg.metadata);

        break;
      }
      case 'user': {
        conversation.appendUserMessage(msg.content, msg.metadata);

        break;
      }
      case 'assistant': {
        conversation.appendAssistantMessage(msg.content, msg.metadata);

        break;
      }
      default:
        if (msg.role === 'tool-call' && msg.toolCall) {
          conversation.appendToolCalls([msg.toolCall]);
        } else if (msg.role === 'tool-result' && msg.toolResult) {
          conversation.appendToolResults([msg.toolResult]);
        }
    }
  }
  return conversation;
}

describe('createContextAssembler', () => {
  const assembler = createContextAssembler();

  it('always includes system messages', () => {
    const conversation = buildConversation([
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi' },
    ]);

    const budget = createTokenBudget({ maxTokens: 100000 });
    const result = assembler({ conversation, budget });

    const systemMessages = result.messages.filter((m) => m.role === 'system');
    expect(systemMessages.length).toBe(1);
    expect(systemMessages[0]?.content).toBe('You are a helpful assistant.');
  });

  it('always includes the most recent N messages', () => {
    const conversation = buildConversation([
      { role: 'system', content: 'System' },
      { role: 'user', content: 'M1' },
      { role: 'assistant', content: 'R1' },
      { role: 'user', content: 'M2' },
      { role: 'assistant', content: 'R2' },
      { role: 'user', content: 'M3' },
      { role: 'assistant', content: 'R3' },
    ]);

    const budget = createTokenBudget({ maxTokens: 100000 });
    const result = assembler({ conversation, budget, recentMessageCount: 4 });

    const nonSystem = result.messages.filter((m) => m.role !== 'system');
    // Should include the 4 most recent non-system messages
    expect(nonSystem.length).toBeGreaterThanOrEqual(4);
    expect(nonSystem[nonSystem.length - 1]?.content).toBe('R3');
    expect(nonSystem[nonSystem.length - 2]?.content).toBe('M3');
  });

  it('includes messages with pending tool results', () => {
    const conversation = buildConversation([
      { role: 'system', content: 'System' },
      { role: 'user', content: 'Old message' },
      { role: 'assistant', content: 'Old response' },
      {
        role: 'tool-call',
        content: '',
        toolCall: { id: 'pending-1', name: 'compute', arguments: '{}' },
      },
      { role: 'user', content: 'Recent 1' },
      { role: 'assistant', content: 'Recent 2' },
    ]);

    const budget = createTokenBudget({ maxTokens: 100000 });
    const result = assembler({ conversation, budget, recentMessageCount: 2 });

    const toolCalls = result.messages.filter((m) => m.role === 'tool-call');
    expect(toolCalls.length).toBe(1);
  });

  it('excludes hidden messages', () => {
    const conversation = buildConversation([
      { role: 'system', content: 'System' },
      { role: 'user', content: 'Visible' },
      { role: 'assistant', content: 'Response' },
    ]);

    // Redact a message to make it hidden
    conversation.redactMessageAtPosition(1);

    const budget = createTokenBudget({ maxTokens: 100000 });
    const result = assembler({ conversation, budget });

    // The hidden message should be excluded
    const hiddenMessages = result.messages.filter((m) => m.hidden);
    expect(hiddenMessages.length).toBe(0);
  });

  it('returns accurate budget report', () => {
    const conversation = buildConversation([
      { role: 'system', content: 'System prompt' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there' },
    ]);

    const budget = createTokenBudget({ maxTokens: 100000 });
    const result = assembler({ conversation, budget });

    expect(result.budgetReport.systemTokens).toBeGreaterThan(0);
    expect(result.budgetReport.historyTokens).toBeGreaterThan(0);
    expect(result.budgetReport.totalTokens).toBe(
      result.budgetReport.systemTokens +
        result.budgetReport.historyTokens +
        result.budgetReport.retrievedTokens,
    );
    expect(result.budgetReport.remainingTokens).toBe(
      budget.maxTokens - result.budgetReport.totalTokens,
    );
  });

  it('handles empty conversation', () => {
    const conversation = new Conversation();
    const budget = createTokenBudget({ maxTokens: 100000 });
    const result = assembler({ conversation, budget });

    expect(result.messages.length).toBe(0);
    expect(result.budgetReport.totalTokens).toBe(0);
    expect(result.budgetReport.remainingTokens).toBe(100000);
  });

  it('handles conversation shorter than recentMessageCount', () => {
    const conversation = buildConversation([
      { role: 'system', content: 'System' },
      { role: 'user', content: 'Hello' },
    ]);

    const budget = createTokenBudget({ maxTokens: 100000 });
    const result = assembler({ conversation, budget, recentMessageCount: 10 });

    // Should include all messages
    expect(result.messages.length).toBe(2);
  });

  it('includes retrieved messages when budget allows', () => {
    const conversation = buildConversation([
      { role: 'system', content: 'System' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi' },
    ]);

    const budget = createTokenBudget({ maxTokens: 100000 });
    const retrievedMessages = [
      {
        id: 'retrieved-1',
        role: 'user' as const,
        content: 'Retrieved context',
        position: 0,
        createdAt: new Date().toISOString(),
        metadata: {},
        hidden: false,
      },
    ];

    const result = assembler({ conversation, budget, retrievedMessages });

    expect(result.budgetReport.retrievedTokens).toBeGreaterThan(0);
    expect(result.messages.some((m) => m.content === 'Retrieved context')).toBe(true);
  });

  it('defaults recentMessageCount to 4', () => {
    const conversation = buildConversation([
      { role: 'system', content: 'System' },
      { role: 'user', content: 'M1' },
      { role: 'assistant', content: 'R1' },
      { role: 'user', content: 'M2' },
      { role: 'assistant', content: 'R2' },
      { role: 'user', content: 'M3' },
      { role: 'assistant', content: 'R3' },
      { role: 'user', content: 'M4' },
      { role: 'assistant', content: 'R4' },
    ]);

    const budget = createTokenBudget({ maxTokens: 100000 });
    const result = assembler({ conversation, budget });

    // All messages fit in budget so all should be included
    expect(result.messages.length).toBe(9);
  });

  it('estimates non-string tool result content using its JSON representation', () => {
    const conversation = new Conversation();
    const estimatedTexts: string[] = [];

    conversation.appendUserMessage('Use the tool');
    conversation.appendToolCalls([{ id: 'call-1', name: 'lookup', arguments: '{}' }]);
    conversation.appendToolResults([
      {
        callId: 'call-1',
        outcome: 'success',
        content: { answer: 42, status: 'ok' },
      },
    ]);

    const budget = createTokenBudget({ maxTokens: 100000 });
    const result = assembler({
      conversation,
      budget,
      tokenEstimator: (text) => {
        estimatedTexts.push(text);
        return text.length;
      },
    });

    expect(estimatedTexts).toContain(JSON.stringify({ answer: 42, status: 'ok' }));
    expect(result.budgetReport.historyTokens).toBeGreaterThan(0);
  });

  it('uses the default token estimator when the budget does not provide one', () => {
    const conversation = new Conversation();
    conversation.appendUserMessage('abcd');

    const result = assembler({
      conversation,
      budget: {
        maxTokens: 100,
        allocate: () => 100,
      } as never,
    });

    expect(result.budgetReport.historyTokens).toBe(1);
  });
});
