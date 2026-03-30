/**
 * Cross-platform cryptographic hashing utilities.
 *
 * - `sha256Hex` uses the Web Crypto API and works in all environments (browser, Node, Bun, Deno).
 * - `sha256HexSync` is synchronous and works in Node.js and Bun (throws in browsers).
 * - `createIncrementalHash` returns a streaming hasher for accumulating data across multiple `.update()` calls.
 */

/** Interface for an incremental (streaming) hash that accumulates data via `.update()`. */
export type IncrementalHash = {
  /** Feed more data into the hash. */
  update(data: string): void;
  /** Finalize and return the hex digest. */
  digest(): string;
};

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
  // Bun runtime
  if (typeof Bun !== 'undefined') {
    return new Bun.CryptoHasher('sha256').update(text).digest('hex');
  }

  // Node.js runtime (lazy require to avoid bundler issues)
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createHash } = require('node:crypto') as typeof import('node:crypto');
    return createHash('sha256').update(text).digest('hex');
  } catch {
    throw new Error(
      'sha256HexSync is not available in this environment. Use the async sha256Hex instead, which works everywhere via Web Crypto.',
    );
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
  // Bun runtime
  if (typeof Bun !== 'undefined') {
    const hasher = new Bun.CryptoHasher(algorithm as 'sha256');
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
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createHash } = require('node:crypto') as typeof import('node:crypto');
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
