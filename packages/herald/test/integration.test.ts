import { createTool, createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';
import type { RunResult } from 'operative';
import { createActiveRun, stopWhen } from 'operative';
import { z } from 'zod';

import { createAnthropicGenerate } from '../src/anthropic';
import { HeraldError } from '../src/errors';
import { createGeminiGenerate } from '../src/gemini';
import { createOpenAIGenerate } from '../src/openai';
import {
  anthropicTextResponse,
  anthropicToolUseResponse,
  geminiFunctionCallResponse,
  geminiTextResponse,
  openAITextResponse,
  openAIToolCallResponse,
} from '../src/test/fixtures';
import {
  createMockAnthropicClient,
  createMockGeminiModel,
  createMockOpenAIClient,
} from '../src/test/mock-clients';

const run = (options: Parameters<typeof createActiveRun>[0]) => createActiveRun(options).result;

const weatherTool = createTool({
  name: 'get_weather',
  description: 'Get weather for a location',
  input: z.object({ location: z.string() }),
  execute: async ({ location }) => ({ temperature: 72, location }),
});

function createWeatherToolbox() {
  return createToolbox([weatherTool]);
}

describe('herald integration with operative run()', () => {
  describe('Anthropic', () => {
    it('completes a two-step tool-use loop', async () => {
      const client = createMockAnthropicClient([anthropicToolUseResponse, anthropicTextResponse]);

      const generate = createAnthropicGenerate({
        model: 'claude-sonnet-4-20250514',
        client,
      });

      const conversation = new Conversation();
      conversation.appendUserMessage('What is the weather in San Francisco?');

      const result: RunResult = await run({
        generate,
        toolbox: createWeatherToolbox(),
        conversation,
        stopWhen: stopWhen.noToolCalls(),
      });

      expect(result.steps).toHaveLength(2);
      expect(result.content).toBe('Hello from Anthropic!');
      expect(client._calls).toHaveLength(2);
    });
  });

  describe('OpenAI', () => {
    it('completes a two-step tool-use loop', async () => {
      const client = createMockOpenAIClient([openAIToolCallResponse, openAITextResponse]);

      const generate = createOpenAIGenerate({
        model: 'gpt-4o',
        client,
      });

      const conversation = new Conversation();
      conversation.appendUserMessage('What is the weather in San Francisco?');

      const result: RunResult = await run({
        generate,
        toolbox: createWeatherToolbox(),
        conversation,
        stopWhen: stopWhen.noToolCalls(),
      });

      expect(result.steps).toHaveLength(2);
      expect(result.content).toBe('Hello from OpenAI!');
      expect(client._calls).toHaveLength(2);
    });
  });

  describe('Gemini', () => {
    it('completes a two-step tool-use loop', async () => {
      const client = createMockGeminiModel([geminiFunctionCallResponse, geminiTextResponse]);

      const generate = createGeminiGenerate({
        model: 'gemini-2.0-flash',
        client,
      });

      const conversation = new Conversation();
      conversation.appendUserMessage('What is the weather in San Francisco?');

      const result: RunResult = await run({
        generate,
        toolbox: createWeatherToolbox(),
        conversation,
        stopWhen: stopWhen.noToolCalls(),
      });

      expect(result.steps).toHaveLength(2);
      expect(result.content).toBe('Hello from Gemini!');
      expect(client._calls).toHaveLength(2);
    });
  });

  describe('error handling', () => {
    it('returns finishReason error when the SDK call throws', async () => {
      const sdkError = new Error('Connection refused');
      const client = createMockAnthropicClient([], [sdkError]);

      const generate = createAnthropicGenerate({
        model: 'claude-sonnet-4-20250514',
        client,
      });

      const conversation = new Conversation();
      conversation.appendUserMessage('Hello');

      const result: RunResult = await run({
        generate,
        toolbox: createWeatherToolbox(),
        conversation,
        stopWhen: stopWhen.noToolCalls(),
      });

      expect(result.finishReason).toBe('error');
      expect(result.error).toBeInstanceOf(HeraldError);
    });
  });

  describe('usage accumulation', () => {
    it('sums usage across both steps', async () => {
      const client = createMockAnthropicClient([anthropicToolUseResponse, anthropicTextResponse]);

      const generate = createAnthropicGenerate({
        model: 'claude-sonnet-4-20250514',
        client,
      });

      const conversation = new Conversation();
      conversation.appendUserMessage('What is the weather in San Francisco?');

      const result: RunResult = await run({
        generate,
        toolbox: createWeatherToolbox(),
        conversation,
        stopWhen: stopWhen.noToolCalls(),
      });

      // anthropicToolUseResponse: input_tokens: 15, output_tokens: 20
      // anthropicTextResponse: input_tokens: 10, output_tokens: 5
      expect(result.usage.prompt).toBe(25);
      expect(result.usage.completion).toBe(25);
      expect(result.usage.total).toBe(50);
    });
  });
});
