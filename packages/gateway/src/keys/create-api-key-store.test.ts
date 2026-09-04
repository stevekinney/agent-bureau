import { MemoryStorage, type TextValueStore, textValueStore } from '@lostgradient/weft/storage';
import { beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { createManualRuntimeServices } from 'lifecycle';

import { createApiKeyStore } from './create-api-key-store';
import type { ApiKeyStore } from './types';

let kv: TextValueStore;
let store: ApiKeyStore;

beforeEach(() => {
  kv = textValueStore(new MemoryStorage());
  store = createApiKeyStore(kv);
});

describe('create', () => {
  it('returns a key with a plaintext token', async () => {
    const result = await store.create({ name: 'test-key' });
    expect(result.plaintext).toStartWith('ab_live_');
    expect(result.key.name).toBe('test-key');
    expect(result.key.active).toBe(true);
    expect(result.key.scopes).toEqual([]);
    expect(result.key.createdAt).toBeString();
    expect(result.key.id).toBeString();
  });

  it('stores the key hash, not the plaintext', async () => {
    const result = await store.create({ name: 'test-key' });
    const raw = await kv.get(`api-key:${result.key.id}`);
    expect(raw).not.toBeNull();
    const stored = JSON.parse(raw!);
    expect(stored.keyHash).not.toBe(result.plaintext);
    expect(stored.keyHash).toBeString();
  });

  it('respects custom scopes', async () => {
    const result = await store.create({ name: 'scoped', scopes: ['runs:read', 'runs:write'] });
    expect(result.key.scopes).toEqual(['runs:read', 'runs:write']);
  });

  it('rejects blank scope entries instead of creating an admin key', async () => {
    let rejection: unknown;
    try {
      await store.create({ name: 'blank-scoped', scopes: ['   '] });
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toBe('API key scope entries must be non-blank strings');
  });

  it('rejects a non-array scopes value instead of silently coercing it', async () => {
    let rejection: unknown;
    try {
      await store.create({ name: 'bad-scopes', scopes: 'runs:read' as unknown as string[] });
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toBe('API key scopes must be an array of strings');
  });

  it('rejects a non-string scope entry instead of creating an admin key', async () => {
    let rejection: unknown;
    try {
      await store.create({ name: 'non-string-scoped', scopes: [42 as unknown as string] });
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toBe('API key scope entries must be non-blank strings');
  });

  it('rejects delimiter-bearing scope entries instead of splitting them downstream', async () => {
    let rejection: unknown;
    try {
      await store.create({ name: 'delimiter-scoped', scopes: ['runs:read,runs:write'] });
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toBe('API key scope entries must not contain ","');
    expect(await store.list()).toEqual([]);
  });

  it('rejects scope entries that cannot be emitted as HTTP header values', async () => {
    for (const scope of ['line\nfeed', 'carriage\rreturn', 'null\u0000', 'non-byte\u0100']) {
      let rejection: unknown;
      try {
        await store.create({ name: 'invalid-header-scope', scopes: [scope] });
      } catch (error) {
        rejection = error;
      }
      expect(rejection).toBeInstanceOf(Error);
      expect((rejection as Error).message).toBe(
        'API key scope entries must be valid HTTP header values',
      );
    }
    expect(await store.list()).toEqual([]);
    expect(() => new Headers({ 'x-scope': 'valid\tvalue' })).not.toThrow();
    expect(() => new Headers({ 'x-scope': 'valid\u00ff' })).not.toThrow();
  });

  it('respects expiresAt', async () => {
    const runtime = createManualRuntimeServices({ origin: '2030-01-01T00:00:00.000Z' });
    const clockedStore = createApiKeyStore(kv, runtime.clock);
    const expires = new Date(runtime.clock.now() + 86400000).toISOString();
    const result = await clockedStore.create({ name: 'expiring', expiresAt: expires });
    expect(result.key.expiresAt).toBe(expires);
  });
});

describe('create id collisions and corrupted records', () => {
  // No blanket `afterEach` spy-restore here (copilot review on #522): only
  // the one test below actually installs a `crypto.getRandomValues` spy,
  // and it restores its own `randomSpy` handle directly at the end. A
  // shared `afterEach` calling `spyOn(...).mockRestore()` unconditionally
  // would install a NEW spy (patching the global) for the other three tests
  // in this block purely to immediately restore it — unnecessary global
  // patching those tests never asked for.
  it('throws on a key ID collision instead of silently overwriting the existing key', async () => {
    const fixedBytes = new Uint8Array(32).fill(7);
    const randomSpy = spyOn(crypto, 'getRandomValues').mockImplementation(
      (array: ArrayBufferView | null) => {
        const view = array as Uint8Array;
        view.set(fixedBytes.subarray(0, view.length));
        return array;
      },
    );

    await store.create({ name: 'first' });

    let rejection: unknown;
    try {
      await store.create({ name: 'second' });
    } catch (error) {
      rejection = error;
    }

    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toMatch(/API key ID collision detected/);
    randomSpy.mockRestore();
  });

  it('skips a record with unparseable JSON when listing keys', async () => {
    await store.create({ name: 'valid-key' });
    await kv.set('api-key:corrupted', 'not valid json');
    const keys = await store.list();
    expect(keys.map((key) => key.name)).toEqual(['valid-key']);
  });

  it('skips a record that is valid JSON but missing the required shape when listing keys', async () => {
    await store.create({ name: 'valid-key-2' });
    await kv.set('api-key:malshaped', JSON.stringify({ foo: 'bar' }));
    const keys = await store.list();
    expect(keys.map((key) => key.name)).toEqual(['valid-key-2']);
  });

  it('throws when rotating a key whose stored record is corrupted', async () => {
    await kv.set('api-key:corrupted-rotate', '{"id":"corrupted-rotate"}');
    let rejection: unknown;
    try {
      await store.rotate('corrupted-rotate');
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toBe('API key data corrupted: corrupted-rotate');
  });
});

describe('verify', () => {
  it('returns the key for a valid token', async () => {
    const { plaintext, key } = await store.create({ name: 'verify-me' });
    const result = await store.verify(plaintext);
    expect(result).not.toBeNull();
    expect(result!.id).toBe(key.id);
    expect(result!.name).toBe('verify-me');
  });

  it('updates lastUsedAt on successful verification', async () => {
    const { plaintext, key } = await store.create({ name: 'used-key' });
    expect(key.lastUsedAt).toBeUndefined();

    const verified = await store.verify(plaintext);
    expect(verified!.lastUsedAt).toBeString();
  });

  it('returns null for an unknown token', async () => {
    const result = await store.verify(
      'ab_live_0000000000000000000000000000000000000000000000000000000000000000',
    );
    expect(result).toBeNull();
  });

  it('returns null for an expired key', async () => {
    const runtime = createManualRuntimeServices({ origin: '2030-01-01T00:00:00.000Z' });
    const clockedStore = createApiKeyStore(kv, runtime.clock);
    const expires = new Date(runtime.clock.now() - 1000).toISOString();
    const { plaintext } = await clockedStore.create({ name: 'expired', expiresAt: expires });
    const result = await clockedStore.verify(plaintext);
    expect(result).toBeNull();
  });

  it('returns null for a revoked key', async () => {
    const { plaintext, key } = await store.create({ name: 'revoked' });
    await store.revoke(key.id);
    const result = await store.verify(plaintext);
    expect(result).toBeNull();
  });
});

describe('revoke', () => {
  it('marks a key as inactive', async () => {
    const { key } = await store.create({ name: 'to-revoke' });
    await store.revoke(key.id);

    const keys = await store.list();
    const revoked = keys.find((k) => k.id === key.id);
    expect(revoked).toBeDefined();
    expect(revoked!.active).toBe(false);
  });
});

describe('list', () => {
  it('returns all keys without hashes', async () => {
    await store.create({ name: 'key-a' });
    await store.create({ name: 'key-b' });

    const keys = await store.list();
    expect(keys).toHaveLength(2);

    for (const key of keys) {
      expect(key.keyHash).toBe('');
    }
  });

  it('returns empty array when no keys exist', async () => {
    const keys = await store.list();
    expect(keys).toEqual([]);
  });
});

describe('rotate', () => {
  it('revokes the old key and creates a new one', async () => {
    const original = await store.create({ name: 'rotate-me', scopes: ['runs:read'] });
    const rotated = await store.rotate(original.key.id);

    expect(rotated.key.name).toBe('rotate-me');
    expect(rotated.key.scopes).toEqual(['runs:read']);
    expect(rotated.key.id).not.toBe(original.key.id);
    expect(rotated.plaintext).not.toBe(original.plaintext);

    // Old key should be revoked
    const oldVerify = await store.verify(original.plaintext);
    expect(oldVerify).toBeNull();

    // New key should work
    const newVerify = await store.verify(rotated.plaintext);
    expect(newVerify).not.toBeNull();
    expect(newVerify!.id).toBe(rotated.key.id);
  });

  it('throws when rotating a non-existent key', async () => {
    let threw = false;
    try {
      await store.rotate('nonexistent');
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});
