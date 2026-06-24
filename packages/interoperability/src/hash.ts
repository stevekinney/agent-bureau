/**
 * Cross-platform cryptographic hashing utilities.
 *
 * - `sha256Hex` uses the Web Crypto API and works in all environments (browser, Node, Bun, Deno).
 * - `sha256HexSync` is synchronous and works in Node.js and Bun (throws in browsers).
 * - `hmacSha256HexSync` signs text with HMAC-SHA-256 in Node.js and Bun.
 * - `timingSafeEqualHex` compares hex digests without leaking the first differing byte.
 * - `createIncrementalHash` returns a streaming hasher for accumulating data across multiple `.update()` calls.
 */

/** Interface for an incremental (streaming) hash that accumulates data via `.update()`. */
export type IncrementalHash = {
  /** Feed more data into the hash. */
  update(data: string): void;
  /** Finalize and return the hex digest. */
  digest(): string;
};

type HashRuntimeOverride = {
  Bun?: Pick<typeof Bun, 'CryptoHasher'> | undefined;
  require?: ((specifier: string) => unknown) | undefined;
};

const runtimeOverrideSymbol = Symbol.for('agent-bureau.interoperability.hash.runtime');

function getHashRuntimeOverride(): HashRuntimeOverride | undefined {
  return (globalThis as Record<PropertyKey, unknown>)[runtimeOverrideSymbol] as
    | HashRuntimeOverride
    | undefined;
}

function getBunRuntime(): Pick<typeof Bun, 'CryptoHasher'> | undefined {
  const runtimeOverride = getHashRuntimeOverride();
  if (runtimeOverride && 'Bun' in runtimeOverride) {
    return runtimeOverride.Bun;
  }

  return typeof Bun !== 'undefined' ? Bun : undefined;
}

function requireNodeCrypto(): typeof import('node:crypto') {
  const runtimeOverride = getHashRuntimeOverride();
  if (runtimeOverride?.require) {
    return runtimeOverride.require('node:crypto') as typeof import('node:crypto');
  }

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('node:crypto') as typeof import('node:crypto');
}

/**
 * Computes the SHA-256 hex digest of a string using the Web Crypto API.
 * Works in all environments: browsers, Node.js, Bun, Deno.
 */
export async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const buffer = await crypto.subtle.digest('SHA-256', data);
  const bytes = new Uint8Array(buffer);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i]!.toString(16).padStart(2, '0');
  }
  return hex;
}

/**
 * Computes the SHA-256 hex digest of a string synchronously.
 * Uses `Bun.CryptoHasher` in Bun or `node:crypto` in Node.js.
 * Throws in browser environments where no synchronous crypto API is available.
 */
export function sha256HexSync(text: string): string {
  const bunRuntime = getBunRuntime();
  if (bunRuntime) {
    return new bunRuntime.CryptoHasher('sha256').update(text).digest('hex');
  }

  // Node.js runtime (lazy require to avoid bundler issues)
  try {
    const { createHash } = requireNodeCrypto();
    return createHash('sha256').update(text).digest('hex');
  } catch {
    throw new Error(
      'sha256HexSync is not available in this environment. Use the async sha256Hex instead, which works everywhere via Web Crypto.',
    );
  }
}

/**
 * Computes an HMAC-SHA-256 hex signature synchronously.
 * Uses `node:crypto` in Node.js and Bun.
 * Throws in browser environments where no synchronous HMAC API is available.
 */
export function hmacSha256HexSync(secret: string, text: string): string {
  try {
    const { createHmac } = requireNodeCrypto();
    return createHmac('sha256', secret).update(text).digest('hex');
  } catch {
    throw new Error(
      'hmacSha256HexSync is not available in this environment. Use Web Crypto for browser-compatible HMAC signing.',
    );
  }
}

/**
 * Compares two hex strings with Node's timing-safe equality when available.
 * Invalid hex strings and different-length values are never equal.
 */
export function timingSafeEqualHex(left: string, right: string): boolean {
  if (
    left.length !== right.length ||
    left.length % 2 !== 0 ||
    !/^[0-9a-f]+$/i.test(left) ||
    !/^[0-9a-f]+$/i.test(right)
  ) {
    return false;
  }

  try {
    const { timingSafeEqual } = requireNodeCrypto();
    return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
  } catch {
    throw new Error('timingSafeEqualHex is not available in this environment.');
  }
}

/**
 * Creates an incremental (streaming) hash for accumulating data across multiple `.update()` calls.
 * Uses `Bun.CryptoHasher` in Bun or `node:crypto` in Node.js.
 * Throws in browser environments where no synchronous streaming crypto API is available.
 *
 * @param algorithm - Hash algorithm to use. Default: `'sha256'`.
 */
export function createIncrementalHash(algorithm: string = 'sha256'): IncrementalHash {
  const bunRuntime = getBunRuntime();
  if (bunRuntime) {
    const hasher = new bunRuntime.CryptoHasher(algorithm as 'sha256');
    return {
      update(data: string) {
        hasher.update(data);
      },
      digest() {
        return hasher.digest('hex');
      },
    };
  }

  // Node.js runtime
  try {
    const { createHash } = requireNodeCrypto();
    const hash = createHash(algorithm);
    return {
      update(data: string) {
        hash.update(data);
      },
      digest() {
        return hash.digest('hex');
      },
    };
  } catch {
    throw new Error(
      'createIncrementalHash is not available in this environment. Use the async sha256Hex instead, which works everywhere via Web Crypto.',
    );
  }
}
