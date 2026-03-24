import { createTool, createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { appendMessages, Conversation, createConversationHistory } from 'conversationalist';
import { z } from 'zod';

import { createAnthropicGenerateStream } from '../src/anthropic.ts';
import { HeraldError } from '../src/errors.ts';
import {
  anthropicStreamEmptyEvents,
  anthropicStreamMixedEvents,
  anthropicStreamMultiToolEvents,
  anthropicStreamTextEvents,
  anthropicStreamToolUseEvents,
} from '../src/test/fixtures.ts';
import { createMockAnthropicStreamingClient } from '../src/test/mock-clients.ts';
import type {
  AnthropicStreamEvent,
  GenerateContext,
  StreamingGenerateFunction,
} from '../src/types.ts';

function createTestContext(overrides: Partial<GenerateContext> = {}): GenerateContext {
  const history = createConversationHistory();
  const withMessage = appendMessages(history, { role: 'user', content: 'Hello' });
  const conversation = new Conversation(withMessage);

  const toolbox = createToolbox([
    createTool({
      name: 'get_weather',
      description: 'Get weather',
      input: z.object({ location: z.string() }),
      execute: async () => ({ temperature: 72, location: 'test' }),
    }),
  ]);

  return { conversation, step: 1, toolbox, ...overrides };
}

function createStreamingContext(overrides: Partial<GenerateContext> = {}) {
  const updates: string[] = [];
  const streaming = {
    messageId: 'msg-1',
    update: (content: string) => updates.push(content),
  };
  const context = createTestContext(overrides);
  return { context: { ...context, streaming }, updates };
}

describe('Anthropic streaming', () => {
  describe('basic text streaming with progressive update calls', () => {
    it('calls streaming.update for each text delta and returns accumulated content', async () => {
      const client = createMockAnthropicStreamingClient([anthropicStreamTextEvents]);
      const generate: StreamingGenerateFunction = createAnthropicGenerateStream({
        model: 'claude-sonnet-4-20250514',
        client,
      });
      const { context, updates } = createStreamingContext();

      const result = await generate(context);

      expect(result.content).toBe('Hello from Anthropic!');
      expect(result.toolCalls).toEqual([]);
      expect(updates).toEqual(['Hello ', 'Hello from Anthropic!']);
    });
  });

  describe('tool call fragment accumulation and reassembly', () => {
    it('accumulates partial JSON fragments into a complete tool call', async () => {
      const client = createMockAnthropicStreamingClient([anthropicStreamToolUseEvents]);
      const generate: StreamingGenerateFunction = createAnthropicGenerateStream({
        model: 'claude-sonnet-4-20250514',
        client,
      });
      const { context, updates } = createStreamingContext();

      const result = await generate(context);

      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0]).toEqual(
        expect.objectContaining({
          name: 'get_weather',
          id: 'toolu_01',
          arguments: { location: 'San Francisco' },
        }),
      );
      expect(updates).toEqual([]);
    });
  });

  describe('mixed text and tool calls in one stream', () => {
    it('populates both content and toolCalls from mixed events', async () => {
      const client = createMockAnthropicStreamingClient([anthropicStreamMixedEvents]);
      const generate: StreamingGenerateFunction = createAnthropicGenerateStream({
        model: 'claude-sonnet-4-20250514',
        client,
      });
      const { context, updates } = createStreamingContext();

      const result = await generate(context);

      expect(result.content).toBe('Let me check.');
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0]).toEqual(
        expect.objectContaining({
          name: 'get_weather',
          id: 'toolu_mixed_01',
          arguments: { location: 'New York' },
        }),
      );
      expect(updates).toEqual(['Let me check.']);
    });
  });

  describe('multiple concurrent tool calls in one stream', () => {
    it('collects two tool_use blocks from the same message', async () => {
      const client = createMockAnthropicStreamingClient([anthropicStreamMultiToolEvents]);
      const generate: StreamingGenerateFunction = createAnthropicGenerateStream({
        model: 'claude-sonnet-4-20250514',
        client,
      });
      const { context } = createStreamingContext();

      const result = await generate(context);

      expect(result.toolCalls).toHaveLength(2);
      expect(result.toolCalls[0]).toEqual(
        expect.objectContaining({
          name: 'get_weather',
          id: 'toolu_multi_01',
          arguments: { location: 'Paris' },
        }),
      );
      expect(result.toolCalls[1]).toEqual(
        expect.objectContaining({
          name: 'get_weather',
          id: 'toolu_multi_02',
          arguments: { location: 'London' },
        }),
      );
    });
  });

  describe('error mid-stream', () => {
    it('throws HeraldError when the stream errors after yielding some events', async () => {
      const midStreamError = new Error('Connection lost mid-stream');
      const client = createMockAnthropicStreamingClient(
        [anthropicStreamTextEvents],
        [midStreamError],
        { errorAfterEvents: 3 },
      );
      const generate: StreamingGenerateFunction = createAnthropicGenerateStream({
        model: 'claude-sonnet-4-20250514',
        client,
      });
      const { context, updates } = createStreamingContext();

      try {
        await generate(context);
        expect.unreachable('Expected generate to throw');
      } catch (error) {
        expect(error).toBeInstanceOf(HeraldError);
        const heraldError = error as HeraldError;
        expect(heraldError.provider).toBe('anthropic');
        expect(heraldError.cause).toBe(midStreamError);
      }

      expect(updates.length).toBeGreaterThan(0);
    });

    it('throws HeraldError when errorAfterEvents exceeds event count', async () => {
      const postStreamError = new Error('Post-stream failure');
      const client = createMockAnthropicStreamingClient(
        [anthropicStreamTextEvents],
        [postStreamError],
        { errorAfterEvents: 999 },
      );
      const generate: StreamingGenerateFunction = createAnthropicGenerateStream({
        model: 'claude-sonnet-4-20250514',
        client,
      });
      const { context } = createStreamingContext();

      try {
        await generate(context);
        expect.unreachable('Expected generate to throw');
      } catch (error) {
        expect(error).toBeInstanceOf(HeraldError);
        expect((error as HeraldError).cause).toBe(postStreamError);
      }
    });
  });

  describe('empty stream', () => {
    it('returns empty content and no tool calls when stream has no content blocks', async () => {
      const client = createMockAnthropicStreamingClient([anthropicStreamEmptyEvents]);
      const generate: StreamingGenerateFunction = createAnthropicGenerateStream({
        model: 'claude-sonnet-4-20250514',
        client,
      });
      const { context, updates } = createStreamingContext();

      const result = await generate(context);

      expect(result.content).toBe('');
      expect(result.toolCalls).toEqual([]);
      expect(updates).toEqual([]);
    });
  });

  describe('usage tracking from stream events', () => {
    it('maps input_tokens from message_start and output_tokens from message_delta', async () => {
      const client = createMockAnthropicStreamingClient([anthropicStreamTextEvents]);
      const generate: StreamingGenerateFunction = createAnthropicGenerateStream({
        model: 'claude-sonnet-4-20250514',
        client,
      });
      const { context } = createStreamingContext();

      const result = await generate(context);

      expect(result.usage).toEqual({
        prompt: 10,
        completion: 5,
        total: 15,
      });
    });
  });

  describe('signal.aborted check in streaming loop', () => {
    it('processes no chunks when the signal is already aborted before streaming', async () => {
      const client = createMockAnthropicStreamingClient([anthropicStreamTextEvents]);
      const generate: StreamingGenerateFunction = createAnthropicGenerateStream({
        model: 'claude-sonnet-4-20250514',
        client,
      });
      const controller = new AbortController();
      controller.abort();
      const { context, updates } = createStreamingContext({ signal: controller.signal });

      const result = await generate(context);

      expect(result.content).toBe('');
      expect(result.toolCalls).toEqual([]);
      expect(updates).toEqual([]);
    });

    it('stops processing chunks after the signal is aborted mid-stream', async () => {
      // Create events where the abort happens after the first text delta
      const events: AnthropicStreamEvent[] = [
        {
          type: 'message_start',
          message: { usage: { input_tokens: 10, output_tokens: 0 } },
        },
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'Hello ' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'World' },
        },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_stop' },
      ];

      const controller = new AbortController();
      // Create a custom streaming client that aborts after the first text delta is processed
      const calls: Array<Record<string, unknown>> = [];
      const client = {
        _calls: calls,
        _eventSequences: [events],
        _errors: [],
        messages: {
          create(params: Record<string, unknown>): AsyncIterable<AnthropicStreamEvent> {
            calls.push(params);
            let eventIndex = 0;
            return {
              [Symbol.asyncIterator]() {
                return {
                  async next() {
                    if (eventIndex >= events.length) return { done: true, value: undefined };
                    const event = events[eventIndex++]!;
                    // Abort before yielding the second content_block_delta (4th event)
                    // The abort is set when yielding the 3rd event, so the check at the
                    // top of the next iteration catches it before processing the 4th event.
                    if (eventIndex === 4) controller.abort();
                    return { done: false, value: event };
                  },
                };
              },
            };
          },
        },
      };

      const generate: StreamingGenerateFunction = createAnthropicGenerateStream({
        model: 'claude-sonnet-4-20250514',
        client,
      });
      const { context, updates } = createStreamingContext({ signal: controller.signal });

      const result = await generate(context);

      // Should have the first text delta but not the second
      expect(result.content).toBe('Hello ');
      expect(updates).toEqual(['Hello ']);
    });
  });

  describe('missing usage handling', () => {
    it('returns undefined usage when events contain no usage fields', async () => {
      const noUsageEvents: AnthropicStreamEvent[] = [
        { type: 'message_start', message: {} },
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'Hi' },
        },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
        { type: 'message_stop' },
      ];

      const client = createMockAnthropicStreamingClient([noUsageEvents]);
      const generate: StreamingGenerateFunction = createAnthropicGenerateStream({
        model: 'claude-sonnet-4-20250514',
        client,
      });
      const { context } = createStreamingContext();

      const result = await generate(context);

      expect(result.usage).toBeUndefined();
    });
  });
});
