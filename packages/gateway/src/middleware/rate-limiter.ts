import type { TextValueStore } from '@lostgradient/weft/storage';
import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';

/** Configuration for the sliding-window rate limiter. */
export type RateLimitOptions = {
  /** Maximum number of requests per window. Defaults to 60. */
  limit?: number;
  /** Store-backed limiter state. Falls back to in-memory state when omitted. */
  store?: TextValueStore;
  /** Window duration in milliseconds. Defaults to 60_000 (1 minute). */
  windowMs?: number;
  /** Clock used by tests to make pruning and reset calculations deterministic. */
  now?: () => number;
};

type WindowEntry = {
  timestamps: number[];
};

type RateLimitDecision =
  | {
      remaining: number;
      resetAt: number;
      status: 'allowed';
    }
  | {
      resetAt: number;
      retryAfter: number;
      status: 'limited';
    };

const DEFAULT_LIMIT = 60;
const DEFAULT_WINDOW_MS = 60_000;

function createMemoryWindowStore(windowMs: number, now: () => number) {
  const windows = new Map<string, WindowEntry>();
  let requestCount = 0;

  return {
    load(key: string): WindowEntry {
      requestCount += 1;
      if (requestCount % 1000 === 0) {
        const cutoff = now() - windowMs;
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

function createStoreBackedWindowStore(store: TextValueStore) {
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

function createPrincipalMutex() {
  const pending = new Map<string, Promise<void>>();

  return async function withPrincipalLock<T>(
    principal: string,
    callback: () => Promise<T>,
  ): Promise<T> {
    const previous = pending.get(principal) ?? Promise.resolve();
    let releaseCurrent: (() => void) | undefined;
    const current = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    const currentChain = previous.then(() => current);
    pending.set(principal, currentChain);

    await previous;

    try {
      return await callback();
    } finally {
      releaseCurrent?.();
      if (pending.get(principal) === currentChain) {
        pending.delete(principal);
      }
    }
  };
}

/**
 * Creates a per-principal sliding-window rate limiter middleware.
 */
export function createRateLimiter(options?: RateLimitOptions) {
  const limit = options?.limit ?? DEFAULT_LIMIT;
  const windowMs = options?.windowMs ?? DEFAULT_WINDOW_MS;
  const now = options?.now ?? Date.now;
  const windowStore = options?.store
    ? createStoreBackedWindowStore(options.store)
    : createMemoryWindowStore(windowMs, now);
  const withPrincipalLock = createPrincipalMutex();

  return createMiddleware(async (context, next) => {
    const principal = context.req.header('x-auth-principal') ?? context.req.header('x-api-key-id');
    if (!principal) {
      await next();
      return;
    }

    const storageKey = `gateway:rate-limit:${principal}`;
    const decision = await withPrincipalLock(storageKey, async () => {
      const currentTime = now();
      const windowStart = currentTime - windowMs;
      const entry = await windowStore.load(storageKey);
      const previousTimestampCount = entry.timestamps.length;
      entry.timestamps = entry.timestamps.filter((timestamp) => timestamp > windowStart);

      if (entry.timestamps.length >= limit) {
        if (entry.timestamps.length !== previousTimestampCount) {
          await windowStore.save(storageKey, entry);
        }

        const oldestTimestamp = entry.timestamps[0] ?? currentTime;
        return {
          retryAfter: Math.max(1, Math.ceil((oldestTimestamp + windowMs - currentTime) / 1000)),
          resetAt: Math.ceil((oldestTimestamp + windowMs) / 1000),
          status: 'limited',
        } satisfies RateLimitDecision;
      }

      entry.timestamps.push(currentTime);
      await windowStore.save(storageKey, entry);

      return {
        remaining: Math.max(0, limit - entry.timestamps.length),
        resetAt: Math.ceil(((entry.timestamps[0] ?? currentTime) + windowMs) / 1000),
        status: 'allowed',
      } satisfies RateLimitDecision;
    });

    if (decision.status === 'limited') {
      throw new HTTPException(429, {
        res: new Response(JSON.stringify({ error: { message: 'Rate limit exceeded' } }), {
          status: 429,
          headers: new Headers({
            'content-type': 'application/json',
            'retry-after': String(decision.retryAfter),
            'x-ratelimit-limit': String(limit),
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset': String(decision.resetAt),
          }),
        }),
      });
    }

    await next();

    context.header('x-ratelimit-limit', String(limit));
    context.header('x-ratelimit-remaining', String(decision.remaining));
    context.header('x-ratelimit-reset', String(decision.resetAt));
  });
}
