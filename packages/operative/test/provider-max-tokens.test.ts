/**
 * Regression tests for per-request maximumTokens override in providers.
 *
 * Spec: context.maximumTokens takes precedence over the construction-time
 * maximumTokens option when building the provider request params.
 */
import { createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';

import { createAnthropicProvider } from '../src/providers/anthropic.ts';
import { createOpenAIProvider } from '../src/providers/openai.ts';
import { anthropicTextResponse, openAITextResponse } from '../src/providers/test/fixtures.ts';
import {
  createMockAnthropicClient,
  createMockOpenAIClient,
} from '../src/providers/test/mock-clients.ts';

function makeContext(maximumTokens?: number) {
  return {
    conversation: new Conversation(),
    step: 0,
    toolbox: createToolbox([]),
    maximumTokens,
  };
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
