import { createTool, createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { appendMessages, Conversation, createConversationHistory } from 'conversationalist';
import { z } from 'zod';

import { HeraldError } from '../src/errors.ts';
import { createGeminiGenerateStream } from '../src/gemini.ts';
import {
  geminiStreamEmptyChunks,
  geminiStreamFunctionCallChunks,
  geminiStreamMixedChunks,
  geminiStreamMultiFunctionCallChunks,
  geminiStreamTextChunks,
} from '../src/test/fixtures.ts';
import { createMockGeminiStreamingModel } from '../src/test/mock-clients.ts';
import type {
  GeminiGenerateContentResult,
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

describe('Gemini streaming', () => {
  describe('basic text streaming with progressive update calls', () => {
    it('calls streaming.update for each text chunk and returns accumulated content', async () => {
      const model = createMockGeminiStreamingModel([geminiStreamTextChunks]);
      const generate: StreamingGenerateFunction = createGeminiGenerateStream({
        model: 'gemini-pro',
        client: model,
      });
      const { context, updates } = createStreamingContext();

      const result = await generate(context);

      expect(result.content).toBe('Hello from Gemini!');
      expect(result.toolCalls).toEqual([]);
      expect(updates).toEqual(['Hello ', 'Hello from Gemini!']);
    });
  });

  describe('tool call fragment accumulation and reassembly', () => {
    it('collects functionCall parts into complete tool calls', async () => {
      const model = createMockGeminiStreamingModel([geminiStreamFunctionCallChunks]);
      const generate: StreamingGenerateFunction = createGeminiGenerateStream({
        model: 'gemini-pro',
        client: model,
      });
      const { context, updates } = createStreamingContext();

      const result = await generate(context);

      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0]).toMatchObject({
        name: 'get_weather',
        arguments: { location: 'San Francisco' },
      });
      expect(updates).toEqual([]);
    });
  });

  describe('mixed text and tool calls in one stream', () => {
    it('populates both content and toolCalls from mixed chunks', async () => {
      const model = createMockGeminiStreamingModel([geminiStreamMixedChunks]);
      const generate: StreamingGenerateFunction = createGeminiGenerateStream({
        model: 'gemini-pro',
        client: model,
      });
      const { context, updates } = createStreamingContext();

      const result = await generate(context);

      expect(result.content).toBe('Checking weather...');
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0]).toMatchObject({
        name: 'get_weather',
        arguments: { location: 'Tokyo' },
      });
      expect(updates).toEqual(['Checking weather...']);
    });
  });

  describe('multiple concurrent tool calls in one stream', () => {
    it('collects two function calls from the same response chunk', async () => {
      const model = createMockGeminiStreamingModel([geminiStreamMultiFunctionCallChunks]);
      const generate: StreamingGenerateFunction = createGeminiGenerateStream({
        model: 'gemini-pro',
        client: model,
      });
      const { context } = createStreamingContext();

      const result = await generate(context);

      expect(result.toolCalls).toHaveLength(2);
      expect(result.toolCalls[0]).toMatchObject({
        name: 'get_weather',
        arguments: { location: 'Paris' },
      });
      expect(result.toolCalls[1]).toMatchObject({
        name: 'get_weather',
        arguments: { location: 'London' },
      });
    });
  });

  describe('error mid-stream', () => {
    it('throws HeraldError when the stream errors after yielding some chunks', async () => {
      const textChunksForError: GeminiGenerateContentResult['response'][] = [
        { candidates: [{ content: { parts: [{ text: 'Hello ' }] } }] },
        { candidates: [{ content: { parts: [{ text: 'world' }] } }] },
        { candidates: [{ content: { parts: [{ text: '!' }] } }] },
      ];
      const midStreamError = new Error('Connection lost mid-stream');
      const model = createMockGeminiStreamingModel([textChunksForError], [midStreamError], {
        errorAfterEvents: 1,
      });
      const generate: StreamingGenerateFunction = createGeminiGenerateStream({
        model: 'gemini-pro',
        client: model,
      });
      const { context, updates } = createStreamingContext();

      try {
        await generate(context);
        expect.unreachable('Expected generate to throw');
      } catch (error) {
        expect(error).toBeInstanceOf(HeraldError);
        const heraldError = error as HeraldError;
        expect(heraldError.provider).toBe('gemini');
        expect(heraldError.cause).toBe(midStreamError);
      }

      expect(updates.length).toBeGreaterThan(0);
    });

    it('throws HeraldError when errorAfterEvents exceeds chunk count', async () => {
      const postStreamError = new Error('Post-stream failure');
      const model = createMockGeminiStreamingModel([geminiStreamTextChunks], [postStreamError], {
        errorAfterEvents: 999,
      });
      const generate: StreamingGenerateFunction = createGeminiGenerateStream({
        model: 'gemini-pro',
        client: model,
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
    it('returns empty content and no tool calls from empty candidates', async () => {
      const model = createMockGeminiStreamingModel([geminiStreamEmptyChunks]);
      const generate: StreamingGenerateFunction = createGeminiGenerateStream({
        model: 'gemini-pro',
        client: model,
      });
      const { context, updates } = createStreamingContext();

      const result = await generate(context);

      expect(result.content).toBe('');
      expect(result.toolCalls).toEqual([]);
      expect(updates).toEqual([]);
    });
  });

  describe('usage tracking from stream chunks', () => {
    it('extracts usageMetadata from the last chunk', async () => {
      const model = createMockGeminiStreamingModel([geminiStreamTextChunks]);
      const generate: StreamingGenerateFunction = createGeminiGenerateStream({
        model: 'gemini-pro',
        client: model,
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
      const model = createMockGeminiStreamingModel([geminiStreamTextChunks]);
      const generate: StreamingGenerateFunction = createGeminiGenerateStream({
        model: 'gemini-pro',
        client: model,
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
      const chunks = geminiStreamTextChunks;
      type GeminiChunk = GeminiGenerateContentResult['response'];
      const calls: Array<Record<string, unknown>> = [];
      const model = {
        _calls: calls,
        _chunkSequences: [chunks],
        _errors: [],
        async generateContentStream(
          params: Record<string, unknown>,
        ): Promise<{ stream: AsyncIterable<GeminiChunk> }> {
          calls.push(params);
          let chunkIndex = 0;
          return {
            stream: {
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
            },
          };
        },
      };

      const generate: StreamingGenerateFunction = createGeminiGenerateStream({
        model: 'gemini-pro',
        client: model,
      });
      const { context, updates } = createStreamingContext({ signal: controller.signal });

      const result = await generate(context);

      // Should have the first chunk but not the second
      expect(result.content).toBe('Hello ');
      expect(updates).toEqual(['Hello ']);
    });
  });

  describe('missing usage handling', () => {
    it('returns undefined usage when no chunk contains usageMetadata', async () => {
      const chunksWithoutUsage: GeminiGenerateContentResult['response'][] = [
        { candidates: [{ content: { parts: [{ text: 'No usage info.' }] } }] },
      ];
      const model = createMockGeminiStreamingModel([chunksWithoutUsage]);
      const generate: StreamingGenerateFunction = createGeminiGenerateStream({
        model: 'gemini-pro',
        client: model,
      });
      const { context } = createStreamingContext();

      const result = await generate(context);

      expect(result.usage).toBeUndefined();
    });
  });
});
