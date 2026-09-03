/**
 * Backend-descriptor attachment on the provider factories (AB-64 AC2,
 * AB-245). Each `create*Provider`/`create*ProviderStream` attaches the
 * single `BackendDescriptor` matching its resolved, post-alias model at
 * construction time. No network call and no credential — the local mocked
 * clients `packages/operative/test/provider-*.test.ts` already use.
 */
import { createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';

import {
  createAnthropicProvider,
  createAnthropicProviderStream,
} from '../src/providers/anthropic.ts';
import { readBackendDescriptors } from '../src/providers/backend-descriptor-attachment.ts';
import { createGeminiProvider, createGeminiProviderStream } from '../src/providers/gemini.ts';
import type { BackendDescriptor } from '../src/providers/model-catalog.ts';
import { createModelCatalog } from '../src/providers/model-catalog.ts';
import { createOpenAIProvider, createOpenAIProviderStream } from '../src/providers/openai.ts';
import {
  anthropicStreamTextEvents,
  anthropicTextResponse,
  geminiStreamTextChunks,
  geminiTextResponse,
  openAIStreamTextChunks,
  openAITextResponse,
} from '../src/providers/test/fixtures.ts';
import {
  createMockAnthropicClient,
  createMockAnthropicStreamingClient,
  createMockGeminiModel,
  createMockGeminiStreamingModel,
  createMockOpenAIClient,
  createMockOpenAIStreamingClient,
} from '../src/providers/test/mock-clients.ts';
import type { GenerateContext } from '../src/types.ts';

function makeContext(): GenerateContext {
  return { conversation: new Conversation(), step: 0, toolbox: createToolbox([]) };
}

// The provider factories under test read the wall clock through
// `createModelCatalog`'s default `now`, same as this helper — so every
// comparison below strips `freshness` rather than pinning it, and asserts
// separately that it is a well-formed ISO timestamp.
function seedDescriptor(provider: 'anthropic' | 'openai' | 'gemini', model: string) {
  return createModelCatalog().descriptors.find(
    (descriptor) => descriptor.provider === provider && descriptor.model === model,
  );
}

function withoutFreshness(descriptor: BackendDescriptor): Omit<BackendDescriptor, 'freshness'> {
  const { freshness: _freshness, ...rest } = descriptor;
  return rest;
}

function expectMatchesSeed(
  attached: readonly BackendDescriptor[],
  expected: BackendDescriptor | undefined,
): void {
  if (!expected) {
    expect(attached).toEqual([]);
    return;
  }
  expect(attached).toHaveLength(1);
  const [descriptor] = attached;
  if (!descriptor) throw new Error('expected exactly one attached descriptor');
  expect(withoutFreshness(descriptor)).toEqual(withoutFreshness(expected));
  expect(descriptor.freshness).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
}

describe('createAnthropicProvider / createAnthropicProviderStream — backend descriptor', () => {
  it('attaches exactly the descriptor matching the resolved model', () => {
    const client = createMockAnthropicClient([anthropicTextResponse]);
    const generate = createAnthropicProvider({ model: 'claude-sonnet-5', client });
    const expected = seedDescriptor('anthropic', 'claude-sonnet-5');

    expectMatchesSeed(readBackendDescriptors(generate), expected);
    expect(readBackendDescriptors(generate)).not.toEqual([]);
  });

  it('attaches the same descriptor on the streaming variant', () => {
    const client = createMockAnthropicStreamingClient(anthropicStreamTextEvents);
    const generate = createAnthropicProviderStream({ model: 'claude-sonnet-5', client });
    const expected = seedDescriptor('anthropic', 'claude-sonnet-5');

    expectMatchesSeed(readBackendDescriptors(generate), expected);
  });

  it('attaches nothing for a model with no seed row', () => {
    const client = createMockAnthropicClient([anthropicTextResponse]);
    const generate = createAnthropicProvider({
      model: 'claude-does-not-exist-in-the-seed',
      client,
    });

    expect(readBackendDescriptors(generate)).toEqual([]);
  });

  it('the attached descriptor is still usable to run a request through the mock client', async () => {
    const client = createMockAnthropicClient([anthropicTextResponse]);
    const generate = createAnthropicProvider({ model: 'claude-sonnet-5', client });

    const response = await generate(makeContext());
    expect(response.content).toBe('Hello from Anthropic!');
  });
});

describe('createOpenAIProvider / createOpenAIProviderStream — backend descriptor', () => {
  it('attaches exactly the descriptor matching the resolved model', () => {
    const client = createMockOpenAIClient([openAITextResponse]);
    const generate = createOpenAIProvider({ model: 'gpt-4o', client });
    const expected = seedDescriptor('openai', 'gpt-4o');

    expectMatchesSeed(readBackendDescriptors(generate), expected);
    expect(readBackendDescriptors(generate)).not.toEqual([]);
  });

  it('attaches the same descriptor on the streaming variant', () => {
    const client = createMockOpenAIStreamingClient(openAIStreamTextChunks);
    const generate = createOpenAIProviderStream({ model: 'gpt-4o', client });
    const expected = seedDescriptor('openai', 'gpt-4o');

    expectMatchesSeed(readBackendDescriptors(generate), expected);
  });

  it('reports endpointAmbiguous rows (no descriptor content leaked from a normal endpoint) for a custom baseURL', () => {
    const client = createMockOpenAIClient([openAITextResponse]);
    const generate = createOpenAIProvider({
      model: 'gpt-4o',
      client,
      baseURL: 'https://proxy.internal.example/v1',
    });

    const descriptors = readBackendDescriptors(generate);
    expect(descriptors).toHaveLength(1);
    expect(descriptors[0]?.endpointAmbiguous).toBe(true);
    expect(descriptors[0]?.availability).toBe('unknown');
  });

  it('attaches nothing for a model with no seed row', () => {
    const client = createMockOpenAIClient([openAITextResponse]);
    const generate = createOpenAIProvider({ model: 'gpt-does-not-exist-in-the-seed', client });

    expect(readBackendDescriptors(generate)).toEqual([]);
  });
});

describe('createGeminiProvider / createGeminiProviderStream — backend descriptor', () => {
  it('attaches exactly the descriptor matching the resolved model', () => {
    const client = createMockGeminiModel([geminiTextResponse]);
    const generate = createGeminiProvider({ model: 'gemini-2.5-flash', client });
    const expected = seedDescriptor('gemini', 'gemini-2.5-flash');

    expectMatchesSeed(readBackendDescriptors(generate), expected);
    expect(readBackendDescriptors(generate)).not.toEqual([]);
  });

  it('leaves the streaming variant opaque because the seed catalog has no generateContentStream-specific row', () => {
    // The seed catalog only has a `generateContent` row for Gemini, but this
    // factory calls the distinct `generateContentStream` operation.
    // Attaching the `generateContent` row would misreport the endpoint this
    // function actually invokes, so it attaches nothing instead.
    const client = createMockGeminiStreamingModel(geminiStreamTextChunks);
    const generate = createGeminiProviderStream({ model: 'gemini-2.5-flash', client });

    expect(readBackendDescriptors(generate)).toEqual([]);
  });

  it('attaches nothing for a model with no seed row', () => {
    const client = createMockGeminiModel([geminiTextResponse]);
    const generate = createGeminiProvider({ model: 'gemini-does-not-exist-in-the-seed', client });

    expect(readBackendDescriptors(generate)).toEqual([]);
  });
});
