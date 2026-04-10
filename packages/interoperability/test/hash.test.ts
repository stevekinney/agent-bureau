import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';

import { createIncrementalHash, sha256Hex, sha256HexSync } from '../src/hash';

type HashRuntimeOverride = {
  Bun?: { CryptoHasher: typeof Bun.CryptoHasher } | undefined;
  require?: ((specifier: string) => unknown) | undefined;
};

const runtimeOverrideSymbol = Symbol.for('agent-bureau.interoperability.hash.runtime');

async function withRuntimeOverride<T>(
  runtimeOverride: HashRuntimeOverride,
  callback: () => T | Promise<T>,
): Promise<T> {
  const globalRecord = globalThis as Record<PropertyKey, unknown>;
  const hadExistingOverride = runtimeOverrideSymbol in globalRecord;
  const previousOverride = globalRecord[runtimeOverrideSymbol];

  globalRecord[runtimeOverrideSymbol] = runtimeOverride;

  try {
    return await callback();
  } finally {
    if (hadExistingOverride) {
      globalRecord[runtimeOverrideSymbol] = previousOverride;
    } else {
      delete globalRecord[runtimeOverrideSymbol];
    }
  }
}

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

  test('falls back to node crypto when the Bun runtime is unavailable', async () => {
    await withRuntimeOverride(
      {
        Bun: undefined,
        require: (specifier) => {
          expect(specifier).toBe('node:crypto');
          return { createHash };
        },
      },
      () => {
        expect(sha256HexSync('hello')).toBe(createHash('sha256').update('hello').digest('hex'));
      },
    );
  });

  test('uses the default require fallback when no override is provided', async () => {
    await withRuntimeOverride(
      {
        Bun: undefined,
      },
      () => {
        expect(sha256HexSync('fallback')).toBe(
          createHash('sha256').update('fallback').digest('hex'),
        );
      },
    );
  });

  test('throws a helpful error when no synchronous runtime is available', async () => {
    await withRuntimeOverride(
      {
        Bun: undefined,
        require: () => {
          throw new Error('runtime unavailable');
        },
      },
      () => {
        expect(() => sha256HexSync('hello')).toThrow(
          'sha256HexSync is not available in this environment. Use the async sha256Hex instead, which works everywhere via Web Crypto.',
        );
      },
    );
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

  test('falls back to node crypto when the Bun runtime is unavailable', async () => {
    await withRuntimeOverride(
      {
        Bun: undefined,
        require: (specifier) => {
          expect(specifier).toBe('node:crypto');
          return { createHash };
        },
      },
      () => {
        const hash = createIncrementalHash('sha256');
        hash.update('hello');
        hash.update(' world');
        expect(hash.digest()).toBe(createHash('sha256').update('hello world').digest('hex'));
      },
    );
  });

  test('uses the default require fallback when no override is provided', async () => {
    await withRuntimeOverride(
      {
        Bun: undefined,
      },
      () => {
        const hash = createIncrementalHash();
        hash.update('fallback');
        expect(hash.digest()).toBe(createHash('sha256').update('fallback').digest('hex'));
      },
    );
  });

  test('throws a helpful error when no synchronous streaming runtime is available', async () => {
    await withRuntimeOverride(
      {
        Bun: undefined,
        require: () => {
          throw new Error('runtime unavailable');
        },
      },
      () => {
        expect(() => createIncrementalHash()).toThrow(
          'createIncrementalHash is not available in this environment. Use the async sha256Hex instead, which works everywhere via Web Crypto.',
        );
      },
    );
  });
});
