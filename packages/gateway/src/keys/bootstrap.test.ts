import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { createMemoryKeyValueStore } from 'storage';

import { bootstrapApiKey } from './bootstrap';
import { createApiKeyStore } from './create-api-key-store';
import type { ApiKeyStore } from './types';

let store: ApiKeyStore;

beforeEach(() => {
  const kv = createMemoryKeyValueStore();
  store = createApiKeyStore(kv);
});

describe('bootstrapApiKey', () => {
  it('creates an admin key when store is empty', async () => {
    const consoleSpy = mock(() => {});
    const originalLog = console.log;
    console.log = consoleSpy;

    try {
      await bootstrapApiKey(store);

      const keys = await store.list();
      expect(keys).toHaveLength(1);
      expect(keys[0]!.name).toBe('bootstrap-admin');
      expect(keys[0]!.scopes).toEqual([]);
      expect(keys[0]!.active).toBe(true);
      expect(keys[0]!.expiresAt).toBeUndefined();

      expect(consoleSpy).toHaveBeenCalledTimes(1);
      const callArgs = consoleSpy.mock.calls[0] as unknown[];
      const logMessage = String(callArgs[0]);
      expect(logMessage).toContain('[gateway] Bootstrap API key created:');
      expect(logMessage).toContain('ab_live_');
    } finally {
      console.log = originalLog;
    }
  });

  it('does nothing when keys already exist', async () => {
    await store.create({ name: 'existing-key' });

    const consoleSpy = mock(() => {});
    const originalLog = console.log;
    console.log = consoleSpy;

    try {
      await bootstrapApiKey(store);

      const keys = await store.list();
      expect(keys).toHaveLength(1);
      expect(keys[0]!.name).toBe('existing-key');

      expect(consoleSpy).not.toHaveBeenCalled();
    } finally {
      console.log = originalLog;
    }
  });
});
