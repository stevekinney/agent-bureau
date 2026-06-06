import { MemoryStorage } from '@lostgradient/weft/storage';
import { WEFT_RESERVED_KEY_PREFIXES } from '@lostgradient/weft/storage/interface';
import { beforeEach, describe, expect, it } from 'bun:test';

import {
  createWeftMemoryRecordStorage,
  DEFAULT_MEMORY_KEY_PREFIX,
} from '../src/create-weft-memory-record-storage';
import type { MemoryRecord, MemoryRecordScope, MemoryRecordStorage } from '../src/types';

/**
 * Weft-backend-SPECIFIC behavior. The generic {@link MemoryRecordStorage}
 * contract (put/get/list/count/searchByVector/update/delete/deleteNamespace and
 * the shared delete invariant) is exercised against BOTH backends by the shared
 * harness in `memory-record-storage-contract.test.ts`; this file covers only
 * what is unique to the Weft-backed local backend:
 * - the record key layout sits entirely under the chosen prefix and collides
 *   with no Weft-reserved prefix;
 * - delete physically removes the underlying row (no tombstone);
 * - close() does not dispose storage it does not own.
 */

const SCOPE: MemoryRecordScope = { namespace: 'alpha' };

function makeRecord(id: string, overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  const now = Date.now();
  return {
    id,
    namespace: 'alpha',
    content: `content-${id}`,
    vector: new Float32Array([1, 0, 0]),
    metadata: {},
    createdAt: now,
    updatedAt: now,
    version: 1,
    status: 'active',
    ...overrides,
  };
}

describe('createWeftMemoryRecordStorage (Weft-specific)', () => {
  let underlying: MemoryStorage;
  let storage: MemoryRecordStorage;

  beforeEach(async () => {
    underlying = new MemoryStorage();
    storage = createWeftMemoryRecordStorage(underlying);
    await storage.init();
  });

  describe('key prefix isolation', () => {
    it('does not collide with any WEFT reserved key prefix', () => {
      for (const reserved of WEFT_RESERVED_KEY_PREFIXES) {
        // Neither prefix may be a prefix of the other, in either direction.
        expect(DEFAULT_MEMORY_KEY_PREFIX.startsWith(reserved)).toBe(false);
        expect(reserved.startsWith(DEFAULT_MEMORY_KEY_PREFIX)).toBe(false);
      }
    });

    it('writes every record key under the memory prefix and nowhere else', async () => {
      await storage.put(makeRecord('a', { namespace: 'alpha' }));
      await storage.put(makeRecord('b', { namespace: 'beta', tenantId: 't1' }));

      const keys = [...underlying.snapshot().keys()];
      expect(keys).toHaveLength(2);
      for (const key of keys) {
        expect(key.startsWith(DEFAULT_MEMORY_KEY_PREFIX)).toBe(true);
      }
    });

    it('lands no key under any WEFT reserved prefix', async () => {
      await storage.put(makeRecord('a'));
      await storage.put(makeRecord('b', { tenantId: 't1' }));

      const keys = [...underlying.snapshot().keys()];
      for (const key of keys) {
        for (const reserved of WEFT_RESERVED_KEY_PREFIXES) {
          expect(key.startsWith(reserved)).toBe(false);
        }
      }
    });

    it('honors a custom keyPrefix', async () => {
      const customPrefix = 'app:custom:memory:v1:';
      const custom = createWeftMemoryRecordStorage(underlying, { keyPrefix: customPrefix });
      await custom.init();
      await custom.put(makeRecord('a'));

      const keys = [...underlying.snapshot().keys()];
      expect(keys).toHaveLength(1);
      expect(keys[0]!.startsWith(customPrefix)).toBe(true);
    });

    it('rejects a custom keyPrefix that collides with a reserved Weft prefix', () => {
      // A reserved prefix verbatim, and a prefix that is a parent of one, must
      // both be rejected — either direction risks overwriting engine keys.
      expect(() => createWeftMemoryRecordStorage(underlying, { keyPrefix: 'wf:' })).toThrow(
        /collides with the reserved Weft prefix/,
      );
      expect(() => createWeftMemoryRecordStorage(underlying, { keyPrefix: 'wf:memory:' })).toThrow(
        /collides with the reserved Weft prefix/,
      );
      expect(() => createWeftMemoryRecordStorage(underlying, { keyPrefix: 'w' })).toThrow(
        /collides with the reserved Weft prefix/,
      );
    });

    it('rejects an empty keyPrefix', () => {
      expect(() => createWeftMemoryRecordStorage(underlying, { keyPrefix: '' })).toThrow(
        /keyPrefix must be a non-empty string/,
      );
    });
  });

  describe('namespace validation at the storage boundary', () => {
    it('rejects an empty namespace on a direct storage call', async () => {
      // Direct storage callers bypass createMemory, so the backend itself must
      // enforce the non-empty-namespace contract.
      await expect(storage.get('a', { namespace: '' })).rejects.toThrow(
        /namespace must be a non-empty string/,
      );
      await expect(storage.count({ namespace: '' })).rejects.toThrow(
        /namespace must be a non-empty string/,
      );
    });
  });

  describe('delete is physical (no tombstone)', () => {
    it('removes the underlying row entirely', async () => {
      await storage.put(makeRecord('a'));
      const before = [...underlying.snapshot().keys()];
      expect(before).toHaveLength(1);

      expect(await storage.delete('a', SCOPE)).toBe(true);

      // The row is gone from the underlying storage — not flipped to a
      // status:'deleted' tombstone (that is Cloudflare-only behavior).
      expect([...underlying.snapshot().keys()]).toEqual([]);
    });

    it('removes every underlying row for a namespace', async () => {
      await storage.put(makeRecord('a', { namespace: 'alpha' }));
      await storage.put(makeRecord('b', { namespace: 'alpha' }));
      await storage.put(makeRecord('c', { namespace: 'beta' }));

      const removed = await storage.deleteNamespace({ namespace: 'alpha' });
      expect(removed).toBe(2);

      const keys = [...underlying.snapshot().keys()];
      expect(keys).toHaveLength(1);
    });
  });

  describe('close', () => {
    it('does not dispose shared storage by default', async () => {
      await storage.put(makeRecord('a'));
      await storage.close();

      // The underlying storage is still usable because the backend is a
      // non-owning view by default.
      const survivor = createWeftMemoryRecordStorage(underlying);
      expect(await survivor.get('a', SCOPE)).toBeDefined();
    });

    it('disposes shared storage when configured to own it', async () => {
      const owning = createWeftMemoryRecordStorage(underlying, {
        disposeUnderlyingStorage: true,
      });
      await owning.init();
      await owning.put(makeRecord('a'));
      await owning.close();

      // MemoryStorage.clear() runs on dispose, so the data is gone.
      expect(underlying.size).toBe(0);
    });
  });

  describe('decode validation (durable bytes are untrusted)', () => {
    async function onlyKey(): Promise<string> {
      const found: string[] = [];
      for await (const key of underlying.keys(DEFAULT_MEMORY_KEY_PREFIX)) {
        found.push(key);
      }
      expect(found).toHaveLength(1);
      return found[0]!;
    }

    it('throws when a stored record is not valid JSON', async () => {
      await storage.put(makeRecord('a'));
      const key = await onlyKey();
      await underlying.put(key, new TextEncoder().encode('{ not json'));

      await expect(storage.get('a', SCOPE)).rejects.toThrow();
    });

    it('throws when a stored record is structurally invalid (wrong status)', async () => {
      await storage.put(makeRecord('a'));
      const key = await onlyKey();
      await underlying.put(
        key,
        new TextEncoder().encode(JSON.stringify({ id: 'a', status: 'bogus' })),
      );

      await expect(storage.get('a', SCOPE)).rejects.toThrow();
    });

    it('throws when a stored vector entry is non-finite', async () => {
      await storage.put(makeRecord('a'));
      const key = await onlyKey();
      const now = Date.now();
      await underlying.put(
        key,
        new TextEncoder().encode(
          JSON.stringify({
            id: 'a',
            namespace: 'alpha',
            content: 'x',
            // JSON has no Infinity literal, so a corrupt finite-violating value
            // arrives as null — which the finite-number schema must reject.
            vector: [1, null, 3],
            metadata: {},
            createdAt: now,
            updatedAt: now,
            version: 1,
            status: 'active',
          }),
        ),
      );

      await expect(storage.get('a', SCOPE)).rejects.toThrow();
    });
  });
});
