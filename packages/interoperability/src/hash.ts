/**
 * Cross-platform cryptographic hashing utilities.
 *
 * - `sha256Hex` uses the Web Crypto API and works in all environments (browser, Node, Bun, Deno).
 * - `sha256HexSync` is synchronous and works in Bun and in Node.js 20.16+/22.3+ (throws in browsers
 *   and in older Node.js, where `process.getBuiltinModule` does not exist — use the async `sha256Hex`
 *   there instead, or supply a `require`-based runtime override; see below).
 * - `hmacSha256HexSync` signs text with HMAC-SHA-256 under the same Bun/Node 20.16+ requirement.
 * - `timingSafeEqualHex` compares hex digests without leaking the first differing byte (same
 *   Bun/Node 20.16+ requirement as the other synchronous helpers).
 * - `createIncrementalHash` returns a streaming hasher for accumulating data across multiple
 *   `.update()` calls (same Bun/Node 20.16+ requirement).
 *
 * The synchronous helpers read `node:crypto` via `process.getBuiltinModule` rather than a literal
 * `require(...)` call, specifically so that bundling this package for a browser build never injects
 * a `createRequire`/`node:module` shim (see AB-31). That trades away support for Node.js versions
 * older than 20.16.0/22.3.0 for the synchronous path; a caller that must support older Node can
 * still supply its own loader via the `agent-bureau.interoperability.hash.runtime` global override
 * (see `getHashRuntimeOverride` below) — set `{ require: (specifier) => require(specifier) }` from
 * a CommonJS entry point where a real `require` exists.
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
  getBuiltinModule?: ((specifier: string) => unknown) | undefined;
};

const runtimeOverrideSymbol = Symbol.for('agent-bureau.interoperability.hash.runtime');

function getHashRuntimeOverride(): HashRuntimeOverride | undefined {
  return (globalThis as Record<PropertyKey, unknown>)[runtimeOverrideSymbol] as
    HashRuntimeOverride | undefined;
}

function getBunRuntime(): Pick<typeof Bun, 'CryptoHasher'> | undefined {
  const runtimeOverride = getHashRuntimeOverride();
  if (runtimeOverride && 'Bun' in runtimeOverride) {
    return runtimeOverride.Bun;
  }

  return typeof Bun !== 'undefined' ? Bun : undefined;
}

function getBuiltinModuleFn(): ((specifier: string) => unknown) | undefined {
  const runtimeOverride = getHashRuntimeOverride();
  if (runtimeOverride && 'getBuiltinModule' in runtimeOverride) {
    return runtimeOverride.getBuiltinModule;
  }

  return globalThis.process?.getBuiltinModule?.bind(globalThis.process);
}

function requireNodeCrypto(): typeof import('node:crypto') {
  const runtimeOverride = getHashRuntimeOverride();
  if (runtimeOverride?.require) {
    return runtimeOverride.require('node:crypto') as typeof import('node:crypto');
  }

  // `process.getBuiltinModule` reads a Node/Bun builtin without a literal `require(...)` call,
  // so ESM bundlers never see a reason to inject a `createRequire` shim for this file — a plain
  // `require('node:crypto')` here would force that shim into every consumer's bundle, browser
  // builds included, even when this function is never reached at runtime.
  const builtinModule = getBuiltinModuleFn()?.('node:crypto');
  if (builtinModule) {
    return builtinModule as typeof import('node:crypto');
  }

  throw new Error('node:crypto is not available in this environment.');
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
