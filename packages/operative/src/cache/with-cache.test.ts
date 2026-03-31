import { createTestToolbox } from 'armorer/test';
import { beforeEach, describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';
import { createMemoryKeyValueStore } from 'storage';

import type { GenerateContext, GenerateFunction, GenerateResponse } from '../types';
import type { CacheEntry, CacheHitEvent, CacheMissEvent } from './types';
import { withCache } from './with-cache';

function makeContext(message = 'Hello'): GenerateContext {
  const conversation = new Conversation();
  conversation.appendUserMessage(message);
  return {
    conversation,
    step: 1,
    toolbox: createTestToolbox([]),
  };
}

function createTrackingGenerate(
  response: GenerateResponse = {
    content: 'response',
    toolCalls: [],
    usage: { prompt: 100, completion: 50, total: 150 },
  },
): GenerateFunction & { calls: GenerateContext[] } {
  const calls: GenerateContext[] = [];
  const fn = async (context: GenerateContext): Promise<GenerateResponse> => {
    calls.push(context);
    return response;
  };
  (fn as GenerateFunction & { calls: GenerateContext[] }).calls = calls;
  return fn as GenerateFunction & { calls: GenerateContext[] };
}

describe('withCache', () => {
  let store: ReturnType<typeof createMemoryKeyValueStore>;

  beforeEach(() => {
    store = createMemoryKeyValueStore();
  });

  it('calls the underlying generate on a cache miss', async () => {
    const generate = createTrackingGenerate();
    const cached = withCache(generate, { store });
    const context = makeContext();

    const result = await cached(context);

    expect(generate.calls).toHaveLength(1);
    expect(result.content).toBe('response');
  });

  it('returns cached response on a cache hit', async () => {
    const generate = createTrackingGenerate();
    const cached = withCache(generate, { store });

    const context1 = makeContext();
    await cached(context1);

    const context2 = makeContext();
    const result = await cached(context2);

    expect(generate.calls).toHaveLength(1);
    expect(result.content).toBe('response');
  });

  it('calls onHit when a cached response is found', async () => {
    const hits: CacheHitEvent[] = [];
    const generate = createTrackingGenerate();
    const cached = withCache(generate, {
      store,
      onHit: (event) => hits.push(event),
    });

    await cached(makeContext());
    await cached(makeContext());

    expect(hits).toHaveLength(1);
    expect(hits[0]!.key).toBeString();
    expect(hits[0]!.age).toBeGreaterThanOrEqual(0);
  });

  it('calls onMiss when no cached response is found', async () => {
    const misses: CacheMissEvent[] = [];
    const generate = createTrackingGenerate();
    const cached = withCache(generate, {
      store,
      onMiss: (event) => misses.push(event),
    });

    await cached(makeContext());

    expect(misses).toHaveLength(1);
    expect(misses[0]!.key).toBeString();
    expect(misses[0]!.duration).toBeGreaterThanOrEqual(0);
  });

  it('respects TTL and treats expired entries as misses', async () => {
    const generate = createTrackingGenerate();
    const cached = withCache(generate, { store, ttl: 0.01 }); // 10ms TTL

    await cached(makeContext());

    // Wait well beyond the TTL for the entry to expire
    await new Promise((resolve) => setTimeout(resolve, 100));

    await cached(makeContext());

    expect(generate.calls).toHaveLength(2);
  });

  it('does not cache responses with tool calls when invalidateOnToolCalls is true', async () => {
    const generate = createTrackingGenerate({
      content: 'response',
      toolCalls: [{ id: 'call-1', name: 'test', arguments: {} }],
      usage: { prompt: 100, completion: 50, total: 150 },
    });
    const cached = withCache(generate, { store, invalidateOnToolCalls: true });

    await cached(makeContext());
    await cached(makeContext());

    expect(generate.calls).toHaveLength(2);
  });

  it('caches responses with tool calls when invalidateOnToolCalls is false (default)', async () => {
    const generate = createTrackingGenerate({
      content: 'response',
      toolCalls: [{ id: 'call-1', name: 'test', arguments: {} }],
      usage: { prompt: 100, completion: 50, total: 150 },
    });
    const cached = withCache(generate, { store });

    await cached(makeContext());
    await cached(makeContext());

    expect(generate.calls).toHaveLength(1);
  });

  it('uses the configured namespace as a key prefix', async () => {
    const generate = createTrackingGenerate();
    const cached = withCache(generate, { store, namespace: 'custom:' });

    await cached(makeContext());

    const keys = await store.list('custom:');
    expect(keys).toHaveLength(1);
    expect(keys[0]).toStartWith('custom:');
  });

  it('defaults namespace to "llm-cache:"', async () => {
    const generate = createTrackingGenerate();
    const cached = withCache(generate, { store });

    await cached(makeContext());

    const keys = await store.list('llm-cache:');
    expect(keys).toHaveLength(1);
  });

  it('supports the last-message key strategy', async () => {
    const generate = createTrackingGenerate();
    const cached = withCache(generate, { store, keyStrategy: 'last-message' });

    // Two different conversations with the same last user message
    const c1 = new Conversation();
    c1.appendUserMessage('Different history');
    c1.appendUserMessage('Same question');

    const c2 = new Conversation();
    c2.appendUserMessage('Same question');

    await cached({ conversation: c1, step: 1, toolbox: createTestToolbox([]) });
    await cached({ conversation: c2, step: 1, toolbox: createTestToolbox([]) });

    expect(generate.calls).toHaveLength(1);
  });

  it('supports a custom key function', async () => {
    const generate = createTrackingGenerate();
    const cached = withCache(generate, {
      store,
      keyStrategy: () => 'fixed-key',
    });

    await cached(makeContext('Hello'));
    await cached(makeContext('Goodbye'));

    expect(generate.calls).toHaveLength(1);
  });

  it('does not cache when signal is aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    const generate = createTrackingGenerate();
    const cached = withCache(generate, { store });

    await cached({ ...makeContext(), signal: controller.signal });

    const keys = await store.list('llm-cache:');
    expect(keys).toHaveLength(0);
  });

  it('stores entries as JSON-serialized CacheEntry objects', async () => {
    const generate = createTrackingGenerate();
    const cached = withCache(generate, { store });

    await cached(makeContext());

    const keys = await store.list('llm-cache:');
    const raw = await store.get(keys[0]!);
    expect(raw).toBeString();

    const entry = JSON.parse(raw!) as CacheEntry;
    expect(entry.response.content).toBe('response');
    expect(entry.createdAt).toBeNumber();
    expect(entry.ttl).toBe(3600);
    expect(entry.hits).toBe(0);
    expect(entry.keyStrategy).toBe('conversation-hash');
  });

  it('increments hits on cached entries', async () => {
    const generate = createTrackingGenerate();
    const cached = withCache(generate, { store });

    await cached(makeContext());
    await cached(makeContext());
    await cached(makeContext());

    const keys = await store.list('llm-cache:');
    const raw = await store.get(keys[0]!);
    const entry = JSON.parse(raw!) as CacheEntry;
    expect(entry.hits).toBe(2);
  });

  it('deletes corrupt cached entries and regenerates the response', async () => {
    const generate = createTrackingGenerate();
    const cached = withCache(generate, { store });

    await cached(makeContext('corrupt-entry'));

    const [key] = await store.list('llm-cache:');
    await store.set(key!, '{not-valid-json');

    const result = await cached(makeContext('corrupt-entry'));

    expect(result.content).toBe('response');
    expect(generate.calls).toHaveLength(2);
    expect(await store.get(key!)).toContain('"response"');
  });

  it('evicts oldest entries when maxEntries is exceeded', async () => {
    const generate = createTrackingGenerate();
    const cached = withCache(generate, { store, maxEntries: 2 });

    await cached(makeContext('first'));
    await cached(makeContext('second'));
    await cached(makeContext('third'));

    const keys = await store.list('llm-cache:');
    expect(keys).toHaveLength(2);
  });

  it('removes corrupt entries while evicting the oldest cached entry', async () => {
    const generate = createTrackingGenerate();
    const cached = withCache(generate, { store, maxEntries: 1 });

    await store.set(
      'llm-cache:stale',
      JSON.stringify({
        response: {
          content: 'stale',
          toolCalls: [],
          usage: { prompt: 1, completion: 1, total: 2 },
        },
        createdAt: 1,
        ttl: 3600,
        hits: 0,
        keyStrategy: 'conversation-hash',
      } satisfies CacheEntry),
    );
    await store.set('llm-cache:corrupt', '{broken');

    await cached(makeContext('fresh-entry'));

    const keys = await store.list('llm-cache:');
    expect(keys).toHaveLength(1);
    expect(await store.get('llm-cache:stale')).toBeNull();
    expect(await store.get('llm-cache:corrupt')).toBeNull();
  });

  it('defaults TTL to 3600 seconds', async () => {
    const generate = createTrackingGenerate();
    const cached = withCache(generate, { store });

    await cached(makeContext());

    const keys = await store.list('llm-cache:');
    const raw = await store.get(keys[0]!);
    const entry = JSON.parse(raw!) as CacheEntry;
    expect(entry.ttl).toBe(3600);
  });

  it('returns a GenerateFunction that preserves the response shape', async () => {
    const generate = createTrackingGenerate({
      content: 'hello',
      toolCalls: [],
      usage: { prompt: 10, completion: 5, total: 15 },
      metadata: { model: 'test' },
    });
    const cached = withCache(generate, { store });

    const result = await cached(makeContext());

    expect(result.content).toBe('hello');
    expect(result.toolCalls).toEqual([]);
    expect(result.usage).toEqual({ prompt: 10, completion: 5, total: 15 });
    expect(result.metadata).toEqual({ model: 'test' });
  });
});
