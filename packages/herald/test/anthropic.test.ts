import { createTool, createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { appendMessages, Conversation, createConversationHistory } from 'conversationalist';
import { z } from 'zod';

import { createAnthropicGenerate } from '../src/anthropic.ts';
import { HeraldError } from '../src/errors.ts';
import {
  anthropicMixedResponse,
  anthropicNoUsageResponse,
  anthropicTextResponse,
  anthropicToolUseResponse,
} from '../src/test/fixtures.ts';
import { createMockAnthropicClient } from '../src/test/mock-clients.ts';
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

describe('createAnthropicGenerate', () => {
  describe('text-only response', () => {
    it('returns content from text blocks and empty toolCalls', async () => {
      const client = createMockAnthropicClient([anthropicTextResponse]);
      const generate = createAnthropicGenerate({ model: 'claude-sonnet-4-20250514', client });
      const context = createTestContext();

      const result = await generate(context);

      expect(result.content).toBe('Hello from Anthropic!');
      expect(result.toolCalls).toEqual([]);
    });
  });

  describe('tool use response', () => {
    it('returns toolCalls with name, id, and arguments', async () => {
      const client = createMockAnthropicClient([anthropicToolUseResponse]);
      const generate = createAnthropicGenerate({ model: 'claude-sonnet-4-20250514', client });
      const context = createTestContext();

      const result = await generate(context);

      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0]).toEqual(
        expect.objectContaining({
          name: 'get_weather',
          id: 'toolu_01',
          arguments: { location: 'San Francisco' },
        }),
      );
    });
  });

  describe('mixed text and tool use response', () => {
    it('populates both content and toolCalls', async () => {
      const client = createMockAnthropicClient([anthropicMixedResponse]);
      const generate = createAnthropicGenerate({ model: 'claude-sonnet-4-20250514', client });
      const context = createTestContext();

      const result = await generate(context);

      expect(result.content).toBe('Let me check the weather.');
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0]).toEqual(
        expect.objectContaining({
          name: 'get_weather',
          id: 'toolu_02',
          arguments: { location: 'New York' },
        }),
      );
    });
  });

  describe('usage mapping', () => {
    it('maps input_tokens and output_tokens to prompt, completion, and total', async () => {
      const client = createMockAnthropicClient([anthropicTextResponse]);
      const generate = createAnthropicGenerate({ model: 'claude-sonnet-4-20250514', client });
      const context = createTestContext();

      const result = await generate(context);

      expect(result.usage).toEqual({
        prompt: 10,
        completion: 5,
        total: 15,
      });
    });
  });

  describe('missing usage', () => {
    it('returns undefined usage when the response has no usage field', async () => {
      const client = createMockAnthropicClient([anthropicNoUsageResponse]);
      const generate = createAnthropicGenerate({ model: 'claude-sonnet-4-20250514', client });
      const context = createTestContext();

      const result = await generate(context);

      expect(result.usage).toBeUndefined();
    });
  });

  describe('empty tool list', () => {
    it('omits tools parameter from the SDK call when toolbox is empty', async () => {
      const client = createMockAnthropicClient([anthropicTextResponse]);
      const generate = createAnthropicGenerate({ model: 'claude-sonnet-4-20250514', client });
      const emptyToolbox = createToolbox();
      const context = createTestContext({ toolbox: emptyToolbox });

      await generate(context);

      const call = client._calls[0];
      expect(call).toBeDefined();
      expect(call).not.toHaveProperty('tools');
    });
  });

  describe('AbortSignal forwarding', () => {
    it('passes the signal through to the SDK call', async () => {
      const client = createMockAnthropicClient([anthropicTextResponse]);
      const generate = createAnthropicGenerate({ model: 'claude-sonnet-4-20250514', client });
      const controller = new AbortController();
      const context = createTestContext({ signal: controller.signal });

      await generate(context);

      const call = client._calls[0];
      expect(call).toBeDefined();
      expect(call['signal']).toBe(controller.signal);
    });
  });

  describe('error handling', () => {
    it('wraps SDK errors in HeraldError with provider set to anthropic', async () => {
      const sdkError = new Error('Something went wrong');
      const client = createMockAnthropicClient([], [sdkError]);
      const generate = createAnthropicGenerate({ model: 'claude-sonnet-4-20250514', client });
      const context = createTestContext();

      try {
        await generate(context);
        expect.unreachable('Expected generate to throw');
      } catch (error) {
        expect(error).toBeInstanceOf(HeraldError);
        const heraldError = error as HeraldError;
        expect(heraldError.provider).toBe('anthropic');
        expect(heraldError.cause).toBe(sdkError);
      }
    });

    it('marks rate limit errors (429) as retryable', async () => {
      const rateLimitError = Object.assign(new Error('Rate limited'), { status: 429 });
      const client = createMockAnthropicClient([], [rateLimitError]);
      const generate = createAnthropicGenerate({ model: 'claude-sonnet-4-20250514', client });
      const context = createTestContext();

      try {
        await generate(context);
        expect.unreachable('Expected generate to throw');
      } catch (error) {
        expect(error).toBeInstanceOf(HeraldError);
        const heraldError = error as HeraldError;
        expect(heraldError.statusCode).toBe(429);
        expect(heraldError.retryable).toBe(true);
      }
    });

    it('marks auth errors (401) as not retryable', async () => {
      const authError = Object.assign(new Error('Unauthorized'), { status: 401 });
      const client = createMockAnthropicClient([], [authError]);
      const generate = createAnthropicGenerate({ model: 'claude-sonnet-4-20250514', client });
      const context = createTestContext();

      try {
        await generate(context);
        expect.unreachable('Expected generate to throw');
      } catch (error) {
        expect(error).toBeInstanceOf(HeraldError);
        const heraldError = error as HeraldError;
        expect(heraldError.statusCode).toBe(401);
        expect(heraldError.retryable).toBe(false);
      }
    });
  });

  describe('dynamic SDK import', () => {
    it('loads the SDK when no client is provided', async () => {
      const generate = createAnthropicGenerate({
        model: 'claude-sonnet-4-20250514',
        apiKey: 'sk-test-invalid',
      });
      const context = createTestContext();
      try {
        await generate(context);
        expect.unreachable('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(HeraldError);
        expect((error as HeraldError).provider).toBe('anthropic');
      }
    });
  });

  describe('parameter forwarding', () => {
    it('forwards model and maximumTokens to the SDK call', async () => {
      const client = createMockAnthropicClient([anthropicTextResponse]);
      const generate = createAnthropicGenerate({
        model: 'claude-sonnet-4-20250514',
        maximumTokens: 2048,
        client,
      });
      const context = createTestContext();

      await generate(context);

      const call = client._calls[0];
      expect(call).toBeDefined();
      expect(call['model']).toBe('claude-sonnet-4-20250514');
      expect(call['max_tokens']).toBe(2048);
    });

    it('uses default maximumTokens of 4096 when not specified', async () => {
      const client = createMockAnthropicClient([anthropicTextResponse]);
      const generate = createAnthropicGenerate({ model: 'claude-sonnet-4-20250514', client });
      const context = createTestContext();

      await generate(context);

      const call = client._calls[0];
      expect(call).toBeDefined();
      expect(call['max_tokens']).toBe(4096);
    });

    it('forwards temperature, topP, and stopSequences when set', async () => {
      const client = createMockAnthropicClient([anthropicTextResponse]);
      const generate = createAnthropicGenerate({
        model: 'claude-sonnet-4-20250514',
        temperature: 0.7,
        topP: 0.9,
        stopSequences: ['STOP', 'END'],
        client,
      });
      const context = createTestContext();

      await generate(context);

      const call = client._calls[0];
      expect(call).toBeDefined();
      expect(call['temperature']).toBe(0.7);
      expect(call['top_p']).toBe(0.9);
      expect(call['stop_sequences']).toEqual(['STOP', 'END']);
    });

    it('omits temperature, topP, and stopSequences when not set', async () => {
      const client = createMockAnthropicClient([anthropicTextResponse]);
      const generate = createAnthropicGenerate({ model: 'claude-sonnet-4-20250514', client });
      const context = createTestContext();

      await generate(context);

      const call = client._calls[0];
      expect(call).toBeDefined();
      expect(call).not.toHaveProperty('temperature');
      expect(call).not.toHaveProperty('top_p');
      expect(call).not.toHaveProperty('stop_sequences');
    });
  });
});
