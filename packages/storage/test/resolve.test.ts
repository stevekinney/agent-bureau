import { afterEach, describe, expect, it, mock } from 'bun:test';

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

      expect(store).toBeDefined();
      expect(typeof store.get).toBe('function');
      expect(typeof store.set).toBe('function');
      expect(typeof store.delete).toBe('function');
      expect(typeof store.list).toBe('function');
    });

    it('memory adapter supports full CRUD round-trip', async () => {
      const { resolveKeyValueStore } = await import('../src/resolve');
      store = await resolveKeyValueStore({ type: 'memory' });

      // Set and get
      await store.set('test:key', 'hello');
      expect(await store.get('test:key')).toBe('hello');

      // Overwrite
      await store.set('test:key', 'updated');
      expect(await store.get('test:key')).toBe('updated');

      // List
      await store.set('test:other', 'world');
      const keys = await store.list('test:');
      expect(keys).toContain('test:key');
      expect(keys).toContain('test:other');

      // Delete
      await store.delete('test:key');
      expect(await store.get('test:key')).toBeNull();
    });

    it('returns a working SQLite adapter for { type: "sqlite", path: ":memory:" }', async () => {
      const { resolveKeyValueStore } = await import('../src/resolve');
      store = await resolveKeyValueStore({ type: 'sqlite', path: ':memory:' });

      expect(store).toBeDefined();
      expect(typeof store.get).toBe('function');
      expect(typeof store.set).toBe('function');
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
      // globalThis.Bun is defined in the Bun runtime, so isSQLiteAvailable
      // should return true and auto should resolve to SQLite.
      const consoleSpy = mock(() => {});
      const originalLog = console.log;
      console.log = consoleSpy;

      try {
        const { resolveKeyValueStore } = await import('../src/resolve');
        store = await resolveKeyValueStore({ type: 'auto' });

        // Verify it picked SQLite by checking the log message.
        const logCalls = consoleSpy.mock.calls;
        const sqliteLog = logCalls.find(
          (call) => typeof call[0] === 'string' && call[0].includes('sqlite'),
        );
        expect(sqliteLog).toBeDefined();
      } finally {
        console.log = originalLog;
      }
    });

    it('auto-detected adapter is functional', async () => {
      const { resolveKeyValueStore } = await import('../src/resolve');
      store = await resolveKeyValueStore({ type: 'auto' });

      // Regardless of which adapter was selected, it should work.
      await store.set('auto:test', 'value');
      expect(await store.get('auto:test')).toBe('value');

      await store.delete('auto:test');
      expect(await store.get('auto:test')).toBeNull();
    });
  });

  describe('logging', () => {
    it('logs the resolved adapter type', async () => {
      const consoleSpy = mock(() => {});
      const originalLog = console.log;
      console.log = consoleSpy;

      try {
        const { resolveKeyValueStore } = await import('../src/resolve');
        await resolveKeyValueStore({ type: 'memory' });

        const logCalls = consoleSpy.mock.calls;
        const storageLog = logCalls.find(
          (call) => typeof call[0] === 'string' && call[0].includes('[storage]'),
        );
        expect(storageLog).toBeDefined();
      } finally {
        console.log = originalLog;
      }
    });
  });
});
