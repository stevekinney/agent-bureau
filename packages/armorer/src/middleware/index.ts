import type { ToolConfiguration } from '../is-tool';

/**
 * Creates a rate limiting middleware that restricts the number of tool executions
 * within a specified time window.
 *
 * @param options - Configuration options.
 * @param options.windowMs - Time window in milliseconds (default: 60000).
 * @param options.limit - Maximum number of requests per window (default: 10).
 * @param options.keyGenerator - Optional function to generate a unique key for limiting (e.g., by user ID). Defaults to global limit per tool.
 * @returns A middleware function.
 */
export function createRateLimitMiddleware(
  options: {
    windowMs?: number;
    limit?: number;
    keyGenerator?: (params: unknown, context: unknown) => string;
  } = {},
) {
  const windowMs = options.windowMs ?? 60000;
  const limit = options.limit ?? 10;
  const keyGenerator = options.keyGenerator ?? (() => 'global');

  // State: Map<ToolName, Map<Key, { count: number; resetTime: number }>>
  const state = new Map<string, Map<string, { count: number; resetTime: number }>>();

  return (configuration: ToolConfiguration): ToolConfiguration => {
    const originalExecute = configuration.execute;

    // We need to resolve the potentially lazy execute function
    const wrappedExecute = async (params: unknown, context: unknown) => {
      // Initialize state for this tool
      if (!state.has(configuration.name)) {
        state.set(configuration.name, new Map());
      }
      const toolState = state.get(configuration.name)!;

      const key = keyGenerator(params, context);
      const now = Date.now();
      let record = toolState.get(key);

      if (!record || now > record.resetTime) {
        record = { count: 0, resetTime: now + windowMs };
        toolState.set(key, record);
      }

      if (record.count >= limit) {
        throw new Error(
          `Rate limit exceeded for tool "${configuration.name}". Limit: ${limit} per ${windowMs}ms.`,
        );
      }

      record.count += 1;

      // Call original execute
      let executeFn: (params: unknown, context: unknown) => Promise<unknown>;
      if (typeof originalExecute === 'function') {
        executeFn = originalExecute;
      } else {
        executeFn = await originalExecute;
      }

      return executeFn(params, context);
    };

    return {
      ...configuration,
      execute: wrappedExecute,
    };
  };
}

/**
 * Creates a caching middleware that stores results of tool executions.
 *
 * @param options - Configuration options.
 * @param options.ttlMs - Time to live in milliseconds (default: 60000).
 * @param options.keyGenerator - Optional function to generate cache keys. Defaults to stable stringification of params.
 * @returns A middleware function.
 */
export function createCacheMiddleware(
  options: {
    ttlMs?: number;
    keyGenerator?: (params: unknown) => string;
  } = {},
) {
  const ttlMs = options.ttlMs ?? 60000;

  // State: Map<ToolName, Map<CacheKey, { value: unknown; expiry: number }>>
  const cache = new Map<string, Map<string, { value: unknown; expiry: number }>>();

  const defaultKeyGenerator = (params: unknown): string => {
    try {
      // Simple stable stringify for JSON-compatible params
      return JSON.stringify(params, Object.keys(params as object).sort());
    } catch {
      return String(params);
    }
  };

  const keyGenerator = options.keyGenerator ?? defaultKeyGenerator;

  return (configuration: ToolConfiguration): ToolConfiguration => {
    // Skip caching for mutating or dangerous tools unless explicitly forced?
    // For safety, we should probably check metadata, but middleware is opted-in by the user.
    // If the user adds cache middleware to a mutating tool, they probably know what they're doing (or making a mistake).
    // Let's assume safety is handled by policy or user discretion.

    const originalExecute = configuration.execute;

    const wrappedExecute = async (params: unknown, context: unknown) => {
      // Initialize cache for this tool
      if (!cache.has(configuration.name)) {
        cache.set(configuration.name, new Map());
      }
      const toolCache = cache.get(configuration.name)!;
      const key = keyGenerator(params);
      const now = Date.now();
      const cached = toolCache.get(key);

      if (cached && now < cached.expiry) {
        return cached.value;
      }

      // Call original execute
      let executeFn: (params: unknown, context: unknown) => Promise<unknown>;
      if (typeof originalExecute === 'function') {
        executeFn = originalExecute;
      } else {
        executeFn = await originalExecute;
      }

      const result = await executeFn(params, context);

      // Store result
      toolCache.set(key, { value: result, expiry: now + ttlMs });

      return result;
    };

    return {
      ...configuration,
      execute: wrappedExecute,
    };
  };
}

/**
 * Creates a timeout middleware that enforces a strict time limit on execution.
 *
 * @param ms - Timeout in milliseconds.
 * @returns A middleware function.
 */
export function createTimeoutMiddleware(ms: number) {
  return (configuration: ToolConfiguration): ToolConfiguration => {
    const originalExecute = configuration.execute;

    const wrappedExecute = async (params: unknown, context: unknown) => {
      let executeFn: (params: unknown, context: unknown) => Promise<unknown>;
      if (typeof originalExecute === 'function') {
        executeFn = originalExecute;
      } else {
        executeFn = await originalExecute;
      }

      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`Tool "${configuration.name}" timed out after ${ms}ms`));
        }, ms);

        executeFn(params, context)
          .then((result) => {
            clearTimeout(timer);
            resolve(result);
          })
          .catch((error) => {
            clearTimeout(timer);
            reject(error instanceof Error ? error : new Error(String(error)));
          });
      });
    };

    return {
      ...configuration,
      execute: wrappedExecute,
    };
  };
}
