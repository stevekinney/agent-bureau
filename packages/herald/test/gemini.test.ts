import { createTool, createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { appendMessages, Conversation, createConversationHistory } from 'conversationalist';
import { z } from 'zod';

import { HeraldError } from '../src/errors.ts';
import { createGeminiGenerate } from '../src/gemini.ts';
import {
  geminiFunctionCallResponse,
  geminiMixedResponse,
  geminiNoUsageResponse,
  geminiTextResponse,
} from '../src/test/fixtures.ts';
import { createMockGeminiModel } from '../src/test/mock-clients.ts';
import type { GenerateContext } from '../src/types.ts';

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
