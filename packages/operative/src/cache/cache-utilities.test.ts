import { MemoryStorage, type TextValueStore, textValueStore } from '@lostgradient/weft/storage';
import { beforeEach, describe, expect, it } from 'bun:test';

import { clearCache, invalidateCache } from './cache-utilities';

function createStoreWithoutDeletePrefix(): TextValueStore {
  const store = textValueStore(new MemoryStorage());
  return {
    get: store.get.bind(store),
    set: store.set.bind(store),
    delete: store.delete.bind(store),
    list: store.list.bind(store),
  } as TextValueStore;
}

describe('clearCache', () => {
  let store: TextValueStore;

  beforeEach(() => {
    store = textValueStore(new MemoryStorage());
  });

  it('deletes all keys with the given namespace prefix', async () => {
    await store.set('llm-cache:key1', 'value1');
    await store.set('llm-cache:key2', 'value2');
    await store.set('other:key3', 'value3');

    const count = await clearCache(store, 'llm-cache:');

    expect(count).toBe(2);
    expect(await store.get('llm-cache:key1')).toBeNull();
    expect(await store.get('llm-cache:key2')).toBeNull();
    expect(await store.get('other:key3')).toBe('value3');
  });

  it('defaults namespace to "llm-cache:"', async () => {
    await store.set('llm-cache:key1', 'value1');

    const count = await clearCache(store);

    expect(count).toBe(1);
    expect(await store.get('llm-cache:key1')).toBeNull();
  });

  it('returns 0 when no keys match', async () => {
    const count = await clearCache(store, 'nonexistent:');
    expect(count).toBe(0);
  });

  it('uses deletePrefix when available', async () => {
    await store.set('llm-cache:key1', 'value1');
    await store.set('llm-cache:key2', 'value2');

    // The memory adapter has deletePrefix — the function should use it
    const count = await clearCache(store, 'llm-cache:');
    expect(count).toBe(2);
  });

  it('falls back to listing and deleting keys when deletePrefix is unavailable', async () => {
    const fallbackStore = createStoreWithoutDeletePrefix();

    await fallbackStore.set('llm-cache:key1', 'value1');
    await fallbackStore.set('llm-cache:key2', 'value2');
    await fallbackStore.set('other:key3', 'value3');

    const count = await clearCache(fallbackStore, 'llm-cache:');

    expect(count).toBe(2);
    expect(await fallbackStore.get('llm-cache:key1')).toBeNull();
    expect(await fallbackStore.get('llm-cache:key2')).toBeNull();
    expect(await fallbackStore.get('other:key3')).toBe('value3');
  });
});

describe('invalidateCache', () => {
  let store: TextValueStore;

  beforeEach(() => {
    store = textValueStore(new MemoryStorage());
  });

  it('deletes keys that match the pattern within the namespace', async () => {
    await store.set('llm-cache:abc123', 'value1');
    await store.set('llm-cache:abc456', 'value2');
    await store.set('llm-cache:def789', 'value3');

    const count = await invalidateCache(store, 'llm-cache:', 'abc');

    expect(count).toBe(2);
    expect(await store.get('llm-cache:abc123')).toBeNull();
    expect(await store.get('llm-cache:abc456')).toBeNull();
    expect(await store.get('llm-cache:def789')).toBe('value3');
  });

  it('returns 0 when no keys match the pattern', async () => {
    await store.set('llm-cache:abc123', 'value1');

    const count = await invalidateCache(store, 'llm-cache:', 'xyz');
    expect(count).toBe(0);
  });

  it('handles an empty store', async () => {
    const count = await invalidateCache(store, 'llm-cache:', 'abc');
    expect(count).toBe(0);
  });
});
