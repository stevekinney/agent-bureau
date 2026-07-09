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

describe('createContextAssembler stable-prefix mode', () => {
  const assembler = createContextAssembler();

  /** Returns the (role, content) shape of the stable-prefix messages: everything up to and including the cache boundary. */
  function stablePrefixOf(messages: readonly { role: string; content: unknown }[]) {
    const boundaryIndex = messages.findIndex(
      (m) => (m as { cacheBoundary?: boolean }).cacheBoundary === true,
    );
    return messages.slice(0, boundaryIndex + 1).map((m) => ({ role: m.role, content: m.content }));
  }

  it('marks the last system message as the cache boundary when there are no pinned messages', () => {
    const conversation = buildConversation([
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Hello' },
    ]);
    const budget = createTokenBudget({ maxTokens: 100000 });

    const result = assembler({ conversation, budget, stablePrefix: true });

    const boundaries = result.messages.filter((m) => m.cacheBoundary === true);
    expect(boundaries).toHaveLength(1);
    expect(boundaries[0]?.content).toBe('You are a helpful assistant.');
  });

  it('marks the last pinned message as the cache boundary when pinned messages are present', () => {
    const conversation = buildConversation([
      { role: 'system', content: 'System prompt' },
      { role: 'user', content: 'Hello' },
    ]);
    const budget = createTokenBudget({ maxTokens: 100000 });
    const pinnedMessages = [
      {
        id: 'pinned-1',
        role: 'user' as const,
        content: 'Pinned reference doc 1',
        position: 0,
        createdAt: new Date().toISOString(),
        metadata: {},
        hidden: false,
      },
      {
        id: 'pinned-2',
        role: 'user' as const,
        content: 'Pinned reference doc 2',
        position: 1,
        createdAt: new Date().toISOString(),
        metadata: {},
        hidden: false,
      },
    ];

    const result = assembler({ conversation, budget, stablePrefix: true, pinnedMessages });

    const boundaries = result.messages.filter((m) => m.cacheBoundary === true);
    expect(boundaries).toHaveLength(1);
    expect(boundaries[0]?.content).toBe('Pinned reference doc 2');
    // Pinned messages land right after system, before history.
    expect(result.messages.map((m) => m.content)).toEqual([
      'System prompt',
      'Pinned reference doc 1',
      'Pinned reference doc 2',
      'Hello',
    ]);
  });

  it('never truncates the system prompt for budget, unlike default mode', () => {
    const longSystem = 'x'.repeat(2000);
    const conversation = buildConversation([
      { role: 'system', content: longSystem },
      { role: 'user', content: 'Hello' },
    ]);
    // A tiny budget that would truncate a non-first system message in default mode.
    const budget = createTokenBudget({ maxTokens: 50 });

    const result = assembler({ conversation, budget, stablePrefix: true });

    const systemMessages = result.messages.filter((m) => m.role === 'system');
    expect(systemMessages).toHaveLength(1);
    expect(systemMessages[0]?.content).toBe(longSystem);
  });

  it('produces a byte-identical stable prefix across N steps as usage grows and headroom shrinks', () => {
    // Two system messages: a small one that always survives (the existing
    // "first system message is mandatory" guarantee) and a large second one
    // that would get squeezed out by a shrinking system budget under the
    // OLD priority-ranked behavior. This is the exact failure mode the
    // premise describes: re-ranking under a shrinking budget destroys the
    // provider's cached prefix by silently dropping a previously-included
    // message.
    const conversation = buildConversation([
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'system', content: 'x'.repeat(1600) },
    ]);
    // Small enough that a few `budget.update()` calls meaningfully shrink
    // the allocatable headroom for later steps.
    const budget = createTokenBudget({ maxTokens: 2000, minimumResponseTokens: 100 });
    const pinnedMessages = [
      {
        id: 'pinned-tools',
        role: 'user' as const,
        content: 'Available tools: search, calculator.',
        position: 0,
        createdAt: new Date().toISOString(),
        metadata: {},
        hidden: false,
      },
    ];

    const prefixesByStep: Array<ReturnType<typeof stablePrefixOf>> = [];

    for (let step = 0; step < 5; step++) {
      if (step > 0) {
        conversation.appendUserMessage(`User turn ${step}`);
        conversation.appendAssistantMessage(`Assistant reply ${step}`);
        // Simulate the caller updating the shared budget with each step's
        // actual usage, shrinking the headroom available to later calls.
        budget.update(150);
      }
      const result = assembler({ conversation, budget, stablePrefix: true, pinnedMessages });
      prefixesByStep.push(stablePrefixOf(result.messages));
    }

    // Every step's stable prefix is byte-identical (deep-equal) to every other step's,
    // even though later steps ran against a much smaller allocatable budget.
    const firstPrefix = prefixesByStep[0];
    if (!firstPrefix) throw new Error('expected at least one assembled prefix');
    for (const prefix of prefixesByStep) {
      expect(prefix).toEqual(firstPrefix);
    }
    // Sanity: the prefix actually contains both system messages and the
    // pinned content — not an accidental empty match, and not silently
    // truncated by the shrinking budget.
    expect(firstPrefix).toEqual([
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'system', content: 'x'.repeat(1600) },
      { role: 'user', content: 'Available tools: search, calculator.' },
    ]);
  });

  it('re-ranks retrieved messages below the stable prefix on every call', () => {
    const conversation = buildConversation([
      { role: 'system', content: 'System prompt' },
      { role: 'user', content: 'Hello' },
    ]);
    const budget = createTokenBudget({ maxTokens: 100000 });

    const resultA = assembler({
      conversation,
      budget,
      stablePrefix: true,
      retrievedMessages: [
        {
          id: 'r1',
          role: 'user',
          content: 'Retrieved A',
          position: 0,
          createdAt: new Date().toISOString(),
          metadata: {},
          hidden: false,
        },
      ],
    });

    const resultB = assembler({
      conversation,
      budget,
      stablePrefix: true,
      retrievedMessages: [
        {
          id: 'r2',
          role: 'user',
          content: 'Retrieved B',
          position: 0,
          createdAt: new Date().toISOString(),
          metadata: {},
          hidden: false,
        },
      ],
    });

    // The stable prefix (system) is identical across both calls...
    expect(stablePrefixOf(resultA.messages)).toEqual(stablePrefixOf(resultB.messages));
    // ...but the re-ranked retrieved content below it differs freely.
    expect(resultA.messages.some((m) => m.content === 'Retrieved A')).toBe(true);
    expect(resultB.messages.some((m) => m.content === 'Retrieved B')).toBe(true);
    expect(resultA.messages.some((m) => m.content === 'Retrieved B')).toBe(false);
  });

  it('does not mark a cache boundary when stablePrefix is false (default mode unaffected)', () => {
    const conversation = buildConversation([
      { role: 'system', content: 'System prompt' },
      { role: 'user', content: 'Hello' },
    ]);
    const budget = createTokenBudget({ maxTokens: 100000 });

    const result = assembler({ conversation, budget });

    expect(result.messages.every((m) => m.cacheBoundary !== true)).toBe(true);
  });

  it('does not mark a boundary when the stable prefix is empty', () => {
    const conversation = new Conversation();
    conversation.appendUserMessage('Hello');
    const budget = createTokenBudget({ maxTokens: 100000 });

    const result = assembler({ conversation, budget, stablePrefix: true });

    expect(result.messages.every((m) => m.cacheBoundary !== true)).toBe(true);
  });
});
