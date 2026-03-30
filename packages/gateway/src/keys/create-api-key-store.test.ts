import { beforeEach, describe, expect, it } from 'bun:test';
import type { KeyValueStore } from 'storage';
import { createMemoryKeyValueStore } from 'storage';

import { createApiKeyStore } from './create-api-key-store';
import type { ApiKeyStore } from './types';

let kv: KeyValueStore;
let store: ApiKeyStore;

beforeEach(() => {
  kv = createMemoryKeyValueStore();
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

  it('respects expiresAt', async () => {
    const expires = new Date(Date.now() + 86400000).toISOString();
    const result = await store.create({ name: 'expiring', expiresAt: expires });
    expect(result.key.expiresAt).toBe(expires);
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
    const expires = new Date(Date.now() - 1000).toISOString();
    const { plaintext } = await store.create({ name: 'expired', expiresAt: expires });
    const result = await store.verify(plaintext);
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
