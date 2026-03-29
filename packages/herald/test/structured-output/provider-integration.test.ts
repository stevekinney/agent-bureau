import { createTool, createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { appendMessages, Conversation, createConversationHistory } from 'conversationalist';
import { z } from 'zod';

import { createAnthropicGenerate } from '../../src/anthropic.ts';
import { createGeminiGenerate } from '../../src/gemini.ts';
import { createOpenAIGenerate } from '../../src/openai.ts';
import { anthropicTextResponse } from '../../src/test/fixtures.ts';
import {
  createMockAnthropicClient,
  createMockGeminiModel,
  createMockOpenAIClient,
} from '../../src/test/mock-clients.ts';
import type {
  GeminiGenerateContentResult,
  GenerateContext,
  OpenAIChatCompletion,
} from '../../src/types.ts';

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

const simpleOpenAIResponse: OpenAIChatCompletion = {
  choices: [{ message: { content: 'Hello!' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
};

const simpleGeminiResponse: GeminiGenerateContentResult = {
  response: {
    candidates: [{ content: { parts: [{ text: 'Hello!' }] } }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
  },
};

describe('Anthropic provider integration', () => {
  it('passes tool_choice to the SDK when toolChoice is set to auto', async () => {
    const client = createMockAnthropicClient([anthropicTextResponse]);
    const generate = createAnthropicGenerate({
      model: 'claude-sonnet-4-20250514',
      client,
      toolChoice: 'auto',
    });
    const context = createTestContext();

    await generate(context);

    const call = client._calls[0]!;
    expect(call['tool_choice']).toEqual({ type: 'auto' });
  });

  it('passes tool_choice with required mapped to any', async () => {
    const client = createMockAnthropicClient([anthropicTextResponse]);
    const generate = createAnthropicGenerate({
      model: 'claude-sonnet-4-20250514',
      client,
      toolChoice: 'required',
    });
    const context = createTestContext();

    await generate(context);

    const call = client._calls[0]!;
    expect(call['tool_choice']).toEqual({ type: 'any' });
  });

  it('omits tools entirely when toolChoice is none', async () => {
    const client = createMockAnthropicClient([anthropicTextResponse]);
    const generate = createAnthropicGenerate({
      model: 'claude-sonnet-4-20250514',
      client,
      toolChoice: 'none',
    });
    const context = createTestContext();

    await generate(context);

    const call = client._calls[0]!;
    expect(call).not.toHaveProperty('tools');
    expect(call).not.toHaveProperty('tool_choice');
  });

  it('passes a specific tool choice', async () => {
    const client = createMockAnthropicClient([anthropicTextResponse]);
    const generate = createAnthropicGenerate({
      model: 'claude-sonnet-4-20250514',
      client,
      toolChoice: { tool: 'get_weather' },
    });
    const context = createTestContext();

    await generate(context);

    const call = client._calls[0]!;
    expect(call['tool_choice']).toEqual({ type: 'tool', name: 'get_weather' });
  });

  it('does not set tool_choice when toolChoice option is not provided', async () => {
    const client = createMockAnthropicClient([anthropicTextResponse]);
    const generate = createAnthropicGenerate({
      model: 'claude-sonnet-4-20250514',
      client,
    });
    const context = createTestContext();

    await generate(context);

    const call = client._calls[0]!;
    expect(call).not.toHaveProperty('tool_choice');
  });
});

describe('OpenAI provider integration', () => {
  it('passes tool_choice to the SDK when toolChoice is set', async () => {
    const client = createMockOpenAIClient([simpleOpenAIResponse]);
    const generate = createOpenAIGenerate({
      model: 'gpt-4o',
      client,
      toolChoice: 'required',
    });
    const context = createTestContext();

    await generate(context);

    const call = client._calls[0]!;
    expect(call['tool_choice']).toBe('required');
  });

  it('passes response_format for json_schema', async () => {
    const client = createMockOpenAIClient([simpleOpenAIResponse]);
    const schema = { type: 'object', properties: { name: { type: 'string' } } };
    const generate = createOpenAIGenerate({
      model: 'gpt-4o',
      client,
      responseFormat: { type: 'json_schema', schema, name: 'user' },
    });
    const context = createTestContext();

    await generate(context);

    const call = client._calls[0]!;
    expect(call['response_format']).toEqual({
      type: 'json_schema',
      json_schema: { name: 'user', schema, strict: true },
    });
  });

  it('passes response_format for json', async () => {
    const client = createMockOpenAIClient([simpleOpenAIResponse]);
    const generate = createOpenAIGenerate({
      model: 'gpt-4o',
      client,
      responseFormat: { type: 'json' },
    });
    const context = createTestContext();

    await generate(context);

    const call = client._calls[0]!;
    expect(call['response_format']).toEqual({ type: 'json_object' });
  });

  it('omits response_format for text', async () => {
    const client = createMockOpenAIClient([simpleOpenAIResponse]);
    const generate = createOpenAIGenerate({
      model: 'gpt-4o',
      client,
      responseFormat: { type: 'text' },
    });
    const context = createTestContext();

    await generate(context);

    const call = client._calls[0]!;
    expect(call).not.toHaveProperty('response_format');
  });

  it('passes specific tool choice in function format', async () => {
    const client = createMockOpenAIClient([simpleOpenAIResponse]);
    const generate = createOpenAIGenerate({
      model: 'gpt-4o',
      client,
      toolChoice: { tool: 'get_weather' },
    });
    const context = createTestContext();

    await generate(context);

    const call = client._calls[0]!;
    expect(call['tool_choice']).toEqual({
      type: 'function',
      function: { name: 'get_weather' },
    });
  });

  it('does not set tool_choice or response_format when not provided', async () => {
    const client = createMockOpenAIClient([simpleOpenAIResponse]);
    const generate = createOpenAIGenerate({
      model: 'gpt-4o',
      client,
    });
    const context = createTestContext();

    await generate(context);

    const call = client._calls[0]!;
    expect(call).not.toHaveProperty('tool_choice');
    expect(call).not.toHaveProperty('response_format');
  });
});

describe('Gemini provider integration', () => {
  it('passes tool_config when toolChoice is set', async () => {
    const client = createMockGeminiModel([simpleGeminiResponse]);
    const generate = createGeminiGenerate({
      model: 'gemini-pro',
      client,
      toolChoice: 'required',
    });
    const context = createTestContext();

    await generate(context);

    const call = client._calls[0]!;
    expect(call['tool_config']).toEqual({
      function_calling_config: { mode: 'ANY' },
    });
  });

  it('passes response format fields in generationConfig', async () => {
    const client = createMockGeminiModel([simpleGeminiResponse]);
    const schema = { type: 'object', properties: { name: { type: 'string' } } };
    const generate = createGeminiGenerate({
      model: 'gemini-pro',
      client,
      responseFormat: { type: 'json_schema', schema },
    });
    const context = createTestContext();

    await generate(context);

    const call = client._calls[0]!;
    const generationConfig = call['generationConfig'] as Record<string, unknown>;
    expect(generationConfig).toBeDefined();
    expect(generationConfig['response_mime_type']).toBe('application/json');
    expect(generationConfig['response_schema']).toEqual(schema);
  });

  it('passes json mime type for plain json format', async () => {
    const client = createMockGeminiModel([simpleGeminiResponse]);
    const generate = createGeminiGenerate({
      model: 'gemini-pro',
      client,
      responseFormat: { type: 'json' },
    });
    const context = createTestContext();

    await generate(context);

    const call = client._calls[0]!;
    const generationConfig = call['generationConfig'] as Record<string, unknown>;
    expect(generationConfig).toBeDefined();
    expect(generationConfig['response_mime_type']).toBe('application/json');
    expect(generationConfig).not.toHaveProperty('response_schema');
  });

  it('passes specific tool choice with allowed_function_names', async () => {
    const client = createMockGeminiModel([simpleGeminiResponse]);
    const generate = createGeminiGenerate({
      model: 'gemini-pro',
      client,
      toolChoice: { tool: 'get_weather' },
    });
    const context = createTestContext();

    await generate(context);

    const call = client._calls[0]!;
    expect(call['tool_config']).toEqual({
      function_calling_config: { mode: 'ANY', allowed_function_names: ['get_weather'] },
    });
  });

  it('does not set tool_config or response format when not provided', async () => {
    const client = createMockGeminiModel([simpleGeminiResponse]);
    const generate = createGeminiGenerate({
      model: 'gemini-pro',
      client,
    });
    const context = createTestContext();

    await generate(context);

    const call = client._calls[0]!;
    expect(call).not.toHaveProperty('tool_config');
    expect(call).not.toHaveProperty('generationConfig');
  });
});
