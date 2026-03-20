import { createTool, createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { appendMessages, Conversation, createConversationHistory } from 'conversationalist';
import { z } from 'zod';

import { HeraldError } from '../src/errors.ts';
import { createOpenAIGenerate } from '../src/openai.ts';
import {
  openAIMixedResponse,
  openAINoUsageResponse,
  openAITextResponse,
  openAIToolCallResponse,
} from '../src/test/fixtures.ts';
import { createMockOpenAIClient, type MockOpenAIClient } from '../src/test/mock-clients.ts';
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

describe('createOpenAIGenerate', () => {
  function setup(client: MockOpenAIClient, options: Record<string, unknown> = {}) {
    const generate = createOpenAIGenerate({
      model: 'gpt-4o',
      client,
      ...options,
    });
    return generate;
  }

  describe('text-only response', () => {
    it('returns the text content and empty tool calls', async () => {
      const client = createMockOpenAIClient([openAITextResponse]);
      const generate = setup(client);
      const context = createTestContext();

      const result = await generate(context);

      expect(result.content).toBe('Hello from OpenAI!');
      expect(result.toolCalls).toEqual([]);
    });
  });

  describe('tool call response', () => {
    it('returns parsed tool calls from choices[0].message.tool_calls', async () => {
      const client = createMockOpenAIClient([openAIToolCallResponse]);
      const generate = setup(client);
      const context = createTestContext();

      const result = await generate(context);

      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0]).toMatchObject({
        id: 'call_01',
        name: 'get_weather',
        arguments: { location: 'San Francisco' },
      });
    });

    it('returns empty content when the response has no text', async () => {
      const client = createMockOpenAIClient([openAIToolCallResponse]);
      const generate = setup(client);
      const context = createTestContext();

      const result = await generate(context);

      expect(result.content).toBe('');
    });
  });

  describe('mixed content and tool calls', () => {
    it('returns both text content and tool calls', async () => {
      const client = createMockOpenAIClient([openAIMixedResponse]);
      const generate = setup(client);
      const context = createTestContext();

      const result = await generate(context);

      expect(result.content).toBe('Let me check the weather.');
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0]).toMatchObject({
        id: 'call_02',
        name: 'get_weather',
        arguments: { location: 'New York' },
      });
    });
  });

  describe('usage mapping', () => {
    it('maps prompt_tokens, completion_tokens, and total_tokens to prompt, completion, and total', async () => {
      const client = createMockOpenAIClient([openAITextResponse]);
      const generate = setup(client);
      const context = createTestContext();

      const result = await generate(context);

      expect(result.usage).toEqual({
        prompt: 10,
        completion: 5,
        total: 15,
      });
    });

    it('returns undefined usage when the response has no usage field', async () => {
      const client = createMockOpenAIClient([openAINoUsageResponse]);
      const generate = setup(client);
      const context = createTestContext();

      const result = await generate(context);

      expect(result.usage).toBeUndefined();
    });
  });

  describe('empty tool list', () => {
    it('omits the tools parameter when the toolbox has no tools', async () => {
      const client = createMockOpenAIClient([openAITextResponse]);
      const generate = setup(client);
      const emptyToolbox = createToolbox();
      const context = createTestContext({ toolbox: emptyToolbox });

      await generate(context);

      const call = client._calls[0];
      expect(call).not.toHaveProperty('tools');
    });
  });

  describe('abort signal forwarding', () => {
    it('forwards the AbortSignal to the SDK call', async () => {
      const client = createMockOpenAIClient([openAITextResponse]);
      const generate = setup(client);
      const controller = new AbortController();
      const context = createTestContext({ signal: controller.signal });

      await generate(context);

      const call = client._calls[0];
      expect(call['signal']).toBe(controller.signal);
    });
  });

  describe('error handling', () => {
    it('wraps SDK errors in HeraldError with provider set to openai', async () => {
      const sdkError = new Error('Something went wrong');
      const client = createMockOpenAIClient([], [sdkError]);
      const generate = setup(client);
      const context = createTestContext();

      try {
        await generate(context);
        expect.unreachable('Expected generate to throw');
      } catch (error) {
        expect(error).toBeInstanceOf(HeraldError);
        const heraldError = error as HeraldError;
        expect(heraldError.provider).toBe('openai');
        expect(heraldError.cause).toBe(sdkError);
      }
    });

    it('marks rate limit errors (429) as retryable', async () => {
      const rateLimitError = Object.assign(new Error('Rate limited'), { status: 429 });
      const client = createMockOpenAIClient([], [rateLimitError]);
      const generate = setup(client);
      const context = createTestContext();

      try {
        await generate(context);
        expect.unreachable('Expected generate to throw');
      } catch (error) {
        const heraldError = error as HeraldError;
        expect(heraldError.statusCode).toBe(429);
        expect(heraldError.retryable).toBe(true);
      }
    });

    it('marks authentication errors (401) as not retryable', async () => {
      const authError = Object.assign(new Error('Unauthorized'), { status: 401 });
      const client = createMockOpenAIClient([], [authError]);
      const generate = setup(client);
      const context = createTestContext();

      try {
        await generate(context);
        expect.unreachable('Expected generate to throw');
      } catch (error) {
        const heraldError = error as HeraldError;
        expect(heraldError.statusCode).toBe(401);
        expect(heraldError.retryable).toBe(false);
      }
    });
  });

  describe('parameter forwarding', () => {
    it('forwards the model to the SDK call', async () => {
      const client = createMockOpenAIClient([openAITextResponse]);
      const generate = setup(client);
      const context = createTestContext();

      await generate(context);

      const call = client._calls[0];
      expect(call['model']).toBe('gpt-4o');
    });

    it('forwards temperature when set', async () => {
      const client = createMockOpenAIClient([openAITextResponse]);
      const generate = setup(client, { temperature: 0.7 });
      const context = createTestContext();

      await generate(context);

      const call = client._calls[0];
      expect(call['temperature']).toBe(0.7);
    });

    it('forwards topP as top_p when set', async () => {
      const client = createMockOpenAIClient([openAITextResponse]);
      const generate = setup(client, { topP: 0.9 });
      const context = createTestContext();

      await generate(context);

      const call = client._calls[0];
      expect(call['top_p']).toBe(0.9);
    });

    it('forwards stopSequences as stop when set', async () => {
      const client = createMockOpenAIClient([openAITextResponse]);
      const generate = setup(client, { stopSequences: ['END', 'STOP'] });
      const context = createTestContext();

      await generate(context);

      const call = client._calls[0];
      expect(call['stop']).toEqual(['END', 'STOP']);
    });

    it('omits temperature from the SDK call when not set', async () => {
      const client = createMockOpenAIClient([openAITextResponse]);
      const generate = setup(client);
      const context = createTestContext();

      await generate(context);

      const call = client._calls[0];
      expect(call).not.toHaveProperty('temperature');
    });

    it('omits top_p from the SDK call when not set', async () => {
      const client = createMockOpenAIClient([openAITextResponse]);
      const generate = setup(client);
      const context = createTestContext();

      await generate(context);

      const call = client._calls[0];
      expect(call).not.toHaveProperty('top_p');
    });

    it('omits stop from the SDK call when not set', async () => {
      const client = createMockOpenAIClient([openAITextResponse]);
      const generate = setup(client);
      const context = createTestContext();

      await generate(context);

      const call = client._calls[0];
      expect(call).not.toHaveProperty('stop');
    });
  });
});
