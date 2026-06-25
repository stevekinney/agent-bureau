import { describe, expect, test } from 'bun:test';

import {
  calculateChunkSize,
  chunkMessages,
  compactConversation as compactWithSummarizer,
  partitionMessages,
  stripToolResultDetails as stripToolResultDetailsBatch,
  type Summarizer,
} from '../src/compaction/index';
import {
  appendAssistantMessage,
  appendMessages,
  appendSystemMessage,
  appendUserMessage,
  createConversationHistory as createConversation,
  getMessages,
  getSystemMessages,
} from '../src/conversation/index';
import { appendStreamingMessage, isStreamingMessage } from '../src/streaming';
import type { Message } from '../src/types';

const summarizingMock: Summarizer = async (messages) => {
  return `Summary of ${messages.length} messages`;
};

const fixedEstimator = () => 10;

describe('summarizer-based compaction', () => {
  describe('partitionMessages', () => {
    test('separates system, recent, and compactable messages', () => {
      let c = createConversation();
      c = appendSystemMessage(c, 'system prompt');
      for (let i = 0; i < 8; i++) {
        c = appendUserMessage(c, `user ${i}`);
      }

      const { compactable, preserved } = partitionMessages(c, { preserveRecentCount: 4 });

      // System message + 4 recent = 5 preserved
      expect(preserved.length).toBe(5);
      expect(compactable.length).toBe(4);
      expect(preserved.some((m) => m.role === 'system')).toBe(true);
    });

    test('preserves tool pairs as atomic units', () => {
      let c = createConversation();
      for (let i = 0; i < 6; i++) {
        c = appendUserMessage(c, `msg ${i}`);
      }
      c = appendMessages(c, {
        role: 'tool-call',
        content: '',
        toolCall: { id: 'tc-1', name: 'tool', arguments: {} },
      });
      c = appendMessages(c, {
        role: 'tool-result',
        content: 'result',
        toolResult: { callId: 'tc-1', outcome: 'success', content: 'data' },
      });
      c = appendUserMessage(c, 'after tool');
      c = appendAssistantMessage(c, 'reply');

      // preserveRecentCount=3 would capture [tool-result, user, assistant]
      // but tool-result should pull in its tool-call
      const { preserved } = partitionMessages(c, {
        preserveRecentCount: 3,
        preserveToolPairs: true,
      });

      const preservedRoles = preserved.map((m) => m.role);
      // If tool-result is in preserved, tool-call must also be
      if (preservedRoles.includes('tool-result')) {
        expect(preservedRoles).toContain('tool-call');
      }
    });

    test('returns all messages as preserved when fewer than preserveRecentCount', () => {
      let c = createConversation();
      c = appendUserMessage(c, 'only one');

      const { compactable, preserved } = partitionMessages(c, { preserveRecentCount: 4 });

      expect(compactable).toHaveLength(0);
      expect(preserved).toHaveLength(1);
    });

    test('handles all system messages conversation', () => {
      let c = createConversation();
      c = appendSystemMessage(c, 'sys 1');
      c = appendSystemMessage(c, 'sys 2');
      c = appendSystemMessage(c, 'sys 3');

      const { compactable, preserved } = partitionMessages(c, {
        preserveSystemMessages: true,
        preserveRecentCount: 4,
      });

      // No non-system messages, so nothing to compact
      expect(compactable).toHaveLength(0);
      expect(preserved).toHaveLength(3);
    });

    test('handles empty conversation', () => {
      const c = createConversation();
      const { compactable, preserved } = partitionMessages(c);
      expect(compactable).toHaveLength(0);
      expect(preserved).toHaveLength(0);
    });
  });

  describe('chunkMessages', () => {
    test('groups messages within budget', () => {
      const messages: Message[] = Array.from({ length: 6 }, (_, i) => ({
        id: `m-${i}`,
        role: 'user' as const,
        content: `msg ${i}`,
        position: i,
        createdAt: new Date().toISOString(),
        metadata: {},
        hidden: false,
      }));

      // Each message is 10 tokens, budget is 25 -> chunks of 2-3
      const chunks = chunkMessages(messages, 25, fixedEstimator);

      expect(chunks.length).toBeGreaterThan(1);
      for (const chunk of chunks) {
        expect(chunk.length).toBeGreaterThan(0);
      }
    });

    test('does not split tool pairs', () => {
      const messages: Message[] = [
        {
          id: 'm-0',
          role: 'user',
          content: 'hi',
          position: 0,
          createdAt: new Date().toISOString(),
          metadata: {},
          hidden: false,
        },
        {
          id: 'm-1',
          role: 'tool-call',
          content: '',
          position: 1,
          createdAt: new Date().toISOString(),
          metadata: {},
          hidden: false,
          toolCall: { id: 'tc-1', name: 'tool', arguments: {} },
        },
        {
          id: 'm-2',
          role: 'tool-result',
          content: 'result',
          position: 2,
          createdAt: new Date().toISOString(),
          metadata: {},
          hidden: false,
          toolResult: { callId: 'tc-1', outcome: 'success', content: 'data' },
        },
        {
          id: 'm-3',
          role: 'user',
          content: 'follow up',
          position: 3,
          createdAt: new Date().toISOString(),
          metadata: {},
          hidden: false,
        },
      ];

      // Budget allows 15 tokens (1.5 messages), so tool pair (20 tokens) must stay together
      const chunks = chunkMessages(messages, 15, fixedEstimator);

      // Find the chunk containing the tool-call
      for (const chunk of chunks) {
        const hasCall = chunk.some((m) => m.role === 'tool-call');
        const hasResult = chunk.some((m) => m.role === 'tool-result');
        if (hasCall) {
          expect(hasResult).toBe(true);
        }
      }
    });

    test('handles oversized single messages', () => {
      const messages: Message[] = [
        {
          id: 'm-0',
          role: 'user',
          content: 'big message',
          position: 0,
          createdAt: new Date().toISOString(),
          metadata: {},
          hidden: false,
        },
      ];

      // Budget is 1, but message is 10 tokens
      const chunks = chunkMessages(messages, 1, fixedEstimator);

      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toHaveLength(1);
    });

    test('returns empty array for empty messages', () => {
      const chunks = chunkMessages([], 100, fixedEstimator);
      expect(chunks).toHaveLength(0);
    });
  });

  describe('stripToolResultDetails (batch)', () => {
    test('replaces content of tool-result messages', () => {
      const messages: Message[] = [
        {
          id: 'm-0',
          role: 'user',
          content: 'hi',
          position: 0,
          createdAt: new Date().toISOString(),
          metadata: {},
          hidden: false,
        },
        {
          id: 'm-1',
          role: 'tool-result',
          content: 'original data',
          position: 1,
          createdAt: new Date().toISOString(),
          metadata: {},
          hidden: false,
          toolResult: { callId: 'tc-1', outcome: 'success', content: { key: 'value' } },
        },
      ];

      const stripped = stripToolResultDetailsBatch(messages);

      expect(stripped[0].content).toBe('hi');
      expect(stripped[1].content).toBe('[tool result]');
      expect(stripped[1].toolResult?.content).toBe('[tool result]');
      expect(stripped[1].toolResult?.callId).toBe('tc-1');
    });

    test('leaves non-tool-result messages untouched', () => {
      const messages: Message[] = [
        {
          id: 'm-0',
          role: 'assistant',
          content: 'response',
          position: 0,
          createdAt: new Date().toISOString(),
          metadata: {},
          hidden: false,
        },
      ];

      const stripped = stripToolResultDetailsBatch(messages);
      expect(stripped[0]).toBe(messages[0]);
    });

    test('strips structural tool-result block content inside assistant content', () => {
      const messages: Message[] = [
        {
          id: 'm-0',
          role: 'assistant',
          content: [
            { type: 'text', text: 'See results.' },
            {
              type: 'web_search_tool_result',
              tool_use_id: 'stu-1',
              content: [{ snippet: 'a very long search snippet to be stripped' }],
            },
          ],
          position: 0,
          createdAt: new Date().toISOString(),
          metadata: {},
          hidden: false,
        },
      ];

      const stripped = stripToolResultDetailsBatch(messages);
      const parts = stripped[0].content as Array<{
        type: string;
        text?: string;
        content?: unknown;
      }>;
      // Text is preserved; the structural result content is replaced.
      expect(parts[0]).toEqual({ type: 'text', text: 'See results.' });
      expect(parts[1]?.content).toBe('[tool result]');
    });

    test('strips citation payloads on cited text parts', () => {
      const messages: Message[] = [
        {
          id: 'm-0',
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: 'The answer is 4.',
              citations: [{ cited_text: 'long cited evidence to strip', url: 'https://e.com' }],
            },
          ],
          position: 0,
          createdAt: new Date().toISOString(),
          metadata: {},
          hidden: false,
        },
      ];

      const stripped = stripToolResultDetailsBatch(messages);
      const part = (
        stripped[0].content as Array<{ type: string; text?: string; citations?: unknown }>
      )[0];
      // Visible text is preserved; the citation FIELD is removed entirely (it must
      // be structured, so scalarizing it would produce a malformed block).
      expect(part?.text).toBe('The answer is 4.');
      expect('citations' in (part as object)).toBe(false);
    });

    test('drops thinking and redacted_thinking blocks (mutating them would be invalid for re-serialization)', () => {
      const messages: Message[] = [
        {
          id: 'm-0',
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'a long private chain of reasoning', signature: 'sig==' },
            { type: 'redacted_thinking', data: 'encrypted-reasoning-payload' },
            { type: 'text', text: 'Final answer.' },
          ],
          position: 0,
          createdAt: new Date().toISOString(),
          metadata: {},
          hidden: false,
        },
      ];

      const stripped = stripToolResultDetailsBatch(messages);
      const parts = stripped[0].content as Array<{ type: string; text?: string }>;
      // The thinking blocks are removed entirely; only the answer text remains.
      expect(parts).toHaveLength(1);
      expect(parts[0]).toEqual({ type: 'text', text: 'Final answer.' });
    });
  });

  describe('calculateChunkSize', () => {
    test('uses base ratio for normal messages', () => {
      // avgTokens = 50, contextWindow = 10000 -> 50 < 10000 * 0.1 = 1000
      const size = calculateChunkSize(1000, 50, 10000);
      // floor(1000 * 0.4 / 1.2) = floor(333.33) = 333
      expect(size).toBe(333);
    });

    test('uses minimum ratio when average message is large', () => {
      // avgTokens = 1500, contextWindow = 10000 -> 1500 > 10000 * 0.1 = 1000
      const size = calculateChunkSize(5000, 1500, 10000);
      // floor(5000 * 0.15 / 1.2) = floor(625) = 625
      expect(size).toBe(625);
    });

    test('respects custom options', () => {
      const size = calculateChunkSize(1000, 50, 10000, {
        baseChunkRatio: 0.5,
        safetyMargin: 1.0,
      });
      // floor(1000 * 0.5 / 1.0) = 500
      expect(size).toBe(500);
    });

    test('returns at least 1', () => {
      const size = calculateChunkSize(0, 0, 10000);
      expect(size).toBeGreaterThanOrEqual(1);
    });
  });

  describe('compactConversation (with summarizer)', () => {
    test('full flow: summarizer called, summary message created, recent preserved', async () => {
      let c = createConversation();
      for (let i = 0; i < 10; i++) {
        c = appendUserMessage(c, `Message ${i}`);
        c = appendAssistantMessage(c, `Reply ${i}`);
      }

      const { conversation: result, result: compactionResult } = await compactWithSummarizer(
        c,
        summarizingMock,
        { preserveRecentCount: 4 },
      );

      expect(compactionResult.compacted).toBe(true);
      expect(compactionResult.messagesRemoved).toBeGreaterThan(0);
      expect(compactionResult.chunksProcessed).toBeGreaterThan(0);
      expect(compactionResult.summaryContent).toContain('Summary');

      // Summary system message should be present
      const systemMsgs = getSystemMessages(result);
      expect(systemMsgs.some((m) => m.metadata.compactionSummary === true)).toBe(true);

      // Recent messages preserved
      const allMsgs = getMessages(result);
      expect(allMsgs.length).toBeGreaterThanOrEqual(4);
    });

    test('returns compacted false when nothing to compact', async () => {
      let c = createConversation();
      c = appendUserMessage(c, 'one');
      c = appendAssistantMessage(c, 'two');

      const { conversation: result, result: compactionResult } = await compactWithSummarizer(
        c,
        summarizingMock,
        { preserveRecentCount: 4 },
      );

      expect(compactionResult.compacted).toBe(false);
      expect(compactionResult.messagesRemoved).toBe(0);
      expect(compactionResult.chunksProcessed).toBe(0);
      expect(compactionResult.summaryContent).toBe('');
      expect(result).toBe(c);
    });

    test('handles single chunk', async () => {
      let c = createConversation();
      // 6 messages with preserveRecentCount=2 leaves 4 compactable
      // Use large baseChunkRatio to ensure single chunk
      for (let i = 0; i < 6; i++) {
        c = appendUserMessage(c, `msg ${i}`);
      }

      const { result: compactionResult } = await compactWithSummarizer(c, summarizingMock, {
        preserveRecentCount: 2,
        baseChunkRatio: 1.0,
        safetyMargin: 1.0,
      });

      expect(compactionResult.compacted).toBe(true);
      expect(compactionResult.chunksProcessed).toBe(1);
      expect(compactionResult.summaryContent).not.toContain('---');
    });

    test('handles multiple chunks', async () => {
      let c = createConversation();
      for (let i = 0; i < 20; i++) {
        c = appendUserMessage(c, `msg ${i}`);
        c = appendAssistantMessage(c, `reply ${i}`);
      }

      const { result: compactionResult } = await compactWithSummarizer(c, summarizingMock, {
        preserveRecentCount: 2,
      });

      expect(compactionResult.compacted).toBe(true);
      if (compactionResult.chunksProcessed > 1) {
        expect(compactionResult.summaryContent).toContain('---');
      }
    });

    test('preserves conversation identity and metadata', async () => {
      let c = createConversation({ title: 'Test Chat', metadata: { key: 'value' } });
      for (let i = 0; i < 8; i++) {
        c = appendUserMessage(c, `msg ${i}`);
      }

      const { conversation: result } = await compactWithSummarizer(c, summarizingMock, {
        preserveRecentCount: 2,
      });

      expect(result.id).toBe(c.id);
      expect(result.title).toBe('Test Chat');
      expect(result.status).toBe(c.status);
      expect(result.metadata).toEqual({ key: 'value' });
    });

    test('handles empty conversation', async () => {
      const c = createConversation();

      const { result: compactionResult } = await compactWithSummarizer(c, summarizingMock);

      expect(compactionResult.compacted).toBe(false);
    });

    test('preserves system messages in output', async () => {
      let c = createConversation();
      c = appendSystemMessage(c, 'You are helpful');
      for (let i = 0; i < 8; i++) {
        c = appendUserMessage(c, `msg ${i}`);
      }

      const { conversation: result } = await compactWithSummarizer(c, summarizingMock, {
        preserveRecentCount: 2,
        preserveSystemMessages: true,
      });

      const systemMsgs = getSystemMessages(result);
      // At least the original system message + summary
      expect(systemMsgs.length).toBeGreaterThanOrEqual(2);
      expect(systemMsgs.some((m) => m.content === 'You are helpful')).toBe(true);
      expect(systemMsgs.some((m) => m.metadata.compactionSummary === true)).toBe(true);
    });
  });

  describe('streaming message protection', () => {
    test('partitionMessages preserves streaming messages', () => {
      let conversation = createConversation();
      for (let i = 0; i < 8; i++) {
        conversation = appendUserMessage(conversation, `user ${i}`);
      }
      const { conversation: withStreaming } = appendStreamingMessage(conversation, 'assistant');

      const { compactable, preserved } = partitionMessages(withStreaming, {
        preserveRecentCount: 2,
      });

      // The streaming message should be preserved, not compactable
      expect(preserved.some((m) => isStreamingMessage(m))).toBe(true);
      expect(compactable.every((m) => !isStreamingMessage(m))).toBe(true);
    });

    test('compactConversation preserves streaming messages in full flow', async () => {
      let conversation = createConversation();
      for (let i = 0; i < 10; i++) {
        conversation = appendUserMessage(conversation, `Message ${i}`);
        conversation = appendAssistantMessage(conversation, `Reply ${i}`);
      }
      const { conversation: withStreaming } = appendStreamingMessage(conversation, 'assistant');

      const { conversation: result, result: compactionResult } = await compactWithSummarizer(
        withStreaming,
        summarizingMock,
        {
          preserveRecentCount: 2,
        },
      );

      expect(compactionResult.compacted).toBe(true);

      // The streaming message should survive compaction
      const allMessages = getMessages(result);
      expect(allMessages.some((m) => isStreamingMessage(m))).toBe(true);
    });
  });
});
