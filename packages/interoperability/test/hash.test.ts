import { describe, expect, test } from 'bun:test';

import { createIncrementalHash, sha256Hex, sha256HexSync } from '../src/hash';

// ── sha256Hex (async, Web Crypto) ──────────────────────────────────

describe('sha256Hex', () => {
  test('returns consistent hex string for same input', async () => {
    const a = await sha256Hex('hello');
    const b = await sha256Hex('hello');
    expect(a).toBe(b);
  });

  test('returns different hex for different inputs', async () => {
    const a = await sha256Hex('hello');
    const b = await sha256Hex('world');
    expect(a).not.toBe(b);
  });

  test('output is 64 hex characters (SHA-256)', async () => {
    const result = await sha256Hex('test');
    expect(result).toMatch(/^[0-9a-f]{64}$/);
  });

  test('handles empty string', async () => {
    const result = await sha256Hex('');
    expect(result).toMatch(/^[0-9a-f]{64}$/);
    // Known SHA-256 of empty string
    expect(result).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  test('handles unicode', async () => {
    const result = await sha256Hex('こんにちは世界');
    expect(result).toMatch(/^[0-9a-f]{64}$/);
  });

  test('handles long strings', async () => {
    const long = 'a'.repeat(100_000);
    const result = await sha256Hex(long);
    expect(result).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ── sha256HexSync (synchronous, Bun/Node) ──────────────────────────

describe('sha256HexSync', () => {
  test('returns consistent hex for same input', () => {
    const a = sha256HexSync('hello');
    const b = sha256HexSync('hello');
    expect(a).toBe(b);
  });

  test('returns identical output to sha256Hex for same input', async () => {
    const inputs = ['hello', '', 'こんにちは世界', 'a'.repeat(1000)];
    for (const input of inputs) {
      const sync = sha256HexSync(input);
      const async_ = await sha256Hex(input);
      expect(sync).toBe(async_);
    }
  });

  test('output is 64 hex characters', () => {
    const result = sha256HexSync('test');
    expect(result).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ── createIncrementalHash ──────────────────────────────────────────

describe('createIncrementalHash', () => {
  test('single update + digest matches sha256HexSync for same input', () => {
    const hash = createIncrementalHash();
    hash.update('hello');
    expect(hash.digest()).toBe(sha256HexSync('hello'));
  });

  test('multiple update calls produce same result as single call with concatenated input', () => {
    const hash = createIncrementalHash();
    hash.update('hello');
    hash.update(' ');
    hash.update('world');
    expect(hash.digest()).toBe(sha256HexSync('hello world'));
  });

  test('separate instances are independent', () => {
    const a = createIncrementalHash();
    const b = createIncrementalHash();
    a.update('hello');
    b.update('world');
    expect(a.digest()).toBe(sha256HexSync('hello'));
    expect(b.digest()).toBe(sha256HexSync('world'));
  });

  test('defaults to sha256 algorithm', () => {
    const hash = createIncrementalHash();
    hash.update('test');
    expect(hash.digest()).toBe(sha256HexSync('test'));
  });
});
