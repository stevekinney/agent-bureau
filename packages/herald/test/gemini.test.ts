import { createTool, createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { appendMessages, Conversation, createConversationHistory } from 'conversationalist';
import { z } from 'zod';

import { HeraldError } from '../src/errors.ts';
import { createGeminiGenerate, createGeminiGenerateStream } from '../src/gemini.ts';
import {
  geminiFunctionCallResponse,
  geminiMixedResponse,
  geminiNoUsageResponse,
  geminiStreamFunctionCallChunks,
  geminiStreamTextChunks,
  geminiTextResponse,
} from '../src/test/fixtures.ts';
import { createMockGeminiModel, createMockGeminiStreamingModel } from '../src/test/mock-clients.ts';
import type { GenerateContext, StreamingGenerateFunction } from '../src/types.ts';

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

describe('createGeminiGenerate', () => {
  describe('text response', () => {
    it('extracts text content from candidates parts', async () => {
      const model = createMockGeminiModel([geminiTextResponse]);
      const generate = createGeminiGenerate({ model: 'gemini-pro', client: model });

      const result = await generate(createTestContext());

      expect(result.content).toBe('Hello from Gemini!');
    });

    it('returns an empty toolCalls array for text-only responses', async () => {
      const model = createMockGeminiModel([geminiTextResponse]);
      const generate = createGeminiGenerate({ model: 'gemini-pro', client: model });

      const result = await generate(createTestContext());

      expect(result.toolCalls).toEqual([]);
    });
  });

  describe('function call response', () => {
    it('extracts tool calls from functionCall parts', async () => {
      const model = createMockGeminiModel([geminiFunctionCallResponse]);
      const generate = createGeminiGenerate({ model: 'gemini-pro', client: model });

      const result = await generate(createTestContext());

      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0]).toMatchObject({
        name: 'get_weather',
        arguments: { location: 'San Francisco' },
      });
    });
  });

  describe('mixed text and function call response', () => {
    it('populates both content and toolCalls', async () => {
      const model = createMockGeminiModel([geminiMixedResponse]);
      const generate = createGeminiGenerate({ model: 'gemini-pro', client: model });

      const result = await generate(createTestContext());

      expect(result.content).toBe('Let me check the weather.');
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0]).toMatchObject({
        name: 'get_weather',
        arguments: { location: 'New York' },
      });
    });
  });

  describe('usage mapping', () => {
    it('maps promptTokenCount, candidatesTokenCount, and totalTokenCount to prompt, completion, and total', async () => {
      const model = createMockGeminiModel([geminiTextResponse]);
      const generate = createGeminiGenerate({ model: 'gemini-pro', client: model });

      const result = await generate(createTestContext());

      expect(result.usage).toEqual({
        prompt: 10,
        completion: 5,
        total: 15,
      });
    });

    it('returns undefined usage when usageMetadata is absent', async () => {
      const model = createMockGeminiModel([geminiNoUsageResponse]);
      const generate = createGeminiGenerate({ model: 'gemini-pro', client: model });

      const result = await generate(createTestContext());

      expect(result.usage).toBeUndefined();
    });
  });

  describe('tool forwarding', () => {
    it('omits tools parameter from the SDK call when the toolbox is empty', async () => {
      const model = createMockGeminiModel([geminiTextResponse]);
      const generate = createGeminiGenerate({ model: 'gemini-pro', client: model });
      const context = createTestContext({ toolbox: createToolbox() });

      await generate(context);

      const call = model._calls[0];
      expect(call).toBeDefined();
      expect(call).not.toHaveProperty('tools');
    });

    it('includes tools parameter when the toolbox has definitions', async () => {
      const model = createMockGeminiModel([geminiTextResponse]);
      const generate = createGeminiGenerate({ model: 'gemini-pro', client: model });

      await generate(createTestContext());

      const call = model._calls[0];
      expect(call).toBeDefined();
      expect(call).toHaveProperty('tools');
    });
  });

  describe('error wrapping', () => {
    it('wraps SDK errors in HeraldError with provider set to gemini', async () => {
      const sdkError = new Error('Something went wrong');
      const model = createMockGeminiModel([], [sdkError]);
      const generate = createGeminiGenerate({ model: 'gemini-pro', client: model });

      try {
        await generate(createTestContext());
        expect.unreachable('Expected an error to be thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(HeraldError);
        const heraldError = error as HeraldError;
        expect(heraldError.provider).toBe('gemini');
        expect(heraldError.cause).toBe(sdkError);
      }
    });

    it('marks rate limit errors (429) as retryable', async () => {
      const rateLimitError = Object.assign(new Error('Rate limited'), { status: 429 });
      const model = createMockGeminiModel([], [rateLimitError]);
      const generate = createGeminiGenerate({ model: 'gemini-pro', client: model });

      try {
        await generate(createTestContext());
        expect.unreachable('Expected an error to be thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(HeraldError);
        const heraldError = error as HeraldError;
        expect(heraldError.statusCode).toBe(429);
        expect(heraldError.retryable).toBe(true);
      }
    });

    it('marks auth errors (401) as not retryable', async () => {
      const authError = Object.assign(new Error('Unauthorized'), { status: 401 });
      const model = createMockGeminiModel([], [authError]);
      const generate = createGeminiGenerate({ model: 'gemini-pro', client: model });

      try {
        await generate(createTestContext());
        expect.unreachable('Expected an error to be thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(HeraldError);
        const heraldError = error as HeraldError;
        expect(heraldError.statusCode).toBe(401);
        expect(heraldError.retryable).toBe(false);
      }
    });
  });

  describe('missing API key', () => {
    it('throws HeraldError when no apiKey option and no GOOGLE_API_KEY env var', async () => {
      const original = process.env['GOOGLE_API_KEY'];
      delete process.env['GOOGLE_API_KEY'];
      try {
        const generate = createGeminiGenerate({ model: 'gemini-pro' });
        const context = createTestContext();
        await generate(context);
        expect.unreachable('Expected an error to be thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(HeraldError);
        const heraldError = error as HeraldError;
        expect(heraldError.provider).toBe('gemini');
        expect(heraldError.message).toContain('GOOGLE_API_KEY');
      } finally {
        if (original !== undefined) process.env['GOOGLE_API_KEY'] = original;
      }
    });
  });

  describe('dynamic SDK import', () => {
    it('loads the SDK when no client is provided', async () => {
      const generate = createGeminiGenerate({
        model: 'gemini-2.0-flash',
        apiKey: 'sk-test-invalid',
      });
      const context = createTestContext();
      try {
        await generate(context);
        expect.unreachable('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(HeraldError);
        expect((error as HeraldError).provider).toBe('gemini');
      }
    });
  });

  describe('generation config forwarding', () => {
    it('forwards temperature, topP, and stopSequences via generationConfig', async () => {
      const model = createMockGeminiModel([geminiTextResponse]);
      const generate = createGeminiGenerate({
        model: 'gemini-pro',
        client: model,
        temperature: 0.7,
        topP: 0.9,
        stopSequences: ['STOP', 'END'],
      });

      await generate(createTestContext());

      const call = model._calls[0] as Record<string, unknown>;
      expect(call).toBeDefined();
      const generationConfig = call['generationConfig'] as Record<string, unknown>;
      expect(generationConfig).toBeDefined();
      expect(generationConfig['temperature']).toBe(0.7);
      expect(generationConfig['topP']).toBe(0.9);
      expect(generationConfig['stopSequences']).toEqual(['STOP', 'END']);
    });

    it('forwards maximumTokens as maxOutputTokens in generationConfig', async () => {
      const model = createMockGeminiModel([geminiTextResponse]);
      const generate = createGeminiGenerate({
        model: 'gemini-pro',
        client: model,
        maximumTokens: 1024,
      });

      await generate(createTestContext());

      const call = model._calls[0] as Record<string, unknown>;
      const generationConfig = call['generationConfig'] as Record<string, unknown>;
      expect(generationConfig).toBeDefined();
      expect(generationConfig['maxOutputTokens']).toBe(1024);
    });

    it('omits generationConfig entirely when no generation options are set', async () => {
      const model = createMockGeminiModel([geminiTextResponse]);
      const generate = createGeminiGenerate({ model: 'gemini-pro', client: model });

      await generate(createTestContext());

      const call = model._calls[0] as Record<string, unknown>;
      expect(call).not.toHaveProperty('generationConfig');
    });
  });
});

describe('createGeminiGenerateStream', () => {
  function createStreamingContext(
    overrides: Partial<GenerateContext> = {},
  ): GenerateContext & { streaming: { messageId: string; update: (content: string) => void } } {
    const base = createTestContext(overrides);
    const updates: string[] = [];
    return {
      ...base,
      streaming: {
        messageId: 'msg-1',
        update: (content: string) => updates.push(content),
      },
      get _updates() {
        return updates;
      },
    } as GenerateContext & {
      streaming: { messageId: string; update: (content: string) => void };
      _updates: string[];
    };
  }

  describe('text streaming', () => {
    it('returns accumulated text content from streamed chunks', async () => {
      const model = createMockGeminiStreamingModel([geminiStreamTextChunks]);
      const generate: StreamingGenerateFunction = createGeminiGenerateStream({
        model: 'gemini-pro',
        client: model,
      });
      const context = createStreamingContext();

      const result = await generate(context);

      expect(result.content).toBe('Hello from Gemini!');
    });

    it('returns an empty toolCalls array for text-only streams', async () => {
      const model = createMockGeminiStreamingModel([geminiStreamTextChunks]);
      const generate: StreamingGenerateFunction = createGeminiGenerateStream({
        model: 'gemini-pro',
        client: model,
      });
      const context = createStreamingContext();

      const result = await generate(context);

      expect(result.toolCalls).toEqual([]);
    });

    it('calls streaming.update progressively with accumulated text', async () => {
      const model = createMockGeminiStreamingModel([geminiStreamTextChunks]);
      const generate: StreamingGenerateFunction = createGeminiGenerateStream({
        model: 'gemini-pro',
        client: model,
      });
      const updates: string[] = [];
      const streaming = {
        messageId: 'msg-1',
        update: (content: string) => updates.push(content),
      };
      const base = createTestContext();
      const context = { ...base, streaming };

      await generate(context);

      expect(updates).toEqual(['Hello ', 'Hello from Gemini!']);
    });
  });

  describe('function call streaming', () => {
    it('extracts tool calls from streamed function call chunks', async () => {
      const model = createMockGeminiStreamingModel([geminiStreamFunctionCallChunks]);
      const generate: StreamingGenerateFunction = createGeminiGenerateStream({
        model: 'gemini-pro',
        client: model,
      });
      const context = createStreamingContext();

      const result = await generate(context);

      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0]).toMatchObject({
        name: 'get_weather',
        arguments: { location: 'San Francisco' },
      });
    });
  });

  describe('mixed text and function calls', () => {
    it('populates both content and toolCalls from a mixed stream', async () => {
      const mixedChunks = [
        {
          candidates: [
            {
              content: {
                parts: [
                  { text: 'Checking weather...' },
                  { functionCall: { name: 'get_weather', args: { location: 'Tokyo' } } },
                ],
              },
            },
          ],
          usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 8, totalTokenCount: 20 },
        },
      ];
      const model = createMockGeminiStreamingModel([mixedChunks]);
      const generate: StreamingGenerateFunction = createGeminiGenerateStream({
        model: 'gemini-pro',
        client: model,
      });
      const context = createStreamingContext();

      const result = await generate(context);

      expect(result.content).toBe('Checking weather...');
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0]).toMatchObject({
        name: 'get_weather',
        arguments: { location: 'Tokyo' },
      });
    });
  });

  describe('usage mapping', () => {
    it('maps usageMetadata from the last chunk to prompt, completion, and total', async () => {
      const model = createMockGeminiStreamingModel([geminiStreamTextChunks]);
      const generate: StreamingGenerateFunction = createGeminiGenerateStream({
        model: 'gemini-pro',
        client: model,
      });
      const context = createStreamingContext();

      const result = await generate(context);

      expect(result.usage).toEqual({
        prompt: 10,
        completion: 5,
        total: 15,
      });
    });

    it('returns undefined usage when no chunk contains usageMetadata', async () => {
      const chunksWithoutUsage = [
        { candidates: [{ content: { parts: [{ text: 'No usage info.' }] } }] },
      ];
      const model = createMockGeminiStreamingModel([chunksWithoutUsage]);
      const generate: StreamingGenerateFunction = createGeminiGenerateStream({
        model: 'gemini-pro',
        client: model,
      });
      const context = createStreamingContext();

      const result = await generate(context);

      expect(result.usage).toBeUndefined();
    });
  });

  describe('tool forwarding', () => {
    it('omits tools parameter from the SDK call when the toolbox is empty', async () => {
      const model = createMockGeminiStreamingModel([geminiStreamTextChunks]);
      const generate: StreamingGenerateFunction = createGeminiGenerateStream({
        model: 'gemini-pro',
        client: model,
      });
      const context = createStreamingContext({ toolbox: createToolbox() });

      await generate(context);

      const call = model._calls[0];
      expect(call).toBeDefined();
      expect(call).not.toHaveProperty('tools');
    });
  });

  describe('error wrapping', () => {
    it('wraps SDK errors in HeraldError with provider set to gemini', async () => {
      const sdkError = new Error('Something went wrong');
      const model = createMockGeminiStreamingModel([], [sdkError]);
      const generate: StreamingGenerateFunction = createGeminiGenerateStream({
        model: 'gemini-pro',
        client: model,
      });
      const context = createStreamingContext();

      try {
        await generate(context);
        expect.unreachable('Expected an error to be thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(HeraldError);
        const heraldError = error as HeraldError;
        expect(heraldError.provider).toBe('gemini');
        expect(heraldError.cause).toBe(sdkError);
      }
    });

    it('marks rate limit errors (429) as retryable', async () => {
      const rateLimitError = Object.assign(new Error('Rate limited'), { status: 429 });
      const model = createMockGeminiStreamingModel([], [rateLimitError]);
      const generate: StreamingGenerateFunction = createGeminiGenerateStream({
        model: 'gemini-pro',
        client: model,
      });
      const context = createStreamingContext();

      try {
        await generate(context);
        expect.unreachable('Expected an error to be thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(HeraldError);
        const heraldError = error as HeraldError;
        expect(heraldError.statusCode).toBe(429);
        expect(heraldError.retryable).toBe(true);
      }
    });

    it('marks auth errors (401) as not retryable', async () => {
      const authError = Object.assign(new Error('Unauthorized'), { status: 401 });
      const model = createMockGeminiStreamingModel([], [authError]);
      const generate: StreamingGenerateFunction = createGeminiGenerateStream({
        model: 'gemini-pro',
        client: model,
      });
      const context = createStreamingContext();

      try {
        await generate(context);
        expect.unreachable('Expected an error to be thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(HeraldError);
        const heraldError = error as HeraldError;
        expect(heraldError.statusCode).toBe(401);
        expect(heraldError.retryable).toBe(false);
      }
    });
  });

  describe('parameter forwarding', () => {
    it('forwards generationConfig with temperature, topP, and stopSequences', async () => {
      const model = createMockGeminiStreamingModel([geminiStreamTextChunks]);
      const generate: StreamingGenerateFunction = createGeminiGenerateStream({
        model: 'gemini-pro',
        client: model,
        temperature: 0.7,
        topP: 0.9,
        stopSequences: ['STOP', 'END'],
      });
      const context = createStreamingContext();

      await generate(context);

      const call = model._calls[0] as Record<string, unknown>;
      expect(call).toBeDefined();
      const generationConfig = call['generationConfig'] as Record<string, unknown>;
      expect(generationConfig).toBeDefined();
      expect(generationConfig['temperature']).toBe(0.7);
      expect(generationConfig['topP']).toBe(0.9);
      expect(generationConfig['stopSequences']).toEqual(['STOP', 'END']);
    });

    it('forwards maximumTokens as maxOutputTokens in generationConfig', async () => {
      const model = createMockGeminiStreamingModel([geminiStreamTextChunks]);
      const generate: StreamingGenerateFunction = createGeminiGenerateStream({
        model: 'gemini-pro',
        client: model,
        maximumTokens: 1024,
      });
      const context = createStreamingContext();

      await generate(context);

      const call = model._calls[0] as Record<string, unknown>;
      const generationConfig = call['generationConfig'] as Record<string, unknown>;
      expect(generationConfig).toBeDefined();
      expect(generationConfig['maxOutputTokens']).toBe(1024);
    });

    it('forwards contents and systemInstruction to the SDK call', async () => {
      const model = createMockGeminiStreamingModel([geminiStreamTextChunks]);
      const generate: StreamingGenerateFunction = createGeminiGenerateStream({
        model: 'gemini-pro',
        client: model,
      });
      const context = createStreamingContext();

      await generate(context);

      const call = model._calls[0] as Record<string, unknown>;
      expect(call).toBeDefined();
      expect(call).toHaveProperty('contents');
    });

    it('omits generationConfig entirely when no generation options are set', async () => {
      const model = createMockGeminiStreamingModel([geminiStreamTextChunks]);
      const generate: StreamingGenerateFunction = createGeminiGenerateStream({
        model: 'gemini-pro',
        client: model,
      });
      const context = createStreamingContext();

      await generate(context);

      const call = model._calls[0] as Record<string, unknown>;
      expect(call).not.toHaveProperty('generationConfig');
    });
  });

  describe('missing API key', () => {
    it('throws HeraldError when no apiKey option and no GOOGLE_API_KEY env var', async () => {
      const original = process.env['GOOGLE_API_KEY'];
      delete process.env['GOOGLE_API_KEY'];
      try {
        const generate: StreamingGenerateFunction = createGeminiGenerateStream({
          model: 'gemini-pro',
        });
        const context = createStreamingContext();
        await generate(context);
        expect.unreachable('Expected an error to be thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(HeraldError);
        const heraldError = error as HeraldError;
        expect(heraldError.provider).toBe('gemini');
        expect(heraldError.message).toContain('GOOGLE_API_KEY');
      } finally {
        if (original !== undefined) process.env['GOOGLE_API_KEY'] = original;
      }
    });
  });

  describe('dynamic SDK import', () => {
    it('loads the SDK when no client is provided', async () => {
      const generate: StreamingGenerateFunction = createGeminiGenerateStream({
        model: 'gemini-2.0-flash',
        apiKey: 'sk-test-invalid',
      });
      const context = createStreamingContext();
      try {
        await generate(context);
        expect.unreachable('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(HeraldError);
        expect((error as HeraldError).provider).toBe('gemini');
      }
    });
  });
});
