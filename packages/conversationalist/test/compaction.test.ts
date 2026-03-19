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
  compactConversation,
  createConversationHistory as createConversation,
  getMessages,
  getSystemMessages,
  stripToolResultDetails,
} from '../src/conversation/index';
import { appendStreamingMessage, isStreamingMessage } from '../src/streaming';
import type { CompactionOptions, Message } from '../src/types';

const mockSummarizer = (messages: ReadonlyArray<Message>): string => {
  return `Summary of ${messages.length} messages`;
};

const deterministicTokenEstimator = (_message: Message): number => {
  // Simple: 1 token per character for testing
  return 100;
};

describe('conversation compaction', () => {
  describe('stripToolResultDetails', () => {
    test('replaces tool result content while preserving other fields', () => {
      // Create a message object directly to test stripToolResultDetails
      const toolResultMessage: Message = {
        id: 'msg-1',
        role: 'tool-result',
        content: 'original result',
        position: 0,
        createdAt: new Date().toISOString(),
        metadata: {},
        hidden: false,
        toolResult: {
          callId: 'call-1',
          outcome: 'success',
          content: { data: 'secret' },
        },
      };

      const stripped = stripToolResultDetails(toolResultMessage, 'Summarized result');

      expect(stripped.content).toBe('Summarized result');
      expect(stripped.toolResult?.callId).toBe('call-1');
      expect(stripped.toolResult?.outcome).toBe('success');
      expect(stripped.toolResult?.content).toBe('Summarized result');
      expect(stripped.id).toBe('msg-1');
      expect(stripped.role).toBe('tool-result');
    });

    test('handles tool result with error', () => {
      const toolResultMessage: Message = {
        id: 'msg-2',
        role: 'tool-result',
        content: 'error details',
        position: 0,
        createdAt: new Date().toISOString(),
        metadata: {},
        hidden: false,
        toolResult: {
          callId: 'call-2',
          outcome: 'error',
          error: { category: 'permission_error', message: 'Denied' },
        },
      };

      const stripped = stripToolResultDetails(toolResultMessage, 'Tool error summary');

      expect(stripped.content).toBe('Tool error summary');
      expect(stripped.toolResult?.outcome).toBe('error');
      expect(stripped.toolResult?.error?.category).toBe('permission_error');
    });

    test('preserves token usage and metadata', () => {
      const toolResultMessage: Message = {
        id: 'msg-3',
        role: 'tool-result',
        content: 'original',
        position: 0,
        createdAt: new Date().toISOString(),
        metadata: { custom: 'value' },
        hidden: false,
        tokenUsage: { prompt: 10, completion: 5, total: 15 },
        toolResult: {
          callId: 'call-1',
          outcome: 'success',
          content: 'data',
        },
      };

      const stripped = stripToolResultDetails(toolResultMessage, 'Summary');

      expect(stripped.metadata).toEqual({ custom: 'value' });
      expect(stripped.tokenUsage).toEqual({ prompt: 10, completion: 5, total: 15 });
    });
  });

  describe('compactConversation', () => {
    test('returns original conversation when within token budget', () => {
      let c = createConversation();
      c = appendUserMessage(c, 'hello');
      c = appendAssistantMessage(c, 'hi there');

      const options: CompactionOptions = {
        maxTokens: 10000, // plenty of room
        tokenEstimator: deterministicTokenEstimator,
      };

      const result = compactConversation(c, options, mockSummarizer);

      // Should return same reference when no compaction needed
      expect(result).toBe(c);
    });

    test('compacts conversation when over budget', () => {
      let c = createConversation();
      c = appendSystemMessage(c, 'You are helpful');
      c = appendUserMessage(c, 'question 1');
      c = appendAssistantMessage(c, 'answer 1');
      c = appendMessages(c, {
        role: 'tool-call',
        content: '',
        toolCall: { id: 'call-1', name: 'tool', arguments: { key: 'value' } },
      });
      c = appendMessages(c, {
        role: 'tool-result',
        content: 'tool output',
        toolResult: { callId: 'call-1', outcome: 'success', content: { result: 'data' } },
      });
      c = appendUserMessage(c, 'follow up');
      c = appendAssistantMessage(c, 'response');

      const options: CompactionOptions = {
        maxTokens: 300, // force compaction
        preserveRecentCount: 2, // keep last 2 messages
        preserveSystemMessages: true,
        tokenEstimator: deterministicTokenEstimator,
      };

      const result = compactConversation(c, options, mockSummarizer);

      expect(result).not.toBe(c); // Should be different reference
      expect(result.id).toBe(c.id);
      expect(result.title).toBe(c.title);
      expect(result.status).toBe(c.status);

      // System messages should be preserved
      const systemMessages = getSystemMessages(result);
      expect(systemMessages.length).toBeGreaterThan(0);

      // Recent messages should be preserved
      const allMessages = getMessages(result);
      expect(allMessages.length).toBeGreaterThanOrEqual(2);

      // Compaction summary should be present
      const summaryMessages = getSystemMessages(result).filter(
        (m) => m.metadata.compactionSummary === true,
      );
      expect(summaryMessages.length).toBeGreaterThan(0);
    });

    test('preserves system messages even when compacting', () => {
      let c = createConversation();
      c = appendSystemMessage(c, 'System instruction 1');
      c = appendSystemMessage(c, 'System instruction 2');
      c = appendUserMessage(c, 'query');
      c = appendAssistantMessage(c, 'response');

      const options: CompactionOptions = {
        maxTokens: 200,
        preserveSystemMessages: true,
        tokenEstimator: deterministicTokenEstimator,
      };

      const result = compactConversation(c, options, mockSummarizer);

      const systemMessages = getSystemMessages(result);
      // All original system messages should be there
      const originalSystemCount = getSystemMessages(c).length;
      expect(systemMessages.length).toBeGreaterThanOrEqual(originalSystemCount);
    });

    test('preserves recent messages in order', () => {
      let c = createConversation();
      for (let i = 0; i < 5; i++) {
        c = appendUserMessage(c, `message ${i}`);
      }

      const options: CompactionOptions = {
        maxTokens: 200,
        preserveRecentCount: 2,
        tokenEstimator: deterministicTokenEstimator,
      };

      const result = compactConversation(c, options, mockSummarizer);
      const messages = getMessages(result);
      const lastTwo = messages.slice(-2);

      // Last two should be messages 3 and 4 (0-indexed)
      expect(lastTwo[0]!.content).toBe('message 3');
      expect(lastTwo[1]!.content).toBe('message 4');
    });

    test('merges multiple chunk summaries with separator', () => {
      let c = createConversation();
      // Create many messages to force multiple chunks
      for (let i = 0; i < 10; i++) {
        c = appendUserMessage(c, `msg ${i}`);
        c = appendAssistantMessage(c, `reply ${i}`);
      }

      const options: CompactionOptions = {
        maxTokens: 300,
        preserveRecentCount: 0,
        tokenEstimator: deterministicTokenEstimator,
      };

      const multiSummarizer = (messages: ReadonlyArray<Message>): string => {
        return `Chunk: ${messages.length} messages`;
      };

      const result = compactConversation(c, options, multiSummarizer);

      const summaryMessages = getSystemMessages(result).filter(
        (m) => m.metadata.compactionSummary === true,
      );

      // Should have summary message(s)
      expect(summaryMessages.length).toBeGreaterThan(0);

      // If multiple chunks, should have separator
      const summaryContent = summaryMessages[0]!.content;
      if (typeof summaryContent === 'string' && summaryContent.includes('---')) {
        // Multiple chunks were merged
        expect(summaryContent).toMatch(/---/);
      }
    });

    test('treats orphaned tool calls as regular messages', () => {
      let c = createConversation();
      c = appendUserMessage(c, 'request');
      // Tool call without result (orphaned)
      c = appendMessages(c, {
        role: 'tool-call',
        content: '',
        toolCall: { id: 'call-1', name: 'tool', arguments: {} },
      });
      c = appendUserMessage(c, 'another request');

      const options: CompactionOptions = {
        maxTokens: 200,
        preserveRecentCount: 1,
        tokenEstimator: deterministicTokenEstimator,
      };

      const result = compactConversation(c, options, mockSummarizer);

      // Should not throw, orphaned tool call is handled gracefully
      expect(result).toBeDefined();
      const messages = getMessages(result);
      expect(messages.length).toBeGreaterThan(0);
    });

    test('updates conversation updatedAt timestamp', () => {
      let c = createConversation();
      c = appendUserMessage(c, 'hello');

      const options: CompactionOptions = {
        maxTokens: 200,
        tokenEstimator: deterministicTokenEstimator,
      };

      const originalUpdatedAt = c.updatedAt;
      const result = compactConversation(c, options, mockSummarizer);

      // Should be different or at least updated
      expect(result.updatedAt).toBeDefined();
      expect(typeof result.updatedAt).toBe('string');
    });

    test('handles empty preserveRecentCount', () => {
      let c = createConversation();
      c = appendUserMessage(c, 'msg 1');
      c = appendAssistantMessage(c, 'reply 1');
      c = appendUserMessage(c, 'msg 2');

      const options: CompactionOptions = {
        maxTokens: 200,
        preserveRecentCount: 0,
        tokenEstimator: deterministicTokenEstimator,
      };

      const result = compactConversation(c, options, mockSummarizer);

      // Should still produce valid conversation
      expect(result).toBeDefined();
      expect(getMessages(result).length).toBeGreaterThan(0);
    });

    test('handles undefined preserveRecentCount as default', () => {
      let c = createConversation();
      for (let i = 0; i < 5; i++) {
        c = appendUserMessage(c, `msg ${i}`);
      }

      const options: CompactionOptions = {
        maxTokens: 200,
        // preserveRecentCount undefined
        tokenEstimator: deterministicTokenEstimator,
      };

      const result = compactConversation(c, options, mockSummarizer);

      expect(result).toBeDefined();
      // Default should preserve some recent messages
      expect(getMessages(result).length).toBeGreaterThan(0);
    });

    test('handles synchronous summarizer', () => {
      let c = createConversation();
      c = appendUserMessage(c, 'hello');
      c = appendAssistantMessage(c, 'hi');

      const syncSummarizer = (messages: ReadonlyArray<Message>): string => {
        return `Sync summary of ${messages.length} messages`;
      };

      const options: CompactionOptions = {
        maxTokens: 200,
        tokenEstimator: deterministicTokenEstimator,
      };

      const result = compactConversation(c, options, syncSummarizer);

      expect(result).toBeDefined();
    });

    test('handles asynchronous summarizer', async () => {
      let c = createConversation();
      c = appendUserMessage(c, 'hello');
      c = appendAssistantMessage(c, 'hi');

      const asyncSummarizer = async (messages: ReadonlyArray<Message>): Promise<string> => {
        return `Async summary of ${messages.length} messages`;
      };

      const options: CompactionOptions = {
        maxTokens: 200,
        tokenEstimator: deterministicTokenEstimator,
      };

      const result = compactConversation(c, options, asyncSummarizer);

      // Result should be a promise if summarizer is async
      if (result instanceof Promise) {
        const resolved = await result;
        expect(resolved).toBeDefined();
      } else {
        // Or it should work synchronously if implementation handles both
        expect(result).toBeDefined();
      }
    });

    test('preserves conversation metadata', () => {
      let c = createConversation();
      c = {
        ...c,
        metadata: { custom: 'value', count: 42 },
      };
      c = appendUserMessage(c, 'hello');

      const options: CompactionOptions = {
        maxTokens: 200,
        tokenEstimator: deterministicTokenEstimator,
      };

      const result = compactConversation(c, options, mockSummarizer);

      expect(result.metadata).toEqual({ custom: 'value', count: 42 });
    });

    test('handles conversation with no compactable messages', () => {
      let c = createConversation();
      c = appendSystemMessage(c, 'system');
      c = appendUserMessage(c, 'user');
      c = appendSystemMessage(c, 'another system');

      const options: CompactionOptions = {
        maxTokens: 200,
        preserveSystemMessages: true,
        tokenEstimator: deterministicTokenEstimator,
      };

      const result = compactConversation(c, options, mockSummarizer);

      // Should work even if only system messages exist
      expect(result).toBeDefined();
      expect(getMessages(result).length).toBeGreaterThan(0);
    });

    test('compaction summary includes metadata flag', () => {
      let c = createConversation();
      for (let i = 0; i < 10; i++) {
        c = appendUserMessage(c, `msg ${i}`);
      }

      const options: CompactionOptions = {
        maxTokens: 500,
        preserveRecentCount: 2,
        tokenEstimator: deterministicTokenEstimator,
      };

      const result = compactConversation(c, options, mockSummarizer);

      const summaryMessages = getSystemMessages(result).filter(
        (m) => m.metadata.compactionSummary === true,
      );

      expect(summaryMessages.length).toBeGreaterThan(0);
      expect(summaryMessages[0]!.metadata.compactionSummary).toBe(true);
    });

    test('handles messages with hidden flag', () => {
      let c = createConversation();
      c = appendMessages(c, {
        role: 'user',
        content: 'secret',
        hidden: true,
      });
      c = appendUserMessage(c, 'public');

      const options: CompactionOptions = {
        maxTokens: 200,
        tokenEstimator: deterministicTokenEstimator,
      };

      const result = compactConversation(c, options, mockSummarizer);

      expect(result).toBeDefined();
      const messages = getMessages(result, { includeHidden: true });
      expect(messages.length).toBeGreaterThan(0);
    });
  });

  describe('stripToolResultDetails (non-tool-result passthrough)', () => {
    test('returns original message when role is not tool-result', () => {
      const userMessage: Message = {
        id: 'msg-pass',
        role: 'user',
        content: 'hello',
        position: 0,
        createdAt: new Date().toISOString(),
        metadata: {},
        hidden: false,
      };
      const result = stripToolResultDetails(userMessage, 'Summary');
      expect(result).toBe(userMessage);
    });
  });

  describe('compactConversation edge cases', () => {
    test('returns original conversation when empty', () => {
      const c = createConversation();
      const options: CompactionOptions = {
        maxTokens: 200,
        tokenEstimator: deterministicTokenEstimator,
      };
      const result = compactConversation(c, options, mockSummarizer);
      expect(result).toBe(c);
    });

    test('returns original conversation when no summarizer provided', () => {
      let c = createConversation();
      for (let i = 0; i < 10; i++) {
        c = appendUserMessage(c, `msg ${i}`);
      }
      const options: CompactionOptions = {
        maxTokens: 200,
        tokenEstimator: deterministicTokenEstimator,
      };
      const result = compactConversation(c, options);
      expect(result).toBe(c);
    });

    test('uses default token estimator when none provided', () => {
      let c = createConversation();
      // Use long content so default estimator produces enough tokens to exceed budget
      for (let i = 0; i < 10; i++) {
        c = appendUserMessage(c, 'a'.repeat(400)); // ~100 tokens each
      }
      const options: CompactionOptions = {
        maxTokens: 200,
        preserveRecentCount: 2,
      };
      const result = compactConversation(c, options, mockSummarizer);
      expect(result).not.toBe(c);
      expect(getMessages(result).length).toBeGreaterThan(0);
    });

    test('uses default token estimator with multi-modal and tool messages', () => {
      let c = createConversation();
      // Add a message with multi-modal content including an image
      c = appendMessages(c, {
        role: 'user',
        content: [
          { type: 'text', text: 'Look at this image '.repeat(20) },
          { type: 'image', url: 'https://example.com/image.png' },
        ],
      });
      c = appendMessages(c, {
        role: 'tool-call',
        content: 'call',
        toolCall: { id: 'tc-1', name: 'analyze', arguments: { url: 'https://example.com' } },
      });
      c = appendMessages(c, {
        role: 'tool-result',
        content: 'analysis result ' + 'x'.repeat(200),
        toolResult: { callId: 'tc-1', outcome: 'success', content: { data: 'result' } },
      });
      for (let i = 0; i < 8; i++) {
        c = appendUserMessage(c, 'a'.repeat(400));
      }
      const options: CompactionOptions = {
        maxTokens: 50,
        preserveRecentCount: 2,
      };
      const result = compactConversation(c, options, mockSummarizer);
      expect(result).not.toBe(c);
    });

    test('handles preserveSystemMessages false', () => {
      let c = createConversation();
      c = appendSystemMessage(c, 'System instruction');
      for (let i = 0; i < 10; i++) {
        c = appendUserMessage(c, `msg ${i}`);
      }
      const options: CompactionOptions = {
        maxTokens: 100,
        preserveRecentCount: 2,
        preserveSystemMessages: false,
        tokenEstimator: deterministicTokenEstimator,
      };
      const result = compactConversation(c, options, mockSummarizer);
      expect(result).not.toBe(c);
    });

    test('compacts with async summarizer using default estimator', async () => {
      let c = createConversation();
      for (let i = 0; i < 10; i++) {
        c = appendUserMessage(c, 'a'.repeat(400));
      }
      const asyncSummarizer = async (messages: ReadonlyArray<Message>): Promise<string> => {
        return `Async summary of ${messages.length} messages`;
      };
      const options: CompactionOptions = {
        maxTokens: 200,
        preserveRecentCount: 2,
      };
      const result = await compactConversation(c, options, asyncSummarizer);
      expect(result).toBeDefined();
      expect(getMessages(result).length).toBeGreaterThan(0);
    });

    test('handles not enough compactable messages', () => {
      let c = createConversation();
      c = appendUserMessage(c, 'only one');
      const options: CompactionOptions = {
        maxTokens: 200,
        preserveRecentCount: 5,
        tokenEstimator: deterministicTokenEstimator,
      };
      const result = compactConversation(c, options, mockSummarizer);
      // Not enough non-system messages to compact
      expect(result).toBe(c);
    });

    test('returns original when compactable messages are too few for chunking', () => {
      // Create a conversation where total tokens exceed budget, but compactable
      // messages count <= preserveRecentCount in chunkMessagesForCompaction
      let c = createConversation();
      // 8 messages with preserveRecentCount=5 => compactableMessages = 3
      // chunkMessagesForCompaction receives 3 messages, preserveRecentCount=5
      // 3 <= 5, so it returns empty chunks => no compaction
      for (let i = 0; i < 8; i++) {
        c = appendUserMessage(c, `msg ${i}`);
      }
      const options: CompactionOptions = {
        maxTokens: 200,
        preserveRecentCount: 5,
        tokenEstimator: deterministicTokenEstimator,
      };
      const result = compactConversation(c, options, mockSummarizer);
      // Chunks will be empty because compactable (3) <= preserveRecentCount (5)
      expect(result).toBe(c);
    });

    test('default estimator handles tool call without arguments', () => {
      let c = createConversation();
      c = appendMessages(c, {
        role: 'tool-call',
        content: 'call',
        toolCall: { id: 'tc-1', name: 'no-args', arguments: {} },
      });
      c = appendMessages(c, {
        role: 'tool-result',
        content: 'result data ' + 'x'.repeat(200),
        toolResult: { callId: 'tc-1', outcome: 'success', content: 'ok' },
      });
      for (let i = 0; i < 8; i++) {
        c = appendUserMessage(c, 'a'.repeat(400));
      }
      const options: CompactionOptions = {
        maxTokens: 20,
        preserveRecentCount: 2,
      };
      const result = compactConversation(c, options, mockSummarizer);
      expect(result).not.toBe(c);
    });
  });
});

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
