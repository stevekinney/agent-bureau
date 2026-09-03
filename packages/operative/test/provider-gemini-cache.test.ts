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
 *     as a cache resource, and every request sends only the tail.
 *
 * A generated function is reusable across runs, so the provider-managed
 * resource is memoized per stable prefix rather than once per factory, each
 * entry carries what is known about when it expires, the retained set is
 * bounded, and a request the API rejects for naming a dead cache rebuilds it
 * once. Those four properties are one lifecycle, and the suites below pin them
 * together.
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
  GeminiGenerateContentRequest,
  GeminiGenerateContentResult,
} from '../src/providers/types.ts';
import type { GenerateContext, StreamingHandle } from '../src/types.ts';

function makeContext(conversation: Conversation): GenerateContext {
  return { conversation, step: 0, toolbox: createToolbox([]) };
}

function makeStreamingHandle(): StreamingHandle {
  return { update: () => {}, messageId: 'test-message-id' };
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

/** What one `caches.create` call should do. */
interface FakeCacheOutcome {
  /** Resource name to return. Omitted means the API answered without one. */
  name?: string;
  /** `CachedContent.expireTime` to report. Omitted means the API reported none. */
  expireTime?: string;
  /** Thrown instead of answering, when the key is present. */
  failure?: unknown;
}

const DEFAULT_CACHE_NAME = 'cachedContents/abc123';

/** A timestamp far enough out that no test run reaches it. */
const FAR_FUTURE = new Date(Date.now() + 3_600_000).toISOString();
/** A timestamp already past when the entry is created. */
const ALREADY_PAST = new Date(Date.now() - 1_000).toISOString();

/**
 * A `caches` namespace that records what it was asked to create. Built here
 * rather than in `src/providers/test/mock-clients.ts` to match the fakes the
 * batch-client suite builds in its own file for the same reason: the shape is
 * specific to this suite's assertions.
 *
 * `outcomes` supplies one entry per `caches.create` call, and the last entry
 * repeats for every call past the end of the list — so a one-entry list
 * describes a fake that always answers the same way, while a longer list lets a
 * test give successive creations distinct names or expiry times.
 */
function createFakeCaches(outcomes: FakeCacheOutcome[] = [{ name: DEFAULT_CACHE_NAME }]): {
  caches: { create(params: GeminiCreateCachedContentRequest): Promise<GeminiCachedContent> };
  calls: GeminiCreateCachedContentRequest[];
} {
  const calls: GeminiCreateCachedContentRequest[] = [];
  let callIndex = 0;
  return {
    calls,
    caches: {
      async create(params: GeminiCreateCachedContentRequest): Promise<GeminiCachedContent> {
        calls.push(params);
        const outcome = outcomes[Math.min(callIndex, outcomes.length - 1)] ?? {};
        callIndex += 1;
        if ('failure' in outcome) throw outcome.failure;
        return {
          ...(outcome.name === undefined ? {} : { name: outcome.name }),
          ...(outcome.expireTime === undefined ? {} : { expireTime: outcome.expireTime }),
          model: params.model,
        };
      },
    },
  };
}

/**
 * A generate client that throws `failure` on its first call and answers
 * normally afterwards.
 *
 * `createMockGeminiModel` types its failures as `Error[]`, which cannot express
 * the bare strings and non-`Error` objects an SDK is free to throw — and those
 * are exactly the shapes the missing-cache detector has to survive.
 */
function createFailFirstGeminiModel(failure: unknown): {
  _calls: GeminiGenerateContentRequest[];
  models: {
    generateContent(params: GeminiGenerateContentRequest): Promise<GeminiGenerateContentResult>;
  };
} {
  const calls: GeminiGenerateContentRequest[] = [];
  return {
    _calls: calls,
    models: {
      async generateContent(
        params: GeminiGenerateContentRequest,
      ): Promise<GeminiGenerateContentResult> {
        calls.push(params);
        if (calls.length === 1) throw failure;
        return textResponse();
      },
    },
  };
}

/** A conversation carrying its own distinct system prompt plus one user turn. */
function conversationWithSystem(systemPrompt: string): Conversation {
  const conversation = new Conversation();
  conversation.appendSystemMessage(systemPrompt);
  conversation.appendUserMessage('Hello');
  return conversation;
}

/** The `config.cachedContent` a recorded generate request referenced. */
function referencedCache(request: GeminiGenerateContentRequest | undefined): unknown {
  return (request?.config as Record<string, unknown> | undefined)?.['cachedContent'];
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

  // The cache is the head of the prompt, so the conversation has to be the
  // tail. Operative cannot subtract a prefix it never saw, so the contract is
  // the caller's to keep — but the system-instruction half of it is checkable
  // from here, and a violation has to be a diagnostic rather than a request
  // that quietly states the cached instruction twice.
  it('rejects a system message in the conversation beside a caller-owned cache', async () => {
    const client = createMockGeminiModel([textResponse()]);
    const generate = createGeminiProvider({
      model: 'gemini-pro',
      client,
      cachedContent: 'cachedContents/provided-by-caller',
    });

    await expect(
      generate(makeContext(conversationWithSystem('You are a helpful assistant.'))),
    ).rejects.toThrow(ProviderError);
    expect(client._calls).toHaveLength(0);
  });

  it('names the cache and the fix when it rejects a non-tail conversation', async () => {
    const client = createMockGeminiModel([textResponse()]);
    const generate = createGeminiProvider({
      model: 'gemini-pro',
      client,
      cachedContent: 'cachedContents/provided-by-caller',
    });

    await expect(
      generate(makeContext(conversationWithSystem('You are a helpful assistant.'))),
    ).rejects.toThrow(/cachedContents\/provided-by-caller.*tail only/s);
  });

  it('rejects a non-tail conversation on the streaming factory too', async () => {
    const client = createMockGeminiStreamingModel([streamChunks()]);
    const generate = createGeminiProviderStream({
      model: 'gemini-pro',
      client,
      cachedContent: 'cachedContents/provided-by-caller',
    });

    await expect(
      generate({
        ...makeContext(conversationWithSystem('You are a helpful assistant.')),
        streaming: makeStreamingHandle(),
      }),
    ).rejects.toThrow(ProviderError);
    expect(client._calls).toHaveLength(0);
  });

  it('leaves a system message alone when no caller-owned cache is named', async () => {
    // The contract is a consequence of `cachedContent`, not a new rule about
    // system messages: the uncached path still sends one as it always has.
    const client = createMockGeminiModel([textResponse()]);
    const generate = createGeminiProvider({ model: 'gemini-pro', client });

    await generate(makeContext(conversationWithSystem('You are a helpful assistant.')));

    const config = client._calls[0]?.config as Record<string, unknown>;
    expect(config['systemInstruction']).toBeDefined();
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

  it('creates through a cache-capable injected client rather than cacheClient', async () => {
    const conversation = conversationWithSystem('You are a helpful assistant.');

    // Two clients that could each create a cache — the contract says the
    // injected one wins, because a cache created on the other one's
    // credentials, project, or endpoint may be invisible to the client that
    // then has to generate against it.
    const clientCache = createFakeCaches([{ name: 'cachedContents/from-client' }]);
    const separateCacheClient = createFakeCaches([{ name: 'cachedContents/from-cache-client' }]);
    const client = { ...createMockGeminiModel([textResponse()]), ...clientCache };
    const generate = createGeminiProvider({
      model: 'gemini-pro',
      client,
      ...assembling(),
      cacheClient: separateCacheClient,
    });

    await generate(makeContext(conversation));

    expect(clientCache.calls).toHaveLength(1);
    expect(separateCacheClient.calls).toHaveLength(0);
    expect(referencedCache(client._calls[0])).toBe('cachedContents/from-client');
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

    const cache = createFakeCaches([{ failure: new Error('cache minimum token count not met') }]);
    const client = { ...createMockGeminiModel([textResponse()]), ...cache };
    const generate = createGeminiProvider({ model: 'gemini-pro', client, ...assembling() });

    await expect(generate(makeContext(conversation))).rejects.toThrow(ProviderError);
  });

  it('does not silently fall back to an uncached request when creation fails', async () => {
    const conversation = new Conversation();
    conversation.appendSystemMessage('You are a helpful assistant.');
    conversation.appendUserMessage('Hello');

    const cache = createFakeCaches([{ failure: new Error('cache minimum token count not met') }]);
    const client = { ...createMockGeminiModel([textResponse()]), ...cache };
    const generate = createGeminiProvider({ model: 'gemini-pro', client, ...assembling() });

    await expect(generate(makeContext(conversation))).rejects.toThrow(ProviderError);
    expect(client._calls).toHaveLength(0);
  });

  it('throws when caches.create returns no resource name to reference', async () => {
    const conversation = new Conversation();
    conversation.appendSystemMessage('You are a helpful assistant.');
    conversation.appendUserMessage('Hello');

    const cache = createFakeCaches([{}]);
    const client = { ...createMockGeminiModel([textResponse()]), ...cache };
    const generate = createGeminiProvider({ model: 'gemini-pro', client, ...assembling() });

    await expect(generate(makeContext(conversation))).rejects.toThrow(/no resource name/);
  });
});

// ── Cache identity: one resource per stable prefix ──────────────────

describe('createGeminiProvider — cache keyed by stable prefix', () => {
  it('creates a separate cache for a second run with a different system prompt', async () => {
    const cache = createFakeCaches([
      { name: 'cachedContents/first', expireTime: FAR_FUTURE },
      { name: 'cachedContents/second', expireTime: FAR_FUTURE },
    ]);
    const client = { ...createMockGeminiModel([textResponse(), textResponse()]), ...cache };
    const generate = createGeminiProvider({ model: 'gemini-pro', client, ...assembling() });

    await generate(makeContext(conversationWithSystem('You are a poet.')));
    await generate(makeContext(conversationWithSystem('You are a lawyer.')));

    expect(cache.calls).toHaveLength(2);
    expect((cache.calls[1]?.config as Record<string, unknown>)['systemInstruction']).toEqual({
      role: 'user',
      parts: [{ text: 'You are a lawyer.' }],
    });
  });

  it('never lets a second run reference the first run’s cached content', async () => {
    const cache = createFakeCaches([
      { name: 'cachedContents/first', expireTime: FAR_FUTURE },
      { name: 'cachedContents/second', expireTime: FAR_FUTURE },
    ]);
    const client = { ...createMockGeminiModel([textResponse(), textResponse()]), ...cache };
    const generate = createGeminiProvider({ model: 'gemini-pro', client, ...assembling() });

    await generate(makeContext(conversationWithSystem('You are a poet.')));
    await generate(makeContext(conversationWithSystem('You are a lawyer.')));

    expect(referencedCache(client._calls[0])).toBe('cachedContents/first');
    expect(referencedCache(client._calls[1])).toBe('cachedContents/second');
  });

  it('shares one cache between two conversations that assemble the same prefix', async () => {
    const cache = createFakeCaches([{ name: DEFAULT_CACHE_NAME, expireTime: FAR_FUTURE }]);
    const client = { ...createMockGeminiModel([textResponse(), textResponse()]), ...cache };
    const generate = createGeminiProvider({ model: 'gemini-pro', client, ...assembling() });

    await generate(makeContext(conversationWithSystem('You are a helpful assistant.')));
    await generate(makeContext(conversationWithSystem('You are a helpful assistant.')));

    expect(cache.calls).toHaveLength(1);
    expect(referencedCache(client._calls[1])).toBe(DEFAULT_CACHE_NAME);
  });

  it('bounds the retained set, evicting the least recently used prefix', async () => {
    // The documented bound is eight entries, so a ninth distinct prefix must
    // push the coldest one out.
    const distinctPrefixes = 9;
    const cache = createFakeCaches([{ name: DEFAULT_CACHE_NAME, expireTime: FAR_FUTURE }]);
    const client = {
      ...createMockGeminiModel(Array.from({ length: distinctPrefixes + 2 }, () => textResponse())),
      ...cache,
    };
    const generate = createGeminiProvider({ model: 'gemini-pro', client, ...assembling() });

    for (let index = 0; index < distinctPrefixes; index += 1) {
      await generate(makeContext(conversationWithSystem(`System prompt ${index}`)));
    }
    expect(cache.calls).toHaveLength(distinctPrefixes);

    // The first prefix was evicted, so it has to be created again.
    await generate(makeContext(conversationWithSystem('System prompt 0')));
    expect(cache.calls).toHaveLength(distinctPrefixes + 1);

    // The most recently used prefix survived eviction and is still reused.
    await generate(makeContext(conversationWithSystem(`System prompt ${distinctPrefixes - 1}`)));
    expect(cache.calls).toHaveLength(distinctPrefixes + 1);
  });

  it('retries a failed creation on the next call instead of replaying the rejection', async () => {
    const cache = createFakeCaches([
      { failure: new Error('cache minimum token count not met') },
      { name: 'cachedContents/second-try', expireTime: FAR_FUTURE },
    ]);
    const client = { ...createMockGeminiModel([textResponse()]), ...cache };
    const generate = createGeminiProvider({ model: 'gemini-pro', client, ...assembling() });
    const conversation = conversationWithSystem('You are a helpful assistant.');

    await expect(generate(makeContext(conversation))).rejects.toThrow(ProviderError);
    await generate(makeContext(conversation));

    expect(cache.calls).toHaveLength(2);
    expect(referencedCache(client._calls[0])).toBe('cachedContents/second-try');
  });
});

// ── Cache expiry ────────────────────────────────────────────────────

describe('createGeminiProvider — managed cache expiry', () => {
  it('reuses a cache whose reported expireTime is still in the future', async () => {
    const cache = createFakeCaches([{ name: DEFAULT_CACHE_NAME, expireTime: FAR_FUTURE }]);
    const client = { ...createMockGeminiModel([textResponse(), textResponse()]), ...cache };
    const generate = createGeminiProvider({ model: 'gemini-pro', client, ...assembling() });
    const conversation = conversationWithSystem('You are a helpful assistant.');

    await generate(makeContext(conversation));
    await generate(makeContext(conversation));

    expect(cache.calls).toHaveLength(1);
  });

  it('replaces a cache whose reported expireTime has already passed', async () => {
    const cache = createFakeCaches([
      { name: 'cachedContents/lapsed', expireTime: ALREADY_PAST },
      { name: 'cachedContents/renewed', expireTime: FAR_FUTURE },
    ]);
    const client = { ...createMockGeminiModel([textResponse(), textResponse()]), ...cache };
    const generate = createGeminiProvider({ model: 'gemini-pro', client, ...assembling() });
    const conversation = conversationWithSystem('You are a helpful assistant.');

    await generate(makeContext(conversation));
    await generate(makeContext(conversation));

    expect(cache.calls).toHaveLength(2);
    expect(referencedCache(client._calls[1])).toBe('cachedContents/renewed');
  });

  // A Gemini cache is a billable resource, so "renew it once" is a cost
  // property and not just a tidiness one. Every request in a burst awaits the
  // same lapsed entry and wakes to the same lapsed answer, so each one has to
  // be able to tell whether another has already installed the renewal.
  it('installs one shared renewal for a burst of concurrent requests after expiry', async () => {
    const cache = createFakeCaches([
      { name: 'cachedContents/lapsed', expireTime: ALREADY_PAST },
      { name: 'cachedContents/renewed', expireTime: FAR_FUTURE },
    ]);
    const client = {
      ...createMockGeminiModel([textResponse(), textResponse(), textResponse(), textResponse()]),
      ...cache,
    };
    const generate = createGeminiProvider({ model: 'gemini-pro', client, ...assembling() });
    const conversation = conversationWithSystem('You are a helpful assistant.');

    // Seed the entry, and let it be lapsed by the time the burst arrives.
    await generate(makeContext(conversation));
    expect(cache.calls).toHaveLength(1);

    await Promise.all([
      generate(makeContext(conversation)),
      generate(makeContext(conversation)),
      generate(makeContext(conversation)),
    ]);

    // One renewal for three concurrent requests, not one billable cache each.
    expect(cache.calls).toHaveLength(2);
    expect(client._calls.slice(1).map(referencedCache)).toEqual([
      'cachedContents/renewed',
      'cachedContents/renewed',
      'cachedContents/renewed',
    ]);
  });

  it('prefers the SDK’s expireTime over a configured cacheTtl that is still live', async () => {
    const cache = createFakeCaches([
      { name: 'cachedContents/lapsed', expireTime: ALREADY_PAST },
      { name: 'cachedContents/renewed', expireTime: FAR_FUTURE },
    ]);
    const client = { ...createMockGeminiModel([textResponse(), textResponse()]), ...cache };
    const generate = createGeminiProvider({
      model: 'gemini-pro',
      client,
      ...assembling(),
      cacheTtl: '3600s',
    });
    const conversation = conversationWithSystem('You are a helpful assistant.');

    await generate(makeContext(conversation));
    await generate(makeContext(conversation));

    expect(cache.calls).toHaveLength(2);
  });

  it('falls back to cacheTtl when the SDK reports no expireTime', async () => {
    const cache = createFakeCaches([{ name: DEFAULT_CACHE_NAME }]);
    const client = { ...createMockGeminiModel([textResponse(), textResponse()]), ...cache };
    const generate = createGeminiProvider({
      model: 'gemini-pro',
      client,
      ...assembling(),
      cacheTtl: '3600s',
    });
    const conversation = conversationWithSystem('You are a helpful assistant.');

    await generate(makeContext(conversation));
    await generate(makeContext(conversation));

    expect(cache.calls).toHaveLength(1);
  });

  it('treats a zero-second cacheTtl as immediately lapsed', async () => {
    const cache = createFakeCaches([{ name: DEFAULT_CACHE_NAME }]);
    const client = { ...createMockGeminiModel([textResponse(), textResponse()]), ...cache };
    const generate = createGeminiProvider({
      model: 'gemini-pro',
      client,
      ...assembling(),
      cacheTtl: '0s',
    });
    const conversation = conversationWithSystem('You are a helpful assistant.');

    await generate(makeContext(conversation));
    await generate(makeContext(conversation));

    expect(cache.calls).toHaveLength(2);
  });

  it('falls back to cacheTtl when expireTime is not a parseable timestamp', async () => {
    const cache = createFakeCaches([{ name: DEFAULT_CACHE_NAME, expireTime: 'whenever' }]);
    const client = { ...createMockGeminiModel([textResponse(), textResponse()]), ...cache };
    const generate = createGeminiProvider({
      model: 'gemini-pro',
      client,
      ...assembling(),
      cacheTtl: '0s',
    });
    const conversation = conversationWithSystem('You are a helpful assistant.');

    await generate(makeContext(conversation));
    await generate(makeContext(conversation));

    expect(cache.calls).toHaveLength(2);
  });

  it('keeps a cache when neither expireTime nor cacheTtl yields a timestamp', async () => {
    const cache = createFakeCaches([{ name: DEFAULT_CACHE_NAME }]);
    const client = { ...createMockGeminiModel([textResponse(), textResponse()]), ...cache };
    const generate = createGeminiProvider({
      model: 'gemini-pro',
      client,
      ...assembling(),
      // Not the SDK's duration grammar, so it buys no local expiry bookkeeping.
      cacheTtl: 'forever',
    });
    const conversation = conversationWithSystem('You are a helpful assistant.');

    await generate(makeContext(conversation));
    await generate(makeContext(conversation));

    expect(cache.calls).toHaveLength(1);
  });

  it('replaces only the lapsed prefix, leaving another prefix’s cache alone', async () => {
    const cache = createFakeCaches([
      { name: 'cachedContents/poet-1', expireTime: ALREADY_PAST },
      { name: 'cachedContents/lawyer-1', expireTime: FAR_FUTURE },
      { name: 'cachedContents/poet-2', expireTime: FAR_FUTURE },
    ]);
    const client = {
      ...createMockGeminiModel(Array.from({ length: 4 }, () => textResponse())),
      ...cache,
    };
    const generate = createGeminiProvider({ model: 'gemini-pro', client, ...assembling() });

    await generate(makeContext(conversationWithSystem('You are a poet.')));
    await generate(makeContext(conversationWithSystem('You are a lawyer.')));
    await generate(makeContext(conversationWithSystem('You are a poet.')));
    await generate(makeContext(conversationWithSystem('You are a lawyer.')));

    expect(cache.calls).toHaveLength(3);
    expect(client._calls.map(referencedCache)).toEqual([
      'cachedContents/poet-1',
      'cachedContents/lawyer-1',
      'cachedContents/poet-2',
      'cachedContents/lawyer-1',
    ]);
  });
});

// ── Request-time recovery from a cache that is already gone ─────────

describe('createGeminiProvider — recovery from a missing cache', () => {
  it('rebuilds the cache and retries once when the request rejects its name', async () => {
    const cache = createFakeCaches([
      { name: 'cachedContents/stale', expireTime: FAR_FUTURE },
      { name: 'cachedContents/rebuilt', expireTime: FAR_FUTURE },
    ]);
    const client = {
      ...createMockGeminiModel(
        [textResponse()],
        [new Error('CachedContent not found (or permission denied)')],
      ),
      ...cache,
    };
    const generate = createGeminiProvider({ model: 'gemini-pro', client, ...assembling() });

    const result = await generate(makeContext(conversationWithSystem('You are helpful.')));

    expect(result.content).toBe('ok');
    expect(cache.calls).toHaveLength(2);
    expect(client._calls.map(referencedCache)).toEqual([
      'cachedContents/stale',
      'cachedContents/rebuilt',
    ]);
  });

  it('recognizes an expired-cache rejection thrown as a bare string', async () => {
    const cache = createFakeCaches([
      { name: 'cachedContents/stale', expireTime: FAR_FUTURE },
      { name: 'cachedContents/rebuilt', expireTime: FAR_FUTURE },
    ]);
    const client = {
      ...createFailFirstGeminiModel('CachedContent cachedContents/stale has expired'),
      ...cache,
    };
    const generate = createGeminiProvider({ model: 'gemini-pro', client, ...assembling() });

    await generate(makeContext(conversationWithSystem('You are helpful.')));

    expect(cache.calls).toHaveLength(2);
    expect(referencedCache(client._calls[1])).toBe('cachedContents/rebuilt');
  });

  it('does not retry a rejection thrown as a value carrying no message', async () => {
    const cache = createFakeCaches([{ name: DEFAULT_CACHE_NAME, expireTime: FAR_FUTURE }]);
    const client = { ...createFailFirstGeminiModel({ code: 404 }), ...cache };
    const generate = createGeminiProvider({ model: 'gemini-pro', client, ...assembling() });

    await expect(generate(makeContext(conversationWithSystem('You are helpful.')))).rejects.toThrow(
      ProviderError,
    );
    expect(cache.calls).toHaveLength(1);
    expect(client._calls).toHaveLength(1);
  });

  it('does not retry a rejection that is about something other than the cache', async () => {
    const cache = createFakeCaches([{ name: DEFAULT_CACHE_NAME, expireTime: FAR_FUTURE }]);
    const client = {
      ...createMockGeminiModel([textResponse()], [new Error('quota exceeded for this project')]),
      ...cache,
    };
    const generate = createGeminiProvider({ model: 'gemini-pro', client, ...assembling() });

    await expect(generate(makeContext(conversationWithSystem('You are helpful.')))).rejects.toThrow(
      ProviderError,
    );
    expect(cache.calls).toHaveLength(1);
    expect(client._calls).toHaveLength(1);
  });

  it('does not retry a rejection naming the cache for an unrelated reason', async () => {
    const cache = createFakeCaches([{ name: DEFAULT_CACHE_NAME, expireTime: FAR_FUTURE }]);
    const client = {
      ...createMockGeminiModel(
        [textResponse()],
        [new Error('CachedContent minimum token count not met')],
      ),
      ...cache,
    };
    const generate = createGeminiProvider({ model: 'gemini-pro', client, ...assembling() });

    await expect(generate(makeContext(conversationWithSystem('You are helpful.')))).rejects.toThrow(
      ProviderError,
    );
    expect(client._calls).toHaveLength(1);
  });

  it('surfaces a second missing-cache rejection rather than retrying again', async () => {
    const cache = createFakeCaches([{ name: DEFAULT_CACHE_NAME, expireTime: FAR_FUTURE }]);
    const client = {
      ...createMockGeminiModel(
        [textResponse()],
        [new Error('CachedContent not found'), new Error('CachedContent not found')],
      ),
      ...cache,
    };
    const generate = createGeminiProvider({ model: 'gemini-pro', client, ...assembling() });

    await expect(generate(makeContext(conversationWithSystem('You are helpful.')))).rejects.toThrow(
      ProviderError,
    );
    expect(cache.calls).toHaveLength(2);
    expect(client._calls).toHaveLength(2);
  });

  it('does not retry when the run references a cache the caller owns', async () => {
    const conversation = new Conversation();
    conversation.appendUserMessage('Hello');

    const client = createMockGeminiModel([textResponse()], [new Error('CachedContent not found')]);
    const generate = createGeminiProvider({
      model: 'gemini-pro',
      client,
      cachedContent: 'cachedContents/provided-by-caller',
    });

    await expect(generate(makeContext(conversation))).rejects.toThrow(ProviderError);
    expect(client._calls).toHaveLength(1);
  });

  it('recovers a streaming request that fails before any text is emitted', async () => {
    const cache = createFakeCaches([
      { name: 'cachedContents/stale', expireTime: FAR_FUTURE },
      { name: 'cachedContents/rebuilt', expireTime: FAR_FUTURE },
    ]);
    const client = {
      ...createMockGeminiStreamingModel([streamChunks()], [new Error('CachedContent not found')]),
      ...cache,
    };
    const generate = createGeminiProviderStream({ model: 'gemini-pro', client, ...assembling() });

    const result = await generate({
      ...makeContext(conversationWithSystem('You are helpful.')),
      streaming: makeStreamingHandle(),
    });

    expect(result.content).toBe('ok');
    expect(cache.calls).toHaveLength(2);
    expect(referencedCache(client._calls[1])).toBe('cachedContents/rebuilt');
  });

  it('does not rewind a stream that already emitted text before the rejection', async () => {
    const cache = createFakeCaches([{ name: DEFAULT_CACHE_NAME, expireTime: FAR_FUTURE }]);
    const updates: string[] = [];
    const client = {
      ...createMockGeminiStreamingModel([streamChunks()], [new Error('CachedContent not found')], {
        errorAfterEvents: 1,
      }),
      ...cache,
    };
    const generate = createGeminiProviderStream({ model: 'gemini-pro', client, ...assembling() });

    await expect(
      generate({
        ...makeContext(conversationWithSystem('You are helpful.')),
        streaming: {
          update: (text: string) => {
            updates.push(text);
          },
          messageId: 'test-message-id',
        },
      }),
    ).rejects.toThrow(ProviderError);

    expect(updates).toEqual(['ok']);
    expect(cache.calls).toHaveLength(1);
    expect(client._calls).toHaveLength(1);
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
