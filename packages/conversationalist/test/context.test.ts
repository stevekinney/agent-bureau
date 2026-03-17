import { describe, expect, it } from 'bun:test';

import {
  estimateConversationTokens,
  getRecentMessages,
  simpleTokenEstimator,
  truncateFromPosition,
  truncateToTokenLimit,
} from '../src/context';
import {
  appendMessages,
  appendUnsafeMessage,
  createConversation,
  createConversationUnsafe,
} from '../src/conversation/index';
import { isConversationEnvironmentParameter } from '../src/environment';
import type { Conversation, Message } from '../src/types';
import { createMessage } from '../src/utilities';

const getOrderedMessages = (conversation: Conversation): Message[] =>
  conversation.ids
    .map((id) => conversation.messages[id])
    .filter((message): message is Message => Boolean(message));

const testEnvironment = {
  now: () => '2024-01-01T00:00:00.000Z',
  randomId: (() => {
    let counter = 0;
    return () => `test-id-${++counter}`;
  })(),
};

describe('getRecentMessages', () => {
  it('returns the last N messages', () => {
    let conv = createConversation({ id: 'test' }, testEnvironment);
    conv = appendMessages(
      conv,
      { role: 'system', content: 'System message' },
      { role: 'user', content: 'User 1' },
      { role: 'assistant', content: 'Assistant 1' },
      { role: 'user', content: 'User 2' },
      { role: 'assistant', content: 'Assistant 2' },
      testEnvironment,
    );

    const recent = getRecentMessages(conv, 2);
    expect(recent).toHaveLength(2);
    expect(recent[0]?.content).toBe('User 2');
    expect(recent[1]?.content).toBe('Assistant 2');
  });

  it('excludes system messages by default', () => {
    let conv = createConversation({ id: 'test' }, testEnvironment);
    conv = appendMessages(
      conv,
      { role: 'system', content: 'System' },
      { role: 'user', content: 'User' },
      testEnvironment,
    );

    const recent = getRecentMessages(conv, 10);
    expect(recent.every((m) => m.role !== 'system')).toBe(true);
  });

  it('includes system messages when option is set', () => {
    let conv = createConversation({ id: 'test' }, testEnvironment);
    conv = appendMessages(
      conv,
      { role: 'system', content: 'System' },
      { role: 'user', content: 'User' },
      testEnvironment,
    );

    const recent = getRecentMessages(conv, 10, { includeSystem: true });
    expect(recent.some((m) => m.role === 'system')).toBe(true);
  });

  it('excludes hidden messages by default', () => {
    let conv = createConversation({ id: 'test' }, testEnvironment);
    conv = appendMessages(
      conv,
      { role: 'user', content: 'Visible' },
      { role: 'user', content: 'Hidden', hidden: true },
      testEnvironment,
    );

    const recent = getRecentMessages(conv, 10);
    expect(recent).toHaveLength(1);
    expect(recent[0]?.content).toBe('Visible');
  });

  it('preserves tool-use when the recent slice includes a tool-result', () => {
    let conv = createConversation({ id: 'test' }, testEnvironment);
    conv = appendMessages(
      conv,
      { role: 'user', content: 'Before' },
      {
        role: 'tool-use',
        content: '',
        toolCall: { id: 'call-1', name: 'tool', arguments: {} },
      },
      {
        role: 'tool-result',
        content: '',
        toolResult: { callId: 'call-1', outcome: 'success', content: 'ok' },
      },
      testEnvironment,
    );

    const recent = getRecentMessages(conv, 1);
    expect(recent.some((m) => m.role === 'tool-use')).toBe(true);
    expect(recent.some((m) => m.role === 'tool-result')).toBe(true);
  });

  it('drops orphan tool results when preserving tool pairs', () => {
    let conv = createConversationUnsafe({ id: 'test' }, testEnvironment);
    conv = appendUnsafeMessage(
      conv,
      {
        role: 'tool-result',
        content: '',
        toolResult: { callId: 'missing', outcome: 'success', content: 'ok' },
      },
      testEnvironment,
    );

    const recent = getRecentMessages(conv, 1, { preserveToolPairs: true });
    expect(recent).toHaveLength(0);
  });

  it('returns a simple slice when preserveToolPairs is false', () => {
    let conv = createConversation({ id: 'test' }, testEnvironment);
    conv = appendMessages(
      conv,
      {
        role: 'tool-use',
        content: '',
        toolCall: { id: 'call-1', name: 'tool', arguments: {} },
      },
      {
        role: 'tool-result',
        content: '',
        toolResult: { callId: 'call-1', outcome: 'success', content: 'ok' },
      },
      testEnvironment,
    );

    const recent = getRecentMessages(conv, 1, { preserveToolPairs: false });
    expect(recent).toHaveLength(1);
    expect(recent[0]?.role).toBe('tool-result');
  });
});

describe('truncateFromPosition', () => {
  it('keeps messages from position onwards', () => {
    let conv = createConversation({ id: 'test' }, testEnvironment);
    conv = appendMessages(
      conv,
      { role: 'user', content: 'Message 0' },
      { role: 'assistant', content: 'Message 1' },
      { role: 'user', content: 'Message 2' },
      { role: 'assistant', content: 'Message 3' },
      testEnvironment,
    );

    const truncated = truncateFromPosition(conv, 2, undefined, testEnvironment);
    expect(getOrderedMessages(truncated)).toHaveLength(2);
    expect(getOrderedMessages(truncated)[0]?.content).toBe('Message 2');
    expect(getOrderedMessages(truncated)[1]?.content).toBe('Message 3');
  });

  it('preserves system messages by default', () => {
    let conv = createConversation({ id: 'test' }, testEnvironment);
    conv = appendMessages(
      conv,
      { role: 'system', content: 'System prompt' },
      { role: 'user', content: 'Message 1' },
      { role: 'assistant', content: 'Message 2' },
      { role: 'user', content: 'Message 3' },
      testEnvironment,
    );

    const truncated = truncateFromPosition(conv, 2, undefined, testEnvironment);
    expect(getOrderedMessages(truncated).some((m) => m.role === 'system')).toBe(true);
    expect(getOrderedMessages(truncated)[0]?.content).toBe('System prompt');
  });

  it('can exclude system messages', () => {
    let conv = createConversation({ id: 'test' }, testEnvironment);
    conv = appendMessages(
      conv,
      { role: 'system', content: 'System prompt' },
      { role: 'user', content: 'Message 1' },
      { role: 'assistant', content: 'Message 2' },
      testEnvironment,
    );

    const truncated = truncateFromPosition(
      conv,
      2,
      { preserveSystemMessages: false },
      testEnvironment,
    );
    expect(getOrderedMessages(truncated).every((m) => m.role !== 'system')).toBe(true);
  });

  it('renumbers positions correctly', () => {
    let conv = createConversation({ id: 'test' }, testEnvironment);
    conv = appendMessages(
      conv,
      { role: 'user', content: 'Message 0' },
      { role: 'assistant', content: 'Message 1' },
      { role: 'user', content: 'Message 2' },
      testEnvironment,
    );

    const truncated = truncateFromPosition(conv, 1, undefined, testEnvironment);
    getOrderedMessages(truncated).forEach((m, i) => {
      expect(m.position).toBe(i);
    });
  });

  it('handles multi-modal content in truncateFromPosition', () => {
    let conv = createConversation({ id: 'test' }, testEnvironment);
    conv = appendMessages(
      conv,
      { role: 'user', content: 'Msg 1' },
      {
        role: 'user',
        content: [{ type: 'text', text: 'Msg 2' }],
      },
      testEnvironment,
    );

    const truncated = truncateFromPosition(conv, 1, undefined, testEnvironment);
    expect(getOrderedMessages(truncated)).toHaveLength(1);
    expect(Array.isArray(getOrderedMessages(truncated)[0].content)).toBe(true);
  });

  it('preserves tool-use when truncating from a position that includes a tool-result', () => {
    let conv = createConversation({ id: 'test' }, testEnvironment);
    conv = appendMessages(
      conv,
      { role: 'user', content: 'Hello' },
      {
        role: 'tool-use',
        content: '',
        toolCall: { id: 'call-1', name: 'tool', arguments: {} },
      },
      { role: 'assistant', content: 'Waiting' },
      {
        role: 'tool-result',
        content: '',
        toolResult: { callId: 'call-1', outcome: 'success', content: 'ok' },
      },
      testEnvironment,
    );

    const truncated = truncateFromPosition(conv, 3, undefined, testEnvironment);
    const messages = getOrderedMessages(truncated);
    expect(messages.some((m) => m.role === 'tool-use')).toBe(true);
    expect(messages.some((m) => m.role === 'tool-result')).toBe(true);
  });

  it('returns a valid conversation when preserveToolPairs is true', () => {
    let conv = createConversation({ id: 'test' }, testEnvironment);
    conv = appendMessages(
      conv,
      { role: 'user', content: 'Hello' },
      {
        role: 'tool-use',
        content: '',
        toolCall: { id: 'call-1', name: 'tool', arguments: {} },
      },
      {
        role: 'tool-result',
        content: '',
        toolResult: { callId: 'call-1', outcome: 'success', content: 'ok' },
      },
      testEnvironment,
    );

    const truncated = truncateFromPosition(
      conv,
      2,
      { preserveToolPairs: true },
      testEnvironment,
    );
    const messages = getOrderedMessages(truncated);
    expect(messages.some((m) => m.role === 'tool-use')).toBe(true);
    expect(messages.some((m) => m.role === 'tool-result')).toBe(true);
  });

  it('throws when preserveToolPairs is false and a tool-result would be stranded', () => {
    let conv = createConversation({ id: 'test' }, testEnvironment);
    conv = appendMessages(
      conv,
      { role: 'user', content: 'Hello' },
      {
        role: 'tool-use',
        content: '',
        toolCall: { id: 'call-1', name: 'tool', arguments: {} },
      },
      {
        role: 'tool-result',
        content: '',
        toolResult: { callId: 'call-1', outcome: 'success', content: 'ok' },
      },
      testEnvironment,
    );

    expect(() =>
      truncateFromPosition(
        conv,
        2,
        { preserveToolPairs: false, preserveSystemMessages: false },
        testEnvironment,
      ),
    ).toThrow(/preserveToolPairs: true/);
  });
});

describe('estimateConversationTokens', () => {
  it('sums token estimates for all messages', () => {
    let conv = createConversation({ id: 'test' }, testEnvironment);
    conv = appendMessages(
      conv,
      { role: 'user', content: 'Hello' }, // 5 chars
      { role: 'assistant', content: 'Hi there' }, // 8 chars
      testEnvironment,
    );

    const tokens = estimateConversationTokens(conv, simpleTokenEstimator);
    // simpleTokenEstimator uses ~4 chars per token
    expect(tokens).toBeGreaterThan(0);
  });

  it('uses estimator from environment when only environment is provided', () => {
    let conv = createConversation({ id: 'test' }, testEnvironment);
    conv = appendMessages(
      conv,
      { role: 'user', content: 'Hello world' },
      testEnvironment,
    );

    const tokens = estimateConversationTokens(conv, undefined, testEnvironment);
    expect(tokens).toBe(3); // 'Hello world' is 11 chars -> 3 tokens
  });

  it('uses default estimator when no estimator or environment is provided', () => {
    let conv = createConversation({ id: 'test' });
    conv = appendMessages(conv, { role: 'user', content: 'Hello world' });

    const tokens = estimateConversationTokens(conv);
    expect(tokens).toBe(3);
  });
});

describe('simpleTokenEstimator', () => {
  it('estimates tokens based on character count', () => {
    const message = createMessage({
      id: 'test',
      role: 'user',
      content: 'Hello world', // 11 chars
      position: 0,
      createdAt: '2024-01-01T00:00:00.000Z',
      metadata: {},
      hidden: false,
    });

    const tokens = simpleTokenEstimator(message);
    // 11 chars / 4 = 2.75, ceil = 3
    expect(tokens).toBe(3);
  });
});

describe('truncateToTokenLimit', () => {
  it('returns unchanged if under limit', () => {
    let conv = createConversation({ id: 'test' }, testEnvironment);
    conv = appendMessages(conv, { role: 'user', content: 'Hi' }, testEnvironment);

    const truncated = truncateToTokenLimit(
      conv,
      1000,
      { estimateTokens: simpleTokenEstimator },
      testEnvironment,
    );
    expect(getOrderedMessages(truncated)).toHaveLength(getOrderedMessages(conv).length);
  });

  it('removes oldest messages first to fit limit', () => {
    let conv = createConversation({ id: 'test' }, testEnvironment);
    conv = appendMessages(
      conv,
      { role: 'user', content: 'This is a longer message that takes more tokens' },
      { role: 'assistant', content: 'Response one' },
      { role: 'user', content: 'Short' },
      { role: 'assistant', content: 'Response two' },
      testEnvironment,
    );

    // Set a low token limit that can't fit all messages
    const truncated = truncateToTokenLimit(
      conv,
      10,
      { estimateTokens: simpleTokenEstimator },
      testEnvironment,
    );
    expect(getOrderedMessages(truncated).length).toBeLessThan(
      getOrderedMessages(conv).length,
    );
  });

  it('preserves system messages', () => {
    let conv = createConversation({ id: 'test' }, testEnvironment);
    conv = appendMessages(
      conv,
      { role: 'system', content: 'System prompt' },
      { role: 'user', content: 'User message' },
      { role: 'assistant', content: 'Assistant message' },
      testEnvironment,
    );

    const truncated = truncateToTokenLimit(
      conv,
      5,
      { estimateTokens: simpleTokenEstimator },
      testEnvironment,
    );
    expect(getOrderedMessages(truncated).some((m) => m.role === 'system')).toBe(true);
  });

  it('preserves last N messages when specified', () => {
    let conv = createConversation({ id: 'test' }, testEnvironment);
    conv = appendMessages(
      conv,
      { role: 'user', content: 'Old message one' },
      { role: 'assistant', content: 'Old response' },
      { role: 'user', content: 'New message' },
      { role: 'assistant', content: 'New response' },
      testEnvironment,
    );

    const truncated = truncateToTokenLimit(
      conv,
      10,
      {
        estimateTokens: simpleTokenEstimator,
        preserveLastN: 2,
      },
      testEnvironment,
    );

    // The last 2 messages should always be preserved
    const lastMessages = getOrderedMessages(truncated).slice(-2);
    expect(lastMessages[0]?.content).toBe('New message');
    expect(lastMessages[1]?.content).toBe('New response');
  });

  it('returns only system and protected messages when token limit is too low', () => {
    let conv = createConversation({ id: 'test' }, testEnvironment);
    conv = appendMessages(
      conv,
      { role: 'system', content: 'Very long system prompt that takes many tokens' },
      { role: 'user', content: 'Old message' },
      { role: 'assistant', content: 'Old response' },
      { role: 'user', content: 'New message' },
      { role: 'assistant', content: 'New response' },
      testEnvironment,
    );

    // Token limit so low that only system + last N fit (or even just those)
    const truncated = truncateToTokenLimit(
      conv,
      1, // Very low limit
      {
        estimateTokens: simpleTokenEstimator,
        preserveLastN: 2,
      },
      testEnvironment,
    );

    // Should contain system message and last 2 protected messages
    expect(getOrderedMessages(truncated).some((m) => m.role === 'system')).toBe(true);
    // Positions should be renumbered
    getOrderedMessages(truncated).forEach((m, i) => {
      expect(m.position).toBe(i);
    });
  });

  it('handles messages with multi-modal content during truncation', () => {
    let conv = createConversation({ id: 'test' }, testEnvironment);
    conv = appendMessages(
      conv,
      { role: 'system', content: 'System' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Look at this' },
          { type: 'image', url: 'data:image/png;base64,abc' },
        ],
      },
      { role: 'assistant', content: 'I see it' },
      testEnvironment,
    );

    const truncated = truncateToTokenLimit(
      conv,
      1, // Very low limit to trigger the special path
      {
        estimateTokens: simpleTokenEstimator,
        preserveLastN: 1,
      },
      testEnvironment,
    );

    // Should preserve array content structure
    expect(getOrderedMessages(truncated).length).toBeGreaterThan(0);
  });

  it('handles messages with tool calls during truncation', () => {
    let conv = createConversation({ id: 'test' }, testEnvironment);
    conv = appendMessages(
      conv,
      { role: 'system', content: 'System prompt' },
      { role: 'user', content: 'Do something' },
      {
        role: 'tool-use',
        content: '',
        toolCall: { id: 'call-1', name: 'tool', arguments: '{}' },
      },
      {
        role: 'tool-result',
        content: '',
        toolResult: { callId: 'call-1', outcome: 'success', content: 'done' },
      },
      { role: 'assistant', content: 'Done!' },
      testEnvironment,
    );

    const truncated = truncateToTokenLimit(
      conv,
      1, // Very low limit
      {
        estimateTokens: simpleTokenEstimator,
        preserveLastN: 2,
      },
      testEnvironment,
    );

    // Should handle toolCall and toolResult properties
    expect(getOrderedMessages(truncated).length).toBeGreaterThan(0);
  });

  it('preserves tool pairs when a tool-result is protected by preserveLastN', () => {
    let conv = createConversation({ id: 'test' }, testEnvironment);
    conv = appendMessages(
      conv,
      { role: 'user', content: 'Start' },
      {
        role: 'tool-use',
        content: '',
        toolCall: { id: 'call-1', name: 'tool', arguments: {} },
      },
      {
        role: 'tool-result',
        content: '',
        toolResult: { callId: 'call-1', outcome: 'success', content: 'ok' },
      },
      testEnvironment,
    );

    const truncated = truncateToTokenLimit(
      conv,
      1,
      {
        estimateTokens: simpleTokenEstimator,
        preserveLastN: 1,
        preserveToolPairs: true,
      },
      testEnvironment,
    );

    const messages = getOrderedMessages(truncated);
    expect(messages.some((m) => m.role === 'tool-use')).toBe(true);
    expect(messages.some((m) => m.role === 'tool-result')).toBe(true);
  });

  it('throws when preserveToolPairs is false and a tool-result would be stranded', () => {
    let conv = createConversation({ id: 'test' }, testEnvironment);
    conv = appendMessages(
      conv,
      { role: 'user', content: 'Start' },
      {
        role: 'tool-use',
        content: '',
        toolCall: { id: 'call-1', name: 'tool', arguments: {} },
      },
      {
        role: 'tool-result',
        content: '',
        toolResult: { callId: 'call-1', outcome: 'success', content: 'ok' },
      },
      testEnvironment,
    );

    expect(() =>
      truncateToTokenLimit(
        conv,
        1,
        {
          estimateTokens: () => 1,
          preserveLastN: 1,
          preserveToolPairs: false,
        },
        testEnvironment,
      ),
    ).toThrow(/preserveToolPairs: true/);
  });

  it('handles messages with token usage during truncation', () => {
    let conv = createConversation({ id: 'test' }, testEnvironment);
    conv = appendMessages(
      conv,
      { role: 'system', content: 'System' },
      { role: 'user', content: 'Hello' },
      {
        role: 'assistant',
        content: 'Hi there!',
        tokenUsage: { prompt: 10, completion: 5, total: 15 },
      },
      testEnvironment,
    );

    const truncated = truncateToTokenLimit(
      conv,
      1, // Very low limit
      {
        estimateTokens: simpleTokenEstimator,
        preserveLastN: 1,
      },
      testEnvironment,
    );

    // Should preserve tokenUsage in truncated messages
    const assistantMsg = getOrderedMessages(truncated).find(
      (m) => m.role === 'assistant',
    );
    if (assistantMsg) {
      expect(assistantMsg.tokenUsage).toBeDefined();
    }
  });

  it('works with a plain options object (not environment)', () => {
    let conv = createConversation({ id: 'test' }, testEnvironment);
    conv = appendMessages(conv, { role: 'user', content: 'Hello' }, testEnvironment);
    conv = appendMessages(conv, { role: 'assistant', content: 'World' }, testEnvironment);

    // Tokens: Hello (2) + World (2) = 4
    const truncated = truncateToTokenLimit(conv, 2, { preserveLastN: 1 });
    expect(getOrderedMessages(truncated).length).toBe(1);
    expect(getOrderedMessages(truncated)[0].content).toBe('World');
  });

  it('works with no options or estimator provided', () => {
    let conv = createConversation({ id: 'test' });
    conv = appendMessages(conv, { role: 'user', content: 'Hello world' });

    const truncated = truncateToTokenLimit(conv, 1);
    expect(getOrderedMessages(truncated).length).toBe(0);
  });

  it('accepts a function as the third argument (overload)', () => {
    let conv = createConversation({ id: 'test' });
    conv = appendMessages(conv, { role: 'user', content: 'Hello' });

    const truncated = truncateToTokenLimit(conv, 1, () => 100);
    expect(getOrderedMessages(truncated).length).toBe(0);
  });

  it('does not overwrite explicitly passed environment when options contain an estimator', () => {
    let conv = createConversation({ id: 'test' });
    conv = appendMessages(conv, { role: 'user', content: 'Hello' });

    const myEnv = {
      now: () => '2025-01-01T00:00:00.000Z',
      randomId: () => 'custom-id',
      estimateTokens: () => 1,
    };

    // If we pass an estimator in options AND an environment
    const truncated = truncateToTokenLimit(
      conv,
      10,
      { estimateTokens: () => 100 }, // This estimator should be used
      myEnv, // This environment should NOT be overwritten by the options object
    );

    // If it used myEnv.now(), the updatedAt should match.
    // truncateToTokenLimit re-creates messages if it truncates.
    // In this case, conv has 1 message.
    // If it uses options.estimateTokens (100), 100 > 10, so it truncates.
    // If it uses myEnv.estimateTokens (1), 1 <= 10, so it doesn't truncate.

    expect(getOrderedMessages(truncated).length).toBe(0); // Should have used the 100 tokens estimator
    expect(truncated.updatedAt).toBe('2025-01-01T00:00:00.000Z'); // Should have used myEnv.now()
  });

  it('correctly identifies TruncateOptions with only estimateTokens as options, not environment', () => {
    let conv = createConversation({ id: 'test' });
    conv = appendMessages(conv, { role: 'user', content: 'Hello' });

    // Every message is 100 tokens. 100 > 10, so it should truncate.
    const estimator = () => 100;

    const truncated = truncateToTokenLimit(conv, 10, { estimateTokens: estimator });

    // If it's correctly identified as options, it should truncate.
    // If it's incorrectly identified as environment, it will use the default estimator (character count / 4),
    // 'Hello' is 5 chars -> 2 tokens. 2 <= 10, so it won't truncate.
    expect(getOrderedMessages(truncated).length).toBe(0);
  });

  it('does not identify { plugins: [] } as an environment', () => {
    const options = { plugins: [] };
    expect(isConversationEnvironmentParameter(options)).toBe(false);
  });

  it('correctly uses environment when passed as 3rd argument with an estimator', () => {
    let conv = createConversation({ id: 'test' });
    conv = appendMessages(conv, { role: 'user', content: 'Hello' });

    const myEnv = {
      now: () => '2025-01-01T00:00:00.000Z',
      randomId: () => 'custom-id',
      estimateTokens: () => 100, // This should trigger truncation
    };

    // Pass environment as 3rd arg, 4th arg is undefined
    const truncated = truncateToTokenLimit(conv, 10, myEnv);

    expect(getOrderedMessages(truncated).length).toBe(0); // Truncated because 100 > 10
    expect(truncated.updatedAt).toBe('2025-01-01T00:00:00.000Z');
  });

  it('prioritizes environment fields over options fields when disambiguating', () => {
    let conv = createConversation({ id: 'test' });
    conv = appendMessages(conv, { role: 'user', content: 'Hello' });

    // This object has BOTH environment fields (now) AND fields that exist in options (estimateTokens)
    // The presence of 'now' should make it be treated as an environment, not options
    const ambiguousObject = {
      now: () => '2025-01-01T00:00:00.000Z',
      estimateTokens: () => 100,
    };

    const truncated = truncateToTokenLimit(conv, 10, ambiguousObject);

    // Should truncate using the environment's estimator
    expect(getOrderedMessages(truncated).length).toBe(0);
    // Should use the environment's now function (not default)
    expect(truncated.updatedAt).toBe('2025-01-01T00:00:00.000Z');
  });

  it('treats object with only estimateTokens as options when no environment fields present', () => {
    let conv = createConversation({ id: 'test' });
    conv = appendMessages(conv, { role: 'user', content: 'Hello' });

    // This object has only estimateTokens (no now/randomId/plugins)
    // Should be treated as TruncateOptions, not ConversationEnvironment
    const optionsObject = {
      estimateTokens: () => 100,
    };

    const truncated = truncateToTokenLimit(conv, 10, optionsObject);

    // Should truncate using the provided estimator
    expect(getOrderedMessages(truncated).length).toBe(0);
    // updatedAt should use default environment (current time), not a fixed time
    expect(truncated.updatedAt).not.toBe('2025-01-01T00:00:00.000Z');
  });
});
