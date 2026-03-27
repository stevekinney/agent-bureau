import { existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { createSQLiteKeyValueStore, isSQLiteAvailable } from '../../src/adapters/sqlite-adapter';
import type { KeyValueStore } from '../../src/types';

describe('createSQLiteKeyValueStore', () => {
  let store: KeyValueStore;
  let databasePath: string;

  beforeEach(async () => {
    databasePath = join(
      tmpdir(),
      `test-kv-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    );
    store = await createSQLiteKeyValueStore({ filename: databasePath });
  });

  afterEach(async () => {
    try {
      await store.close!();
    } catch {
      // Already closed in some tests
    }
    for (const suffix of ['', '-wal', '-shm']) {
      const filePath = `${databasePath}${suffix}`;
      if (existsSync(filePath)) {
        unlinkSync(filePath);
      }
    }
  });

  describe('basic CRUD', () => {
    it('set and get a value', async () => {
      await store.set('key', 'value');
      expect(await store.get('key')).toBe('value');
    });

    it('get returns null for missing key', async () => {
      expect(await store.get('missing')).toBeNull();
    });

    it('set overwrites existing value', async () => {
      await store.set('key', 'first');
      await store.set('key', 'second');
      expect(await store.get('key')).toBe('second');
    });

    it('delete removes a key', async () => {
      await store.set('key', 'value');
      await store.delete('key');
      expect(await store.get('key')).toBeNull();
    });

    it('delete on non-existent key is a no-op', async () => {
      await expect(store.delete('nonexistent')).resolves.toBeUndefined();
    });

    it('handles empty string values', async () => {
      await store.set('key', '');
      expect(await store.get('key')).toBe('');
    });

    it('handles keys with special characters', async () => {
      const colonKey = 'identity:soul:orchestrator';
      const hyphenKey = 'my-agent-key';

      await store.set(colonKey, 'colon-data');
      await store.set(hyphenKey, 'hyphen-data');

      expect(await store.get(colonKey)).toBe('colon-data');
      expect(await store.get(hyphenKey)).toBe('hyphen-data');
    });
  });

  describe('list', () => {
    it('returns matching keys with prefix', async () => {
      await store.set('skill:a:metadata', '{}');
      await store.set('skill:b:metadata', '{}');
      await store.set('identity:soul', '{}');

      const keys = await store.list('skill:');
      expect(keys).toEqual(['skill:a:metadata', 'skill:b:metadata']);
    });

    it('returns empty array when no keys match', async () => {
      await store.set('key', 'value');
      expect(await store.list('nonexistent:')).toEqual([]);
    });

    it('returns all keys with empty prefix', async () => {
      await store.set('b', 'v');
      await store.set('a', 'v');
      const keys = await store.list('');
      expect(keys).toEqual(['a', 'b']);
    });

    it('returns keys in sorted order', async () => {
      await store.set('c', 'v');
      await store.set('a', 'v');
      await store.set('b', 'v');
      expect(await store.list('')).toEqual(['a', 'b', 'c']);
    });

    it('escapes SQL wildcard % in prefix', async () => {
      await store.set('100%:done', 'v');
      await store.set('100:other', 'v');

      const keys = await store.list('100%');
      expect(keys).toEqual(['100%:done']);
    });

    it('escapes SQL wildcard _ in prefix', async () => {
      await store.set('a_b:one', 'v');
      await store.set('axb:two', 'v');

      const keys = await store.list('a_b');
      expect(keys).toEqual(['a_b:one']);
    });
  });

  describe('has', () => {
    it('returns true for existing keys', async () => {
      await store.set('key', 'value');
      expect(await store.has!('key')).toBe(true);
    });

    it('returns false for missing keys', async () => {
      expect(await store.has!('missing')).toBe(false);
    });
  });

  describe('deletePrefix', () => {
    it('removes all matching keys and returns count', async () => {
      await store.set('skill:a', 'v');
      await store.set('skill:b', 'v');
      await store.set('identity:x', 'v');

      const count = await store.deletePrefix!('skill:');
      expect(count).toBe(2);
      expect(await store.get('skill:a')).toBeNull();
      expect(await store.get('skill:b')).toBeNull();
      expect(await store.get('identity:x')).toBe('v');
    });

    it('returns 0 when no keys match', async () => {
      expect(await store.deletePrefix!('nonexistent:')).toBe(0);
    });

    it('escapes SQL wildcards in prefix', async () => {
      await store.set('100%:done', 'v');
      await store.set('100:other', 'v');

      const count = await store.deletePrefix!('100%');
      expect(count).toBe(1);
      expect(await store.get('100%:done')).toBeNull();
      expect(await store.get('100:other')).toBe('v');
    });
  });

  describe('WAL mode', () => {
    it('enables WAL journal mode', async () => {
      // Access the database directly to verify WAL mode
      const moduleName = 'bun:sqlite';
      const { Database } = (await import(moduleName)) as {
        Database: new (filename: string) => {
          prepare(sql: string): { get(): Record<string, unknown> };
          close(): void;
        };
      };
      const database = new Database(databasePath);
      const result = database.prepare('PRAGMA journal_mode').get();
      expect(result).toEqual({ journal_mode: 'wal' });
      database.close();
    });
  });

  describe('close', () => {
    it('closes the connection and subsequent operations throw', async () => {
      await store.close!();
      expect(() => store.set('key', 'value')).toThrow();
    });
  });

  describe('namespace support', () => {
    it('keys are transparently prefixed', async () => {
      const namespaced = await createSQLiteKeyValueStore({
        filename: databasePath,
        namespace: 'test',
      });

      await namespaced.set('key', 'value');
      expect(await namespaced.get('key')).toBe('value');

      // The underlying store should have the prefixed key
      expect(await store.get('test:key')).toBe('value');

      await namespaced.close!();
    });

    it('two namespaces on the same file are isolated', async () => {
      const storeA = await createSQLiteKeyValueStore({
        filename: databasePath,
        namespace: 'a',
      });
      const storeB = await createSQLiteKeyValueStore({
        filename: databasePath,
        namespace: 'b',
      });

      await storeA.set('key', 'from-a');
      await storeB.set('key', 'from-b');

      expect(await storeA.get('key')).toBe('from-a');
      expect(await storeB.get('key')).toBe('from-b');

      await storeA.close!();
      await storeB.close!();
    });
  });

  describe('isSQLiteAvailable', () => {
    it('returns true when running in Bun', () => {
      expect(isSQLiteAvailable()).toBe(true);
    });
  });
});
