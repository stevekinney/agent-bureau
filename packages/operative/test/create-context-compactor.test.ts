import { describe, expect, it, mock } from 'bun:test';
import type { Message } from 'conversationalist';
import { Conversation } from 'conversationalist';

import { createContextCompactor } from '../src/create-context-compactor';
import type { StepContext } from '../src/types';

function createStubContext(conversation: Conversation): StepContext {
  return {
    conversation,
    step: 0,
  };
}

function buildConversation(...pairs: [string, string][]): Conversation {
  const conversation = new Conversation();
  for (const [user, assistant] of pairs) {
    conversation.appendUserMessage(user);
    conversation.appendAssistantMessage(assistant);
  }
  return conversation;
}

describe('createContextCompactor', () => {
  it('calls the summarize function with messages to compact', async () => {
    const summarize = mock(async (_messages: ReadonlyArray<Message>) => 'Summary of old messages');
    const compactor = createContextCompactor({ summarize });

    const conversation = buildConversation(
      ['Hello', 'Hi there!'],
      ['How are you?', 'I am fine.'],
      ['Tell me a joke', 'Why did the chicken cross the road?'],
      ['Another question', 'Another answer'],
      ['Final question', 'Final answer'],
    );

    const context = createStubContext(conversation);
    await compactor(conversation, context);

    // compact() may chunk messages and call summarize multiple times
    expect(summarize).toHaveBeenCalled();
    const calledMessages = summarize.mock.calls[0]![0] as ReadonlyArray<Message>;
    expect(calledMessages.length).toBeGreaterThan(0);
  });

  it('retains the specified number of recent turns', async () => {
    const summarize = mock(async () => 'Summary');
    const compactor = createContextCompactor({ summarize, retainRecentTurns: 2 });

    const conversation = buildConversation(
      ['Turn 1 user', 'Turn 1 assistant'],
      ['Turn 2 user', 'Turn 2 assistant'],
      ['Turn 3 user', 'Turn 3 assistant'],
      ['Turn 4 user', 'Turn 4 assistant'],
    );

    const context = createStubContext(conversation);
    await compactor(conversation, context);

    // After compaction, should have: system (summary) + 2 recent messages
    const messages = conversation.getMessages();
    const nonSystem = messages.filter((m) => m.role !== 'system');
    expect(nonSystem.length).toBe(2);
  });

  it('uses the default retainRecentTurns of 4', async () => {
    const summarize = mock(async () => 'Summary');
    const compactor = createContextCompactor({ summarize });

    const conversation = buildConversation(
      ['Turn 1', 'Response 1'],
      ['Turn 2', 'Response 2'],
      ['Turn 3', 'Response 3'],
      ['Turn 4', 'Response 4'],
      ['Turn 5', 'Response 5'],
      ['Turn 6', 'Response 6'],
    );

    const context = createStubContext(conversation);
    await compactor(conversation, context);

    const messages = conversation.getMessages();
    const nonSystem = messages.filter((m) => m.role !== 'system');
    // Default preserveRecentCount is 4
    expect(nonSystem.length).toBe(4);
  });

  it('prepends summaryPrefix to the summary content', async () => {
    const summarize = mock(async () => 'The user asked about TypeScript.');
    const compactor = createContextCompactor({
      summarize,
      summaryPrefix: 'CONTEXT:',
    });

    const conversation = buildConversation(
      ['Old turn', 'Old response'],
      ['Turn 2', 'Response 2'],
      ['Turn 3', 'Response 3'],
      ['Turn 4', 'Response 4'],
      ['Turn 5', 'Response 5'],
      ['Turn 6', 'Response 6'],
    );

    const context = createStubContext(conversation);
    await compactor(conversation, context);

    const messages = conversation.getMessages();
    const systemMessages = messages.filter((m) => m.role === 'system');
    expect(systemMessages.length).toBeGreaterThanOrEqual(1);

    const summaryMessage = systemMessages.find(
      (m) => typeof m.content === 'string' && m.content.includes('CONTEXT:'),
    );
    expect(summaryMessage).toBeDefined();
    expect(typeof summaryMessage!.content === 'string' && summaryMessage!.content).toContain(
      'The user asked about TypeScript.',
    );
  });

  it('uses the default summaryPrefix when none is provided', async () => {
    const summarize = mock(async () => 'The user discussed coding.');
    const compactor = createContextCompactor({ summarize });

    const conversation = buildConversation(
      ['Old turn', 'Old response'],
      ['Turn 2', 'Response 2'],
      ['Turn 3', 'Response 3'],
      ['Turn 4', 'Response 4'],
      ['Turn 5', 'Response 5'],
      ['Turn 6', 'Response 6'],
    );

    const context = createStubContext(conversation);
    await compactor(conversation, context);

    const messages = conversation.getMessages();
    const systemMessages = messages.filter((m) => m.role === 'system');
    const summaryMessage = systemMessages.find(
      (m) => typeof m.content === 'string' && m.content.includes('Previous conversation summary:'),
    );
    expect(summaryMessage).toBeDefined();
  });

  it('is a no-op when conversation has fewer messages than retainRecentTurns', async () => {
    const summarize = mock(async () => 'Summary');
    const compactor = createContextCompactor({ summarize, retainRecentTurns: 10 });

    const conversation = buildConversation(
      ['Short turn', 'Short response'],
      ['Another turn', 'Another response'],
    );

    const messagesBefore = conversation.getMessages().length;
    const context = createStubContext(conversation);
    await compactor(conversation, context);

    // Should not have been compacted
    expect(summarize).not.toHaveBeenCalled();
    expect(conversation.getMessages().length).toBe(messagesBefore);
  });

  it('is a no-op for an empty conversation', async () => {
    const summarize = mock(async () => 'Summary');
    const compactor = createContextCompactor({ summarize });

    const conversation = new Conversation();
    const context = createStubContext(conversation);
    await compactor(conversation, context);

    expect(summarize).not.toHaveBeenCalled();
    expect(conversation.getMessages().length).toBe(0);
  });
});
