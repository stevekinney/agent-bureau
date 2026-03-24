import { createTool, createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { appendMessages, Conversation, createConversationHistory } from 'conversationalist';
import { z } from 'zod';

import { HeraldError } from '../src/errors.ts';
import { createOpenAIGenerateStream } from '../src/openai.ts';
import {
  openAIStreamEmptyChunks,
  openAIStreamMixedChunks,
  openAIStreamMultiToolChunks,
  openAIStreamTextChunks,
  openAIStreamToolCallChunks,
} from '../src/test/fixtures.ts';
import { createMockOpenAIStreamingClient } from '../src/test/mock-clients.ts';
import type {
  GenerateContext,
  OpenAIChatCompletionChunk,
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

describe('OpenAI streaming', () => {
  describe('basic text streaming with progressive update calls', () => {
    it('calls streaming.update for each text delta and returns accumulated content', async () => {
      const client = createMockOpenAIStreamingClient([openAIStreamTextChunks]);
      const generate: StreamingGenerateFunction = createOpenAIGenerateStream({
        model: 'gpt-4o',
        client,
      });
      const { context, updates } = createStreamingContext();

      const result = await generate(context);

      expect(result.content).toBe('Hello from OpenAI!');
      expect(result.toolCalls).toEqual([]);
      expect(updates).toEqual(['Hello ', 'Hello from OpenAI!']);
    });
  });

  describe('tool call fragment accumulation and reassembly', () => {
    it('accumulates partial argument fragments into a complete tool call', async () => {
      const client = createMockOpenAIStreamingClient([openAIStreamToolCallChunks]);
      const generate: StreamingGenerateFunction = createOpenAIGenerateStream({
        model: 'gpt-4o',
        client,
      });
      const { context, updates } = createStreamingContext();

      const result = await generate(context);

      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0]).toMatchObject({
        id: 'call_01',
        name: 'get_weather',
        arguments: { location: 'San Francisco' },
      });
      expect(updates).toEqual([]);
    });
  });

  describe('mixed text and tool calls in one stream', () => {
    it('populates both content and toolCalls from mixed chunks', async () => {
      const client = createMockOpenAIStreamingClient([openAIStreamMixedChunks]);
      const generate: StreamingGenerateFunction = createOpenAIGenerateStream({
        model: 'gpt-4o',
        client,
      });
      const { context, updates } = createStreamingContext();

      const result = await generate(context);

      expect(result.content).toBe('Checking weather.');
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0]).toMatchObject({
        id: 'call_mixed_01',
        name: 'get_weather',
        arguments: { location: 'NYC' },
      });
      expect(updates).toEqual(['Checking ', 'Checking weather.']);
    });
  });

  describe('multiple concurrent tool calls in one stream', () => {
    it('collects two tool calls with different indices from the same stream', async () => {
      const client = createMockOpenAIStreamingClient([openAIStreamMultiToolChunks]);
      const generate: StreamingGenerateFunction = createOpenAIGenerateStream({
        model: 'gpt-4o',
        client,
      });
      const { context } = createStreamingContext();

      const result = await generate(context);

      expect(result.toolCalls).toHaveLength(2);
      expect(result.toolCalls[0]).toMatchObject({
        id: 'call_multi_01',
        name: 'get_weather',
        arguments: { location: 'Paris' },
      });
      expect(result.toolCalls[1]).toMatchObject({
        id: 'call_multi_02',
        name: 'get_weather',
        arguments: { location: 'London' },
      });
    });
  });

  describe('error mid-stream', () => {
    it('throws HeraldError when the stream errors after yielding some chunks', async () => {
      const midStreamError = new Error('Connection lost mid-stream');
      const client = createMockOpenAIStreamingClient([openAIStreamTextChunks], [midStreamError], {
        errorAfterEvents: 1,
      });
      const generate: StreamingGenerateFunction = createOpenAIGenerateStream({
        model: 'gpt-4o',
        client,
      });
      const { context, updates } = createStreamingContext();

      try {
        await generate(context);
        expect.unreachable('Expected generate to throw');
      } catch (error) {
        expect(error).toBeInstanceOf(HeraldError);
        const heraldError = error as HeraldError;
        expect(heraldError.provider).toBe('openai');
        expect(heraldError.cause).toBe(midStreamError);
      }

      expect(updates.length).toBeGreaterThan(0);
    });

    it('throws HeraldError when errorAfterEvents exceeds chunk count', async () => {
      const postStreamError = new Error('Post-stream failure');
      const client = createMockOpenAIStreamingClient([openAIStreamTextChunks], [postStreamError], {
        errorAfterEvents: 999,
      });
      const generate: StreamingGenerateFunction = createOpenAIGenerateStream({
        model: 'gpt-4o',
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
    it('returns empty content and no tool calls from a single finish chunk', async () => {
      const client = createMockOpenAIStreamingClient([openAIStreamEmptyChunks]);
      const generate: StreamingGenerateFunction = createOpenAIGenerateStream({
        model: 'gpt-4o',
        client,
      });
      const { context, updates } = createStreamingContext();

      const result = await generate(context);

      expect(result.content).toBe('');
      expect(result.toolCalls).toEqual([]);
      expect(updates).toEqual([]);
    });
  });

  describe('usage tracking from stream chunks', () => {
    it('extracts usage from the final chunk', async () => {
      const client = createMockOpenAIStreamingClient([openAIStreamTextChunks]);
      const generate: StreamingGenerateFunction = createOpenAIGenerateStream({
        model: 'gpt-4o',
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
      const client = createMockOpenAIStreamingClient([openAIStreamTextChunks]);
      const generate: StreamingGenerateFunction = createOpenAIGenerateStream({
        model: 'gpt-4o',
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
      const controller = new AbortController();
      const chunks = openAIStreamTextChunks;
      const calls: Array<Record<string, unknown>> = [];
      const client = {
        _calls: calls,
        _chunkSequences: [chunks],
        _errors: [],
        chat: {
          completions: {
            create(params: Record<string, unknown>): AsyncIterable<OpenAIChatCompletionChunk> {
              calls.push(params);
              let chunkIndex = 0;
              return {
                [Symbol.asyncIterator]() {
                  return {
                    async next() {
                      if (chunkIndex >= chunks.length) return { done: true, value: undefined };
                      const chunk = chunks[chunkIndex++]!;
                      // Abort before yielding the second chunk
                      if (chunkIndex === 2) controller.abort();
                      return { done: false, value: chunk };
                    },
                  };
                },
              };
            },
          },
        },
      };

      const generate: StreamingGenerateFunction = createOpenAIGenerateStream({
        model: 'gpt-4o',
        client,
      });
      const { context, updates } = createStreamingContext({ signal: controller.signal });

      const result = await generate(context);

      // Should have the first chunk but not subsequent ones
      expect(result.content).toBe('Hello ');
      expect(updates).toEqual(['Hello ']);
    });
  });

  describe('missing usage handling', () => {
    it('returns undefined usage when no chunk contains usage', async () => {
      const chunksWithoutUsage: OpenAIChatCompletionChunk[] = [
        { choices: [{ delta: { content: 'Hi' }, finish_reason: null }], usage: null },
        { choices: [{ delta: {}, finish_reason: 'stop' }], usage: null },
      ];
      const client = createMockOpenAIStreamingClient([chunksWithoutUsage]);
      const generate: StreamingGenerateFunction = createOpenAIGenerateStream({
        model: 'gpt-4o',
        client,
      });
      const { context } = createStreamingContext();

      const result = await generate(context);

      expect(result.usage).toBeUndefined();
    });
  });
});
