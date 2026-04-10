import { beforeEach, describe, expect, it } from 'bun:test';
import { MemoryStorageAdapter } from 'vector-frankl';

import { createMemory } from '../src/create-memory';
import { withNamespaceIsolation } from '../src/namespace-isolation';
import { createMockEmbedder } from '../src/test/index';
import type { Memory } from '../src/types';

const DIMENSION = 64;

function createTestMemory(options?: { namespace?: string; requireNamespace?: boolean }) {
  const storage = new MemoryStorageAdapter();
  const embedder = createMockEmbedder(DIMENSION);
  const memory = createMemory({
    embedder,
    storage,
    dimension: DIMENSION,
    namespace: options?.namespace,
    requireNamespace: options?.requireNamespace,
  });
  return { memory, storage, embedder };
}

describe('withNamespaceIsolation', () => {
  let baseMemory: Memory;

  beforeEach(async () => {
    const test = createTestMemory();
    baseMemory = test.memory;
    await baseMemory.init();
  });

  describe('remember', () => {
    it('forces the configured namespace on all stored entries', async () => {
      const tenantA = withNamespaceIsolation(baseMemory, { namespace: 'tenant-a' });

      // Try to write to a different namespace — should be overridden
      const entry = await tenantA.remember('Secret data', { namespace: 'tenant-b' });

      expect(entry.metadata.namespace).toBe('tenant-a');
    });

    it('ignores namespace in caller metadata', async () => {
      const tenantA = withNamespaceIsolation(baseMemory, { namespace: 'tenant-a' });
      await tenantA.remember('Entry for A');

      // Base memory should see it under tenant-a, not default
      const countDefault = await baseMemory.count('default');
      const countTenantA = await baseMemory.count('tenant-a');
      expect(countDefault).toBe(0);
      expect(countTenantA).toBe(1);
    });
  });

  describe('recall', () => {
    it('scopes recall to the configured namespace', async () => {
      // Store entries in two namespaces via base memory
      await baseMemory.remember('Entry in tenant-a', { namespace: 'tenant-a' });
      await baseMemory.remember('Entry in tenant-b', { namespace: 'tenant-b' });

      const tenantA = withNamespaceIsolation(baseMemory, { namespace: 'tenant-a' });
      const results = await tenantA.recall('Entry');

      expect(results.length).toBeGreaterThan(0);
      for (const result of results) {
        expect(result.metadata.namespace).toBe('tenant-a');
      }
    });

    it('ignores namespace in search options', async () => {
      await baseMemory.remember('Visible to A', { namespace: 'tenant-a' });
      await baseMemory.remember('Not visible to A', { namespace: 'tenant-b' });

      const tenantA = withNamespaceIsolation(baseMemory, { namespace: 'tenant-a' });
      // Try to search tenant-b — should be overridden to tenant-a
      const results = await tenantA.recall('entry', { namespace: 'tenant-b' });

      for (const result of results) {
        expect(result.metadata.namespace).toBe('tenant-a');
      }
    });
  });

  describe('list', () => {
    it('scopes list to the configured namespace and tracks listed ids for forgetting', async () => {
      await baseMemory.remember('Tenant A entry', { namespace: 'tenant-a' });
      await baseMemory.remember('Tenant B entry', { namespace: 'tenant-b' });

      const tenantA = withNamespaceIsolation(baseMemory, { namespace: 'tenant-a' });
      const listed = await tenantA.list();

      expect(listed).toHaveLength(1);
      expect(listed[0]!.metadata.namespace).toBe('tenant-a');

      await tenantA.forget(listed[0]!.id);
      expect(await tenantA.count()).toBe(0);
      expect(await baseMemory.count('tenant-b')).toBe(1);
    });
  });

  describe('forget', () => {
    it('allows forgetting entries that were remembered through the wrapper', async () => {
      const tenantA = withNamespaceIsolation(baseMemory, { namespace: 'tenant-a' });
      const entry = await tenantA.remember('To be forgotten');

      await tenantA.forget(entry.id);

      const count = await tenantA.count();
      expect(count).toBe(0);
    });

    it('allows forgetting entries that were seen via recall', async () => {
      await baseMemory.remember('Recallable entry', { namespace: 'tenant-a' });

      const tenantA = withNamespaceIsolation(baseMemory, { namespace: 'tenant-a' });
      const results = await tenantA.recall('Recallable');
      expect(results.length).toBe(1);

      await tenantA.forget(results[0]!.id);

      const count = await tenantA.count();
      expect(count).toBe(0);
    });

    it('throws when trying to forget an unknown entry (default: throw)', async () => {
      const tenantA = withNamespaceIsolation(baseMemory, { namespace: 'tenant-a' });
      const tenantB = withNamespaceIsolation(baseMemory, { namespace: 'tenant-b' });

      const entryB = await tenantB.remember('Entry for B');

      await expect(tenantA.forget(entryB.id)).rejects.toThrow(/does not belong to namespace/);
    });

    it('silently ignores unknown entries when onUnauthorized is ignore', async () => {
      const tenantA = withNamespaceIsolation(baseMemory, {
        namespace: 'tenant-a',
        onUnauthorized: 'ignore',
      });
      const tenantB = withNamespaceIsolation(baseMemory, { namespace: 'tenant-b' });

      const entryB = await tenantB.remember('Entry for B');

      // Should not throw
      await tenantA.forget(entryB.id);

      // Entry B should still exist
      const countB = await baseMemory.count('tenant-b');
      expect(countB).toBe(1);
    });
  });

  describe('forgetAll', () => {
    it('only clears the configured namespace', async () => {
      const tenantA = withNamespaceIsolation(baseMemory, { namespace: 'tenant-a' });
      const tenantB = withNamespaceIsolation(baseMemory, { namespace: 'tenant-b' });

      await tenantA.remember('Entry A1');
      await tenantA.remember('Entry A2');
      await tenantB.remember('Entry B1');

      await tenantA.forgetAll();

      const countA = await baseMemory.count('tenant-a');
      const countB = await baseMemory.count('tenant-b');
      expect(countA).toBe(0);
      expect(countB).toBe(1);
    });

    it('ignores the namespace argument passed to it', async () => {
      const tenantA = withNamespaceIsolation(baseMemory, { namespace: 'tenant-a' });
      await tenantA.remember('Entry A');
      await baseMemory.remember('Entry B', { namespace: 'tenant-b' });

      // Pass a different namespace — should be ignored
      await tenantA.forgetAll('tenant-b');

      // tenant-a should be cleared, tenant-b untouched
      const countA = await baseMemory.count('tenant-a');
      const countB = await baseMemory.count('tenant-b');
      expect(countA).toBe(0);
      expect(countB).toBe(1);
    });
  });

  describe('count', () => {
    it('only counts entries in the configured namespace', async () => {
      await baseMemory.remember('Entry A1', { namespace: 'tenant-a' });
      await baseMemory.remember('Entry A2', { namespace: 'tenant-a' });
      await baseMemory.remember('Entry B1', { namespace: 'tenant-b' });

      const tenantA = withNamespaceIsolation(baseMemory, { namespace: 'tenant-a' });
      const tenantB = withNamespaceIsolation(baseMemory, { namespace: 'tenant-b' });

      expect(await tenantA.count()).toBe(2);
      expect(await tenantB.count()).toBe(1);
    });

    it('ignores the namespace argument passed to it', async () => {
      await baseMemory.remember('Entry A1', { namespace: 'tenant-a' });
      await baseMemory.remember('Entry A2', { namespace: 'tenant-a' });
      await baseMemory.remember('Entry B', { namespace: 'tenant-b' });

      const tenantA = withNamespaceIsolation(baseMemory, { namespace: 'tenant-a' });

      // Pass tenant-b (which has 1 entry) — should be ignored, returning tenant-a's count (2)
      const count = await tenantA.count('tenant-b');
      expect(count).toBe(2);
    });
  });

  describe('init and close', () => {
    it('passes through to inner memory', async () => {
      const tenantA = withNamespaceIsolation(baseMemory, { namespace: 'tenant-a' });
      // Should not throw
      await tenantA.init();
      await tenantA.close();
    });
  });
});

describe('requireNamespace', () => {
  it('throws when no namespace is provided and requireNamespace is true', async () => {
    const { memory } = createTestMemory({ requireNamespace: true });
    await memory.init();

    await expect(memory.remember('No namespace')).rejects.toThrow(/Namespace is required/);
  });

  it('does not throw when namespace is provided in metadata', async () => {
    const { memory } = createTestMemory({ requireNamespace: true });
    await memory.init();

    const entry = await memory.remember('With namespace', { namespace: 'my-namespace' });
    expect(entry.metadata.namespace).toBe('my-namespace');
  });

  it('does not throw when a default namespace is configured', async () => {
    const { memory } = createTestMemory({
      requireNamespace: true,
      namespace: 'configured-default',
    });
    await memory.init();

    const entry = await memory.remember('With configured default');
    expect(entry.metadata.namespace).toBe('configured-default');
  });

  it('allows remember without namespace when requireNamespace is false', async () => {
    const { memory } = createTestMemory({ requireNamespace: false });
    await memory.init();

    const entry = await memory.remember('No namespace needed');
    expect(entry.metadata.namespace).toBe('default');
  });
});
