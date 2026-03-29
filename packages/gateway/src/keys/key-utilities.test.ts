import { describe, expect, it } from 'bun:test';

import { extractKeyId, generateApiKey, hashApiKey, verifyApiKey } from './key-utilities';

describe('generateApiKey', () => {
  it('returns a key with the ab_live_ prefix', () => {
    const key = generateApiKey();
    expect(key.startsWith('ab_live_')).toBe(true);
  });

  it('has 32 hex characters after the prefix', () => {
    const key = generateApiKey();
    const hex = key.slice('ab_live_'.length);
    expect(hex).toHaveLength(64);
    expect(/^[0-9a-f]{64}$/.test(hex)).toBe(true);
  });

  it('generates unique keys', () => {
    const keys = new Set(Array.from({ length: 20 }, () => generateApiKey()));
    expect(keys.size).toBe(20);
  });
});

describe('hashApiKey', () => {
  it('returns a hex string', async () => {
    const hash = await hashApiKey('ab_live_deadbeef');
    expect(/^[0-9a-f]+$/.test(hash)).toBe(true);
  });

  it('produces the same hash for the same input', async () => {
    const key = generateApiKey();
    const hash1 = await hashApiKey(key);
    const hash2 = await hashApiKey(key);
    expect(hash1).toBe(hash2);
  });

  it('produces different hashes for different inputs', async () => {
    const hash1 = await hashApiKey('ab_live_aaa');
    const hash2 = await hashApiKey('ab_live_bbb');
    expect(hash1).not.toBe(hash2);
  });
});

describe('verifyApiKey', () => {
  it('returns true for matching key and hash', async () => {
    const key = generateApiKey();
    const hash = await hashApiKey(key);
    const result = await verifyApiKey(key, hash);
    expect(result).toBe(true);
  });

  it('returns false for non-matching key and hash', async () => {
    const hash = await hashApiKey('ab_live_something');
    const result = await verifyApiKey('ab_live_other', hash);
    expect(result).toBe(false);
  });
});

describe('extractKeyId', () => {
  it('extracts the first 8 hex chars after the prefix', () => {
    const key = 'ab_live_deadbeef1234567890abcdef1234567890abcdef1234567890abcdef12';
    expect(extractKeyId(key)).toBe('deadbeef');
  });

  it('returns a consistent id for the same key', () => {
    const key = generateApiKey();
    expect(extractKeyId(key)).toBe(extractKeyId(key));
  });

  it('returns an 8-character string', () => {
    const key = generateApiKey();
    expect(extractKeyId(key)).toHaveLength(8);
  });
});
