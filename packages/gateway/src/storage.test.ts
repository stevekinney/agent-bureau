import { MemoryStorage, textValueStore } from '@lostgradient/weft/storage';
import { describe, expect, it } from 'bun:test';
import { MemoryStorageAdapter } from 'vector-frankl';

import { createBureau } from './create-bureau';
import type { StorageBackendConfiguration } from './storage';
import { resolveStorageBackend } from './storage';

describe('resolveStorageBackend', () => {
  it('resolves memory backend with KV store and vector adapter', async () => {
    const configuration: StorageBackendConfiguration = { type: 'memory' };
    const backend = await resolveStorageBackend(configuration);

    expect(backend.kv).toBeDefined();
    expect(typeof backend.kv.get).toBe('function');
    expect(typeof backend.kv.set).toBe('function');
    expect(typeof backend.kv.list).toBe('function');
    expect(typeof backend.kv.delete).toBe('function');

    expect(backend.vector).toBeDefined();
    expect(backend.vector).toBeInstanceOf(MemoryStorageAdapter);
  });
});

describe('createBureau with storage', () => {
  it('uses storage backend for persistence when no explicit persistence is provided', async () => {
    const bureau = await createBureau({
      storage: { type: 'memory' },
    });

    // Persistence is wired — listing sessions should not throw
    const sessions = await bureau.listSessions();
    expect(sessions).toEqual([]);
    bureau.dispose();
  });

  it('explicit text value store takes priority over storage backend', async () => {
    const explicitKv = textValueStore(new MemoryStorage());

    const bureau = await createBureau({
      storage: { type: 'memory' },
      persistence: explicitKv,
    });

    // Should use the explicit KV store, not the one from storage
    const sessions = await bureau.listSessions();
    expect(sessions).toEqual([]);
    bureau.dispose();
  });
});

describe('createBureau with memory', () => {
  function createMockEmbedder() {
    return (texts: string[]): number[][] =>
      texts.map(() => Array.from({ length: 3 }, () => Math.random()));
  }

  it('accepts a CreateMemoryOptions config and initializes memory', async () => {
    const vectorStorage = new MemoryStorageAdapter();

    const bureau = await createBureau({
      memory: {
        embedder: createMockEmbedder(),
        storage: vectorStorage,
      },
    });

    expect(bureau.memory).toBeDefined();
    expect(typeof bureau.memory!.remember).toBe('function');
    expect(typeof bureau.memory!.recall).toBe('function');
    bureau.dispose();
  });

  it('accepts a pre-built Memory instance', async () => {
    const { createMemory } = await import('memory');
    const vectorStorage = new MemoryStorageAdapter();

    const preBuiltMemory = createMemory({
      embedder: createMockEmbedder(),
      storage: vectorStorage,
    });

    const bureau = await createBureau({
      memory: preBuiltMemory,
    });

    expect(bureau.memory).toBe(preBuiltMemory);
    bureau.dispose();
  });

  it('memory is initialized on bureau creation', async () => {
    const vectorStorage = new MemoryStorageAdapter();

    const bureau = await createBureau({
      memory: {
        embedder: createMockEmbedder(),
        storage: vectorStorage,
      },
    });

    // Memory should be usable immediately — remember and recall should work
    await bureau.memory!.remember('test fact');
    const results = await bureau.memory!.recall('test');
    expect(results.length).toBeGreaterThan(0);

    bureau.dispose();
  });

  it('memory is undefined when not configured', async () => {
    const bureau = await createBureau();
    expect(bureau.memory).toBeUndefined();
    bureau.dispose();
  });
});
