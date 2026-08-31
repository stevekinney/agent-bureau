/**
 * Gemini context caching (AB-158).
 *
 * Spec: Gemini's cache is a named, explicitly-created server resource with its
 * own TTL and lifecycle — `caches.create` returns a resource name that later
 * requests reference through `config.cachedContent`. It is NOT a per-request
 * breakpoint annotation like Anthropic's `cache_control`, and it is NOT the
 * deprecated `@google/generative-ai` `getGenerativeModelFromCachedContent`
 * shape, which the maintained SDK does not carry forward.
 *
 * The provider therefore supports three modes:
 *   - uncached: no cache options, conversation sent verbatim (unchanged);
 *   - caller-owned: `cachedContent` names a cache operative did not create;
 *   - provider-managed: `assembler` + `contextBudget` assemble a stable prefix,
 *     the conversation is split at its `cacheBoundary`, the prefix is created
 *     once as a cache resource, and every request sends only the tail.
 *
 * Usage accounting is separate from all three: Gemini's `promptTokenCount`
 * INCLUDES `cachedContentTokenCount`, so `prompt` is normalized to exclude it,
 * exactly as the OpenAI provider does — and unconditionally, because Gemini
 * reports the field for its own implicit caching too.
 */
import { createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { Conversation, type Message } from 'conversationalist';

import { createContextAssembler } from '../src/context/assembly.ts';
import { createTokenBudget } from '../src/context/token-budget.ts';
import { ProviderError } from '../src/providers/errors.ts';
import { createGeminiProvider, createGeminiProviderStream } from '../src/providers/gemini.ts';
import {
  createMockGeminiModel,
  createMockGeminiStreamingModel,
} from '../src/providers/test/mock-clients.ts';
import type {
  GeminiCachedContent,
  GeminiCreateCachedContentRequest,
  GeminiGenerateContentResult,
} from '../src/providers/types.ts';
import type { GenerateContext, StreamingHandle } from '../src/types.ts';

function makeContext(conversation: Conversation): GenerateContext {
  return { conversation, step: 0, toolbox: createToolbox([]) };
}

function makeStreamingHandle(): StreamingHandle {
  return { update: () => {} };
}

function textResponse(text = 'ok'): GeminiGenerateContentResult {
  return {
    candidates: [{ content: { parts: [{ text }] } }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
  };
}

function streamChunks(text = 'ok'): GeminiGenerateContentResult[] {
  return [
    {
      candidates: [{ content: { parts: [{ text }] } }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
    },
  ];
}

/**
 * A `caches` namespace that records what it was asked to create. Built here
 * rather than in `src/providers/test/mock-clients.ts` to match the fakes the
 * batch-client suite builds in its own file for the same reason: the shape is
 * specific to this suite's assertions.
 */
function createFakeCaches(options?: { name?: string | undefined; failure?: unknown }): {
  caches: { create(params: GeminiCreateCachedContentRequest): Promise<GeminiCachedContent> };
  calls: GeminiCreateCachedContentRequest[];
} {
  const calls: GeminiCreateCachedContentRequest[] = [];
  return {
    calls,
    caches: {
      async create(params: GeminiCreateCachedContentRequest): Promise<GeminiCachedContent> {
        calls.push(params);
        if (options && 'failure' in options) throw options.failure;
        const name = options && 'name' in options ? options.name : 'cachedContents/abc123';
        return { ...(name === undefined ? {} : { name }), model: params.model };
      },
    },
  };
}

/** A pinned message in the `Message` shape `ContextAssembler` expects. */
function pinnedMessage(content: string): Message {
  return {
    id: `pinned-${content}`,
    role: 'user',
    content,
    position: 0,
    createdAt: new Date().toISOString(),
    metadata: {},
    hidden: false,
  };
}

function assembling() {
  return {
    assembler: createContextAssembler(),
    contextBudget: createTokenBudget({ maxTokens: 100000 }),
  };
}

// ── Caller-owned cache: `cachedContent` ─────────────────────────────

describe('createGeminiProvider — caller-owned cachedContent', () => {
  it('passes cachedContent straight through to config and creates nothing', async () => {
    const conversation = new Conversation();
    conversation.appendUserMessage('Hello');

    const cache = createFakeCaches();
    const client = { ...createMockGeminiModel([textResponse()]), ...cache };
    const generate = createGeminiProvider({
      model: 'gemini-pro',
      client,
      cachedContent: 'cachedContents/provided-by-caller',
    });

    await generate(makeContext(conversation));

    const config = client._calls[0]?.config as Record<string, unknown>;
    expect(config['cachedContent']).toBe('cachedContents/provided-by-caller');
    expect(cache.calls).toHaveLength(0);
  });

  it('omits cachedContent from config when the option is unset', async () => {
    const conversation = new Conversation();
    conversation.appendUserMessage('Hello');

    const client = createMockGeminiModel([textResponse()]);
    const generate = createGeminiProvider({ model: 'gemini-pro', client });

    await generate(makeContext(conversation));

    const config = client._calls[0]?.config as Record<string, unknown> | undefined;
    expect(config?.['cachedContent']).toBeUndefined();
  });

  it('passes cachedContent through on the streaming factory too', async () => {
    const conversation = new Conversation();
    conversation.appendUserMessage('Hello');

    const client = createMockGeminiStreamingModel([streamChunks()]);
    const generate = createGeminiProviderStream({
      model: 'gemini-pro',
      client,
      cachedContent: 'cachedContents/provided-by-caller',
    });

    await generate({ ...makeContext(conversation), streaming: makeStreamingHandle() });

    const config = client._calls[0]?.config as Record<string, unknown>;
    expect(config['cachedContent']).toBe('cachedContents/provided-by-caller');
  });
});

// ── Provider-managed cache: assembler + contextBudget ───────────────

describe('createGeminiProvider — provider-managed context cache', () => {
  it('creates a cache from the stable prefix and references it on the request', async () => {
    const conversation = new Conversation();
    conversation.appendSystemMessage('You are a helpful assistant.');
    conversation.appendUserMessage('Hello');

    const cache = createFakeCaches();
    const client = { ...createMockGeminiModel([textResponse()]), ...cache };
    const generate = createGeminiProvider({ model: 'gemini-pro', client, ...assembling() });

    await generate(makeContext(conversation));

    expect(cache.calls).toHaveLength(1);
    const created = cache.calls[0];
    expect(created?.model).toBe('gemini-pro');
    const createdConfig = created?.config as Record<string, unknown>;
    expect(createdConfig['systemInstruction']).toEqual({
      role: 'user',
      parts: [{ text: 'You are a helpful assistant.' }],
    });

    const config = client._calls[0]?.config as Record<string, unknown>;
    expect(config['cachedContent']).toBe('cachedContents/abc123');
  });

  it('omits systemInstruction from the request once it lives in the cache', async () => {
    const conversation = new Conversation();
    conversation.appendSystemMessage('You are a helpful assistant.');
    conversation.appendUserMessage('Hello');

    const cache = createFakeCaches();
    const client = { ...createMockGeminiModel([textResponse()]), ...cache };
    const generate = createGeminiProvider({ model: 'gemini-pro', client, ...assembling() });

    await generate(makeContext(conversation));

    const config = client._calls[0]?.config as Record<string, unknown>;
    expect(config['systemInstruction']).toBeUndefined();
  });

  it('sends only the tail of the conversation on a cached request', async () => {
    const conversation = new Conversation();
    conversation.appendSystemMessage('You are a helpful assistant.');
    conversation.appendUserMessage('Hello');

    const cache = createFakeCaches();
    const client = { ...createMockGeminiModel([textResponse()]), ...cache };
    const generate = createGeminiProvider({ model: 'gemini-pro', client, ...assembling() });

    await generate(makeContext(conversation));

    expect(client._calls[0]?.contents).toEqual([{ role: 'user', parts: [{ text: 'Hello' }] }]);
  });

  it('creates the cache once and reuses its name across later calls', async () => {
    const conversation = new Conversation();
    conversation.appendSystemMessage('You are a helpful assistant.');
    conversation.appendUserMessage('Turn 1');

    const cache = createFakeCaches();
    const client = {
      ...createMockGeminiModel([textResponse(), textResponse()]),
      ...cache,
    };
    const generate = createGeminiProvider({ model: 'gemini-pro', client, ...assembling() });

    await generate(makeContext(conversation));
    conversation.appendAssistantMessage('Reply 1');
    conversation.appendUserMessage('Turn 2');
    await generate(makeContext(conversation));

    expect(cache.calls).toHaveLength(1);
    for (const call of client._calls) {
      const config = call.config as Record<string, unknown>;
      expect(config['cachedContent']).toBe('cachedContents/abc123');
    }
  });

  it('shares one caches.create between concurrent first calls', async () => {
    const conversation = new Conversation();
    conversation.appendSystemMessage('You are a helpful assistant.');
    conversation.appendUserMessage('Hello');

    const cache = createFakeCaches();
    const client = {
      ...createMockGeminiModel([textResponse(), textResponse()]),
      ...cache,
    };
    const generate = createGeminiProvider({ model: 'gemini-pro', client, ...assembling() });

    await Promise.all([generate(makeContext(conversation)), generate(makeContext(conversation))]);

    expect(cache.calls).toHaveLength(1);
  });

  it('puts pinned messages into the cached contents', async () => {
    const conversation = new Conversation();
    conversation.appendSystemMessage('System prompt');
    conversation.appendUserMessage('Hello');

    const cache = createFakeCaches();
    const client = { ...createMockGeminiModel([textResponse()]), ...cache };
    const generate = createGeminiProvider({
      model: 'gemini-pro',
      client,
      ...assembling(),
      pinnedMessages: [pinnedMessage('Pinned reference content')],
    });

    await generate(makeContext(conversation));

    const createdConfig = cache.calls[0]?.config as Record<string, unknown>;
    expect(createdConfig['contents']).toEqual([
      { role: 'user', parts: [{ text: 'Pinned reference content' }] },
    ]);
    // The pinned message is the last of the stable prefix, so the tail is the
    // conversation's own user message alone.
    expect(client._calls[0]?.contents).toEqual([{ role: 'user', parts: [{ text: 'Hello' }] }]);
  });

  it('caches a pinned-only prefix when the conversation has no system message', async () => {
    const conversation = new Conversation();
    conversation.appendUserMessage('Hello');

    const cache = createFakeCaches();
    const client = { ...createMockGeminiModel([textResponse()]), ...cache };
    const generate = createGeminiProvider({
      model: 'gemini-pro',
      client,
      ...assembling(),
      pinnedMessages: [pinnedMessage('Pinned reference content')],
    });

    await generate(makeContext(conversation));

    const createdConfig = cache.calls[0]?.config as Record<string, unknown>;
    expect(createdConfig['systemInstruction']).toBeUndefined();
    expect(createdConfig['contents']).toEqual([
      { role: 'user', parts: [{ text: 'Pinned reference content' }] },
    ]);
  });

  it('sends the conversation whole and uncached when assembly produces no cache boundary', async () => {
    const conversation = new Conversation();
    conversation.appendUserMessage('Hello');

    const cache = createFakeCaches();
    const client = { ...createMockGeminiModel([textResponse()]), ...cache };
    const generate = createGeminiProvider({ model: 'gemini-pro', client, ...assembling() });

    await generate(makeContext(conversation));

    expect(cache.calls).toHaveLength(0);
    const config = client._calls[0]?.config as Record<string, unknown> | undefined;
    expect(config?.['cachedContent']).toBeUndefined();
    expect(client._calls[0]?.contents).toEqual([{ role: 'user', parts: [{ text: 'Hello' }] }]);
  });

  it('drives the provider-managed cache from the streaming factory too', async () => {
    const conversation = new Conversation();
    conversation.appendSystemMessage('You are a helpful assistant.');
    conversation.appendUserMessage('Hello');

    const cache = createFakeCaches();
    const client = { ...createMockGeminiStreamingModel([streamChunks()]), ...cache };
    const generate = createGeminiProviderStream({ model: 'gemini-pro', client, ...assembling() });

    await generate({ ...makeContext(conversation), streaming: makeStreamingHandle() });

    expect(cache.calls).toHaveLength(1);
    const config = client._calls[0]?.config as Record<string, unknown>;
    expect(config['cachedContent']).toBe('cachedContents/abc123');
    expect(config['systemInstruction']).toBeUndefined();
  });
});

// ── cacheTtl ────────────────────────────────────────────────────────

describe('createGeminiProvider — cacheTtl', () => {
  it('sends cacheTtl as the created resource ttl', async () => {
    const conversation = new Conversation();
    conversation.appendSystemMessage('You are a helpful assistant.');
    conversation.appendUserMessage('Hello');

    const cache = createFakeCaches();
    const client = { ...createMockGeminiModel([textResponse()]), ...cache };
    const generate = createGeminiProvider({
      model: 'gemini-pro',
      client,
      ...assembling(),
      cacheTtl: '3600s',
    });

    await generate(makeContext(conversation));

    const createdConfig = cache.calls[0]?.config as Record<string, unknown>;
    expect(createdConfig['ttl']).toBe('3600s');
  });

  it('omits ttl so Gemini applies its own default when cacheTtl is unset', async () => {
    const conversation = new Conversation();
    conversation.appendSystemMessage('You are a helpful assistant.');
    conversation.appendUserMessage('Hello');

    const cache = createFakeCaches();
    const client = { ...createMockGeminiModel([textResponse()]), ...cache };
    const generate = createGeminiProvider({ model: 'gemini-pro', client, ...assembling() });

    await generate(makeContext(conversation));

    const createdConfig = cache.calls[0]?.config as Record<string, unknown>;
    expect(createdConfig['ttl']).toBeUndefined();
  });
});

// ── Configuration errors, raised at factory-construction time ───────

describe('createGeminiProvider — cache configuration errors', () => {
  it('rejects cachedContent combined with assembler + contextBudget', () => {
    const cache = createFakeCaches();
    const client = { ...createMockGeminiModel([textResponse()]), ...cache };

    expect(() =>
      createGeminiProvider({
        model: 'gemini-pro',
        client,
        ...assembling(),
        cachedContent: 'cachedContents/provided-by-caller',
      }),
    ).toThrow(ProviderError);
  });

  it('rejects an injected client with no caches namespace when caching is configured', () => {
    const client = createMockGeminiModel([textResponse()]);

    expect(() => createGeminiProvider({ model: 'gemini-pro', client, ...assembling() })).toThrow(
      /caches\.create/,
    );
  });

  it('rejects an injected client whose caches namespace has no create function', () => {
    const client = { ...createMockGeminiModel([textResponse()]), caches: { create: 'nope' } };

    expect(() => createGeminiProvider({ model: 'gemini-pro', client, ...assembling() })).toThrow(
      ProviderError,
    );
  });

  it('rejects an injected client whose caches property is not an object', () => {
    const client = { ...createMockGeminiModel([textResponse()]), caches: null };

    expect(() => createGeminiProvider({ model: 'gemini-pro', client, ...assembling() })).toThrow(
      ProviderError,
    );
  });

  it('rejects an injected client whose caches object has no create key at all', () => {
    const client = { ...createMockGeminiModel([textResponse()]), caches: { list: () => [] } };

    expect(() => createGeminiProvider({ model: 'gemini-pro', client, ...assembling() })).toThrow(
      ProviderError,
    );
  });

  it('accepts a cache-incapable client when a separate cacheClient is supplied', async () => {
    const conversation = new Conversation();
    conversation.appendSystemMessage('You are a helpful assistant.');
    conversation.appendUserMessage('Hello');

    const cache = createFakeCaches();
    const client = createMockGeminiModel([textResponse()]);
    const generate = createGeminiProvider({
      model: 'gemini-pro',
      client,
      ...assembling(),
      cacheClient: cache,
    });

    await generate(makeContext(conversation));

    expect(cache.calls).toHaveLength(1);
  });

  it('constructs without a client at all, deferring cache creation to the imported one', () => {
    expect(() => createGeminiProvider({ model: 'gemini-pro', ...assembling() })).not.toThrow();
  });

  it('leaves a lone assembler inert, matching the Anthropic engagement condition', async () => {
    const conversation = new Conversation();
    conversation.appendSystemMessage('You are a helpful assistant.');
    conversation.appendUserMessage('Hello');

    const client = createMockGeminiModel([textResponse()]);
    const generate = createGeminiProvider({
      model: 'gemini-pro',
      client,
      assembler: createContextAssembler(),
    });

    await generate(makeContext(conversation));

    const config = client._calls[0]?.config as Record<string, unknown>;
    expect(config['cachedContent']).toBeUndefined();
    expect(config['systemInstruction']).toEqual({
      role: 'user',
      parts: [{ text: 'You are a helpful assistant.' }],
    });
  });
});

// ── Cache creation failures ─────────────────────────────────────────

describe('createGeminiProvider — cache creation failures', () => {
  it('normalizes a caches.create rejection into a ProviderError', async () => {
    const conversation = new Conversation();
    conversation.appendSystemMessage('You are a helpful assistant.');
    conversation.appendUserMessage('Hello');

    const cache = createFakeCaches({ failure: new Error('cache minimum token count not met') });
    const client = { ...createMockGeminiModel([textResponse()]), ...cache };
    const generate = createGeminiProvider({ model: 'gemini-pro', client, ...assembling() });

    await expect(generate(makeContext(conversation))).rejects.toThrow(ProviderError);
  });

  it('does not silently fall back to an uncached request when creation fails', async () => {
    const conversation = new Conversation();
    conversation.appendSystemMessage('You are a helpful assistant.');
    conversation.appendUserMessage('Hello');

    const cache = createFakeCaches({ failure: new Error('cache minimum token count not met') });
    const client = { ...createMockGeminiModel([textResponse()]), ...cache };
    const generate = createGeminiProvider({ model: 'gemini-pro', client, ...assembling() });

    await expect(generate(makeContext(conversation))).rejects.toThrow(ProviderError);
    expect(client._calls).toHaveLength(0);
  });

  it('throws when caches.create returns no resource name to reference', async () => {
    const conversation = new Conversation();
    conversation.appendSystemMessage('You are a helpful assistant.');
    conversation.appendUserMessage('Hello');

    const cache = createFakeCaches({ name: undefined });
    const client = { ...createMockGeminiModel([textResponse()]), ...cache };
    const generate = createGeminiProvider({ model: 'gemini-pro', client, ...assembling() });

    await expect(generate(makeContext(conversation))).rejects.toThrow(/no resource name/);
  });
});

// ── Cache token accounting ──────────────────────────────────────────

describe('Gemini provider cache token accounting', () => {
  it('reports cacheReadTokens and excludes them from prompt', async () => {
    const client = createMockGeminiModel([
      {
        candidates: [{ content: { parts: [{ text: 'hi' }] } }],
        usageMetadata: {
          promptTokenCount: 1000,
          candidatesTokenCount: 20,
          totalTokenCount: 1020,
          cachedContentTokenCount: 900,
        },
      },
    ]);
    const generate = createGeminiProvider({ model: 'gemini-pro', client });

    const result = await generate(makeContext(new Conversation()));

    expect(result.usage).toEqual({
      prompt: 100,
      completion: 20,
      total: 1020,
      cacheReadTokens: 900,
    });
  });

  it('leaves cacheReadTokens undefined when the API reported no cache activity', async () => {
    const client = createMockGeminiModel([textResponse()]);
    const generate = createGeminiProvider({ model: 'gemini-pro', client });

    const result = await generate(makeContext(new Conversation()));

    expect(result.usage).toEqual({ prompt: 10, completion: 5, total: 15 });
  });

  it('never fabricates cacheCreationTokens — Gemini reports no cache-write count', async () => {
    const client = createMockGeminiModel([
      {
        candidates: [{ content: { parts: [{ text: 'hi' }] } }],
        usageMetadata: {
          promptTokenCount: 1000,
          candidatesTokenCount: 20,
          totalTokenCount: 1020,
          cachedContentTokenCount: 900,
        },
      },
    ]);
    const generate = createGeminiProvider({ model: 'gemini-pro', client });

    const result = await generate(makeContext(new Conversation()));

    expect(result.usage).not.toHaveProperty('cacheCreationTokens');
  });

  it('clamps prompt at zero when the cached count exceeds the prompt count', async () => {
    const client = createMockGeminiModel([
      {
        candidates: [{ content: { parts: [{ text: 'hi' }] } }],
        usageMetadata: { candidatesTokenCount: 20, cachedContentTokenCount: 900 },
      },
    ]);
    const generate = createGeminiProvider({ model: 'gemini-pro', client });

    const result = await generate(makeContext(new Conversation()));

    expect(result.usage).toEqual({
      prompt: 0,
      completion: 20,
      total: 20,
      cacheReadTokens: 900,
    });
  });

  it('reports cache token accounting from the streaming factory too', async () => {
    const client = createMockGeminiStreamingModel([
      [
        {
          candidates: [{ content: { parts: [{ text: 'hi' }] } }],
          usageMetadata: {
            promptTokenCount: 1000,
            candidatesTokenCount: 20,
            totalTokenCount: 1020,
            cachedContentTokenCount: 900,
          },
        },
      ],
    ]);
    const generate = createGeminiProviderStream({ model: 'gemini-pro', client });

    const result = await generate({
      ...makeContext(new Conversation()),
      streaming: makeStreamingHandle(),
    });

    expect(result.usage).toEqual({
      prompt: 100,
      completion: 20,
      total: 1020,
      cacheReadTokens: 900,
    });
  });
});
