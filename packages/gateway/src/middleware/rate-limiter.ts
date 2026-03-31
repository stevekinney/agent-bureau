import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';
import type { KeyValueStore } from 'storage';

/** Configuration for the sliding-window rate limiter. */
export type RateLimitOptions = {
  /** Maximum number of requests per window. Defaults to 60. */
  limit?: number;
  /** Store-backed limiter state. Falls back to in-memory state when omitted. */
  store?: KeyValueStore;
  /** Window duration in milliseconds. Defaults to 60_000 (1 minute). */
  windowMs?: number;
};

type WindowEntry = {
  timestamps: number[];
};

const DEFAULT_LIMIT = 60;
const DEFAULT_WINDOW_MS = 60_000;

function createMemoryWindowStore(windowMs: number) {
  const windows = new Map<string, WindowEntry>();
  let requestCount = 0;

  return {
    load(key: string): WindowEntry {
      requestCount += 1;
      if (requestCount % 1000 === 0) {
        const cutoff = Date.now() - windowMs;
        for (const [candidateKey, entry] of windows) {
          if (entry.timestamps.every((timestamp) => timestamp <= cutoff)) {
            windows.delete(candidateKey);
          }
        }
      }

      return windows.get(key) ?? { timestamps: [] };
    },
    save(key: string, entry: WindowEntry): void {
      windows.set(key, entry);
    },
  };
}

function createStoreBackedWindowStore(store: KeyValueStore) {
  return {
    async load(key: string): Promise<WindowEntry> {
      const value = await store.get(key);
      if (!value) {
        return { timestamps: [] };
      }

      try {
        const parsed = JSON.parse(value) as WindowEntry;
        return { timestamps: Array.isArray(parsed.timestamps) ? parsed.timestamps : [] };
      } catch {
        return { timestamps: [] };
      }
    },
    async save(key: string, entry: WindowEntry): Promise<void> {
      await store.set(key, JSON.stringify(entry));
    },
  };
}

/**
 * Creates a per-principal sliding-window rate limiter middleware.
 */
export function createRateLimiter(options?: RateLimitOptions) {
  const limit = options?.limit ?? DEFAULT_LIMIT;
  const windowMs = options?.windowMs ?? DEFAULT_WINDOW_MS;
  const windowStore = options?.store
    ? createStoreBackedWindowStore(options.store)
    : createMemoryWindowStore(windowMs);

  return createMiddleware(async (context, next) => {
    const principal = context.req.header('x-auth-principal') ?? context.req.header('x-api-key-id');
    if (!principal) {
      await next();
      return;
    }

    const now = Date.now();
    const windowStart = now - windowMs;
    const storageKey = `gateway:rate-limit:${principal}`;
    const entry = await windowStore.load(storageKey);
    entry.timestamps = entry.timestamps.filter((timestamp) => timestamp > windowStart);

    if (entry.timestamps.length >= limit) {
      const oldestTimestamp = entry.timestamps[0] ?? now;
      const resetAt = Math.ceil((oldestTimestamp + windowMs) / 1000);
      const retryAfter = Math.max(1, Math.ceil((oldestTimestamp + windowMs - now) / 1000));

      throw new HTTPException(429, {
        res: new Response(JSON.stringify({ error: { message: 'Rate limit exceeded' } }), {
          status: 429,
          headers: new Headers({
            'content-type': 'application/json',
            'retry-after': String(retryAfter),
            'x-ratelimit-limit': String(limit),
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset': String(resetAt),
          }),
        }),
      });
    }

    entry.timestamps.push(now);
    await windowStore.save(storageKey, entry);

    const remaining = Math.max(0, limit - entry.timestamps.length);
    const resetAt = Math.ceil(((entry.timestamps[0] ?? now) + windowMs) / 1000);

    await next();

    context.header('x-ratelimit-limit', String(limit));
    context.header('x-ratelimit-remaining', String(remaining));
    context.header('x-ratelimit-reset', String(resetAt));
  });
}
