import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';

/** Configuration for the sliding-window rate limiter. */
export type RateLimitOptions = {
  /** Maximum number of requests per window. Defaults to 60. */
  limit?: number;
  /** Window duration in milliseconds. Defaults to 60_000 (1 minute). */
  windowMs?: number;
};

type WindowEntry = {
  timestamps: number[];
};

const DEFAULT_LIMIT = 60;
const DEFAULT_WINDOW_MS = 60_000;

/**
 * Creates a per-key sliding-window rate limiter middleware.
 *
 * The key is read from the `x-api-key-id` header, which is set by the
 * authentication middleware after verifying the API key. When no key id
 * is present (e.g. static token auth or unauthenticated routes), the
 * request passes through without rate limiting.
 *
 * Rate limit state is stored in memory and resets on process restart.
 */
const CLEANUP_INTERVAL = 1000; // Sweep stale entries every N requests

export function createRateLimiter(options?: RateLimitOptions) {
  const limit = options?.limit ?? DEFAULT_LIMIT;
  const windowMs = options?.windowMs ?? DEFAULT_WINDOW_MS;
  const windows = new Map<string, WindowEntry>();
  let requestCount = 0;

  return createMiddleware(async (context, next) => {
    // Periodically sweep stale entries to prevent unbounded map growth
    if (++requestCount % CLEANUP_INTERVAL === 0) {
      const cutoff = Date.now() - windowMs;
      for (const [key, entry] of windows) {
        if (entry.timestamps.every((t) => t <= cutoff)) {
          windows.delete(key);
        }
      }
    }

    const keyId = context.req.header('x-api-key-id');
    if (!keyId) {
      await next();
      return;
    }

    const now = Date.now();
    const windowStart = now - windowMs;

    let entry = windows.get(keyId);
    if (!entry) {
      entry = { timestamps: [] };
      windows.set(keyId, entry);
    }

    // Prune timestamps outside the current window
    entry.timestamps = entry.timestamps.filter((t) => t > windowStart);

    if (entry.timestamps.length >= limit) {
      const resetAt = Math.ceil(((entry.timestamps[0] ?? now) + windowMs) / 1000);
      const retryAfter = Math.max(
        1,
        Math.ceil(((entry.timestamps[0] ?? now) + windowMs - now) / 1000),
      );

      throw new HTTPException(429, {
        res: new Response(JSON.stringify({ error: { message: 'Rate limit exceeded' } }), {
          status: 429,
          headers: new Headers({
            'content-type': 'application/json',
            'x-ratelimit-limit': String(limit),
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset': String(resetAt),
            'retry-after': String(retryAfter),
          }),
        }),
      });
    }

    entry.timestamps.push(now);
    const remaining = limit - entry.timestamps.length;
    const resetAt = Math.ceil((now + windowMs) / 1000);

    await next();

    context.header('x-ratelimit-limit', String(limit));
    context.header('x-ratelimit-remaining', String(remaining));
    context.header('x-ratelimit-reset', String(resetAt));
  });
}
