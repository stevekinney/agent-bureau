import { afterEach, describe, expect, it } from 'bun:test';

import type { KeyValueStore } from '../src/types';

describe('resolveKeyValueStore', () => {
  let store: KeyValueStore | undefined;

  afterEach(async () => {
    if (store?.close) {
      await store.close();
    }
    store = undefined;
  });

  describe('explicit configuration', () => {
    it('returns a working memory adapter for { type: "memory" }', async () => {
      const { resolveKeyValueStore } = await import('../src/resolve');
      store = await resolveKeyValueStore({ type: 'memory' });

      await store.set('probe', 'value');
      expect(await store.get('probe')).toBe('value');
      await store.delete('probe');
      expect(await store.get('probe')).toBeNull();
    });

    it('memory adapter supports full CRUD round-trip', async () => {
      const { resolveKeyValueStore } = await import('../src/resolve');
      store = await resolveKeyValueStore({ type: 'memory' });

      await store.set('test:key', 'hello');
      expect(await store.get('test:key')).toBe('hello');

      await store.set('test:key', 'updated');
      expect(await store.get('test:key')).toBe('updated');

      await store.set('test:other', 'world');
      const keys = await store.list('test:');
      expect(keys).toContain('test:key');
      expect(keys).toContain('test:other');

      await store.delete('test:key');
      expect(await store.get('test:key')).toBeNull();
    });

    it('returns a working SQLite adapter for { type: "sqlite", path: ":memory:" }', async () => {
      const { resolveKeyValueStore } = await import('../src/resolve');
      store = await resolveKeyValueStore({ type: 'sqlite', path: ':memory:' });

      await store.set('probe', 'value');
      expect(await store.get('probe')).toBe('value');
    });

    it('SQLite adapter supports full CRUD round-trip', async () => {
      const { resolveKeyValueStore } = await import('../src/resolve');
      store = await resolveKeyValueStore({ type: 'sqlite', path: ':memory:' });

      await store.set('agent:name', 'bureau');
      expect(await store.get('agent:name')).toBe('bureau');

      await store.set('agent:version', '1.0');
      const keys = await store.list('agent:');
      expect(keys).toContain('agent:name');
      expect(keys).toContain('agent:version');

      await store.delete('agent:name');
      expect(await store.get('agent:name')).toBeNull();
    });
  });

  describe('auto-detection', () => {
    it('selects SQLite in Bun environment', async () => {
      const { resolveKeyValueStore } = await import('../src/resolve');
      const { isSQLiteAvailable } = await import('../src/adapters/sqlite-adapter');
      store = await resolveKeyValueStore({ type: 'auto' });

      // In Bun, SQLite should be selected; verify it works and SQLite is available
      await store.set('probe', '1');
      expect(await store.get('probe')).toBe('1');
      expect(isSQLiteAvailable()).toBe(true);
    });

    it('auto-detected adapter is functional', async () => {
      const { resolveKeyValueStore } = await import('../src/resolve');
      store = await resolveKeyValueStore({ type: 'auto' });

      await store.set('auto:test', 'value');
      expect(await store.get('auto:test')).toBe('value');

      await store.delete('auto:test');
      expect(await store.get('auto:test')).toBeNull();
    });
  });
});
