import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';

import { createContextCompactor } from './create-context-compactor';
import type { StepContext } from './types';

/**
 * COR-894 names compaction as one of six mechanisms that must stay distinct
 * from a fresh-attempt reset. These are compaction's discriminators: the SAME
 * conversation, a summary system message written in place of the compacted
 * messages, and the most recent `preserveRecentCount` messages kept verbatim.
 * A fresh attempt is the opposite on every one (see
 * `fresh-attempt/start-fresh-attempt.test.ts`).
 */
function textOf(content: unknown): string {
  return typeof content === 'string' ? content : JSON.stringify(content);
}

describe('createContextCompactor distinctness (COR-894)', () => {
  function conversationWithTurns(turns: number): Conversation {
    const conversation = new Conversation();
    for (let turn = 1; turn <= turns; turn += 1) {
      conversation.appendUserMessage(`Question ${turn}`, { turn });
      conversation.appendAssistantMessage(`Answer ${turn}`, { turn });
    }
    return conversation;
  }

  function project(conversation: Conversation) {
    return conversation.getMessages().map(({ role, content, metadata }) => ({
      role,
      content,
      metadata,
    }));
  }

  it('compacts in place: same conversation id, one summary system message, recent messages verbatim', async () => {
    const preserveRecentCount = 3;
    const conversation = conversationWithTurns(5);
    const conversationId = conversation.current.id;
    const before = project(conversation);
    const summarized: string[] = [];
    const compactor = createContextCompactor({
      summarize: async (messages) => {
        summarized.push(...messages.map((message) => textOf(message.content)));
        return 'The earlier turns set up the fixture.';
      },
      retainRecentMessages: preserveRecentCount,
    });

    await compactor(conversation, { conversation, step: 0 } satisfies StepContext);

    const after = project(conversation);
    expect(conversation.current.id).toBe(conversationId);
    expect(after).toHaveLength(1 + preserveRecentCount);
    expect(after[0]?.role).toBe('system');
    expect(after[0]?.metadata).toEqual({ compactionSummary: true });
    expect(textOf(after[0]?.content)).toStartWith(
      'Previous conversation summary:\nThe earlier turns set up the fixture.',
    );
    expect(after.filter((message) => message.role === 'system')).toHaveLength(1);
    expect(summarized).toEqual(
      before.slice(0, -preserveRecentCount).map((message) => textOf(message.content)),
    );
    expect(after.slice(1)).toEqual(before.slice(-preserveRecentCount));
  });
});
