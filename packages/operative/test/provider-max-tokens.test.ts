/**
 * Regression tests for per-request maximumTokens override in providers.
 *
 * Spec: context.maximumTokens takes precedence over the construction-time
 * maximumTokens option when building the provider request params.
 */
import { createTool, createToolbox, type Toolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';
import { z } from 'zod';

import { createAnthropicProvider } from '../src/providers/anthropic.ts';
import { createGeminiProvider } from '../src/providers/gemini.ts';
import { createOpenAIProvider } from '../src/providers/openai.ts';
import {
  anthropicTextResponse,
  geminiTextResponse,
  openAITextResponse,
} from '../src/providers/test/fixtures.ts';
import {
  createMockAnthropicClient,
  createMockGeminiModel,
  createMockOpenAIClient,
} from '../src/providers/test/mock-clients.ts';

function makeContext(maximumTokens?: number, toolbox: Toolbox = createToolbox([])) {
  return {
    conversation: new Conversation(),
    step: 0,
    toolbox,
    maximumTokens,
  };
}

function makeAvailabilityToolbox() {
  return createToolbox([
    createTool({
      name: 'available-tool',
      description: 'Available tool',
      input: z.object({}),
      availability: () => true,
      async execute() {
        return 'ok';
      },
    }),
    createTool({
      name: 'unavailable-tool',
      description: 'Unavailable tool',
      input: z.object({}),
      availability: () => false,
      async execute() {
        return 'hidden';
      },
    }),
  ]);
}

describe('Anthropic provider — per-request maximumTokens override', () => {
  it('uses the construction-time maximumTokens when context does not specify one', async () => {
    const client = createMockAnthropicClient([anthropicTextResponse]);
    const generate = createAnthropicProvider({
      model: 'claude-3-5-sonnet-20241022',
      maximumTokens: 1024,
      client,
    });

    await generate(makeContext());

    const call = client._calls[0];
    expect(call).toBeDefined();
    expect(call?.['max_tokens']).toBe(1024);
  });

  it('overrides construction-time maximumTokens when context.maximumTokens is set', async () => {
    const client = createMockAnthropicClient([anthropicTextResponse]);
    const generate = createAnthropicProvider({
      model: 'claude-3-5-sonnet-20241022',
      maximumTokens: 1024,
      client,
    });

    await generate(makeContext(512));

    const call = client._calls[0];
    expect(call).toBeDefined();
    expect(call?.['max_tokens']).toBe(512);
  });
});

describe('OpenAI provider — per-request maximumTokens override', () => {
  it('uses the construction-time maximumTokens when context does not specify one', async () => {
    const client = createMockOpenAIClient([openAITextResponse]);
    const generate = createOpenAIProvider({
      model: 'gpt-4o',
      maximumTokens: 2048,
      client,
    });

    await generate(makeContext());

    const call = client._calls[0];
    expect(call).toBeDefined();
    expect(call?.['max_tokens']).toBe(2048);
  });

  it('overrides construction-time maximumTokens when context.maximumTokens is set', async () => {
    const client = createMockOpenAIClient([openAITextResponse]);
    const generate = createOpenAIProvider({
      model: 'gpt-4o',
      maximumTokens: 2048,
      client,
    });

    await generate(makeContext(256));

    const call = client._calls[0];
    expect(call).toBeDefined();
    expect(call?.['max_tokens']).toBe(256);
  });

  it('omits max_tokens entirely when neither construction-time nor context value is set', async () => {
    const client = createMockOpenAIClient([openAITextResponse]);
    const generate = createOpenAIProvider({
      model: 'gpt-4o',
      client,
    });

    await generate(makeContext());

    const call = client._calls[0];
    expect(call).toBeDefined();
    expect(call?.['max_tokens']).toBeUndefined();
  });
});

describe('providers — toolbox availability gating', () => {
  it('omits unavailable tools from OpenAI request payloads', async () => {
    const client = createMockOpenAIClient([openAITextResponse]);
    const generate = createOpenAIProvider({
      model: 'gpt-4o',
      client,
    });

    await generate(makeContext(undefined, makeAvailabilityToolbox()));

    const call = client._calls[0];
    const tools = call?.['tools'] as Array<{ function: { name: string } }> | undefined;
    expect(tools?.map((tool) => tool.function.name)).toEqual(['available-tool']);
  });

  it('omits unavailable tools from Anthropic request payloads', async () => {
    const client = createMockAnthropicClient([anthropicTextResponse]);
    const generate = createAnthropicProvider({
      model: 'claude-3-5-sonnet-20241022',
      client,
    });

    await generate(makeContext(undefined, makeAvailabilityToolbox()));

    const call = client._calls[0];
    const tools = call?.['tools'] as Array<{ name: string }> | undefined;
    expect(tools?.map((tool) => tool.name)).toEqual(['available-tool']);
  });

  it('omits unavailable tools from Gemini request payloads', async () => {
    const client = createMockGeminiModel([geminiTextResponse]);
    const generate = createGeminiProvider({
      model: 'gemini-pro',
      client,
    });

    await generate(makeContext(undefined, makeAvailabilityToolbox()));

    const call = client._calls[0];
    const tools = call?.['tools'] as
      | Array<{ functionDeclarations: Array<{ name: string }> }>
      | undefined;
    expect(tools?.flatMap((tool) => tool.functionDeclarations.map((entry) => entry.name))).toEqual([
      'available-tool',
    ]);
  });
});
