import { describe, expect, test } from 'bun:test';

import { simpleTokenEstimator } from '../src/context';
import {
  appendAssistantMessage,
  appendUserMessage,
  createConversation,
} from '../src/conversation/index';
import { isStreamingMessage } from '../src/streaming';
import type { Conversation, Message } from '../src/types';
import { pipeConversation, withConversation } from '../src/with-conversation';

const getOrderedMessages = (conversation: Conversation): Message[] =>
  conversation.ids
    .map((id) => conversation.messages[id])
    .filter((message): message is Message => Boolean(message));

describe('withConversation', () => {
  test('chains mutating methods and returns immutable conversation', async () => {
    const base = createConversation({ title: 'Chain' });
    const result = await withConversation(base, (c) => {
      c.appendUserMessage('hi')
        .appendAssistantMessage('hello')
        .appendSystemMessage('note')
        .redactMessageAtPosition(1, '[REDACTED]')
        .appendMessages({ role: 'user', content: 'final' });
    });

    expect(result.createdAt).toBeDefined();
    const messages = getOrderedMessages(result);
    expect(messages.length).toBe(4);
    expect(messages[1]!.content).toBe('[REDACTED]');

    expect(result).not.toBe(base);
  });

  test('supports async draft function and resolves to conversation', async () => {
    const base = createConversation({ title: 'Async' });
    const resultPromise = withConversation(base, async (c) => {
      await Promise.resolve();
      c.appendUserMessage('hi from async');
    });

    const result = await resultPromise;
    const messages = getOrderedMessages(result);
    expect(messages.length).toBe(1);
    expect(messages[0]!.role).toBe('user');
  });

  test('exposes system message helpers on the draft', async () => {
    const base = createConversation({ title: 'Systems' });
    const result = await withConversation(base, (c) => {
      c.appendMessages(
        { role: 'system', content: 'First' },
        { role: 'system', content: 'Second' },
      )
        .prependSystemMessage('Intro')
        .replaceSystemMessage('Intro v2')
        .collapseSystemMessages();
    });

    const systemMessages = getOrderedMessages(result).filter((m) => m.role === 'system');
    expect(systemMessages.length).toBe(1);
    expect(systemMessages[0]!.content).toBe('Intro v2\nFirst\nSecond');
  });
});

describe('pipeConversation', () => {
  test('pipes the conversation through functional transforms', () => {
    const base = createConversation({ title: 'Pipe' });
    const piped = pipeConversation(
      base,
      (conv) => appendUserMessage(conv, 'hi'),
      (conv) => appendAssistantMessage(conv, 'hello'),
    );

    const pipedMessages = getOrderedMessages(piped);
    expect(pipedMessages.length).toBe(2);
    expect(pipedMessages[0]!.role).toBe('user');
    expect(pipedMessages[1]!.role).toBe('assistant');
    expect(base.ids.length).toBe(0);
  });
});

describe('withConversation streaming support', () => {
  test('appendStreamingMessage returns messageId and allows chaining', async () => {
    const base = createConversation({ title: 'Streaming' });
    let capturedId: string | undefined;

    const result = await withConversation(base, (c) => {
      const { draft, messageId } = c.appendStreamingMessage('assistant');
      capturedId = messageId;
      draft.updateStreamingMessage(messageId, 'Hello...');
    });

    expect(capturedId).toBeDefined();
    const messages = getOrderedMessages(result);
    expect(messages.length).toBe(1);
    expect(messages[0]!.content).toBe('Hello...');
    expect(isStreamingMessage(messages[0]!)).toBe(true);
  });

  test('finalizeStreamingMessage removes streaming flag', async () => {
    const base = createConversation({ title: 'Finalize' });

    const result = await withConversation(base, (c) => {
      const { draft, messageId } = c.appendStreamingMessage('assistant');
      draft
        .updateStreamingMessage(messageId, 'Complete response')
        .finalizeStreamingMessage(messageId, {
          tokenUsage: { prompt: 10, completion: 5, total: 15 },
        });
    });

    const messages = getOrderedMessages(result);
    expect(messages.length).toBe(1);
    expect(messages[0]!.content).toBe('Complete response');
    expect(isStreamingMessage(messages[0]!)).toBe(false);
    expect(messages[0]!.tokenUsage?.total).toBe(15);
  });

  test('cancelStreamingMessage removes the message', async () => {
    const base = createConversation({ title: 'Cancel' });

    const result = await withConversation(base, (c) => {
      c.appendUserMessage('Hello');
      const { draft, messageId } = c.appendStreamingMessage('assistant');
      draft.cancelStreamingMessage(messageId);
    });

    const messages = getOrderedMessages(result);
    expect(messages.length).toBe(1);
    expect(messages[0]!.role).toBe('user');
  });
});

describe('withConversation context window management', () => {
  test('truncateFromPosition keeps messages from position onwards', async () => {
    const base = createConversation({ title: 'Truncate' });

    const result = await withConversation(base, (c) => {
      c.appendUserMessage('Message 0')
        .appendAssistantMessage('Message 1')
        .appendUserMessage('Message 2')
        .appendAssistantMessage('Message 3')
        .truncateFromPosition(2);
    });

    const messages = getOrderedMessages(result);
    expect(messages.length).toBe(2);
    expect(messages[0]!.content).toBe('Message 2');
    expect(messages[1]!.content).toBe('Message 3');
  });

  test('truncateFromPosition preserves system messages by default', async () => {
    const base = createConversation({ title: 'TruncateSystem' });

    const result = await withConversation(base, (c) => {
      c.appendSystemMessage('System prompt')
        .appendUserMessage('Message 1')
        .appendAssistantMessage('Message 2')
        .appendUserMessage('Message 3')
        .truncateFromPosition(3);
    });

    const messages = getOrderedMessages(result);
    expect(messages.length).toBe(2);
    expect(messages[0]!.role).toBe('system');
    expect(messages[1]!.content).toBe('Message 3');
  });

  test('truncateToTokenLimit removes oldest messages to fit limit', async () => {
    const base = createConversation({ title: 'TokenLimit' });

    const result = await withConversation(base, (c) => {
      c.appendUserMessage('This is a longer message that takes more tokens')
        .appendAssistantMessage('Response one')
        .appendUserMessage('Short')
        .appendAssistantMessage('Response two')
        .truncateToTokenLimit(10, { estimateTokens: simpleTokenEstimator });
    });

    expect(getOrderedMessages(result).length).toBeLessThan(4);
  });

  test('truncateToTokenLimit preserves last N messages', async () => {
    const base = createConversation({ title: 'PreserveLast' });

    const result = await withConversation(base, (c) => {
      c.appendUserMessage('Old message one')
        .appendAssistantMessage('Old response')
        .appendUserMessage('New message')
        .appendAssistantMessage('New response')
        .truncateToTokenLimit(5, {
          estimateTokens: simpleTokenEstimator,
          preserveLastN: 2,
        });
    });

    const lastTwo = getOrderedMessages(result).slice(-2);
    expect(lastTwo[0]!.content).toBe('New message');
    expect(lastTwo[1]!.content).toBe('New response');
  });
});
