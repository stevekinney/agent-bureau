import { z } from 'zod';

import type {
  AnyTool,
  ComposedTool,
  InferToolInput,
  InferToolOutput,
} from '../compose-types';
import { createTool, type CreateToolOptions } from '../create-tool';
import type { DefaultToolEvents, ToolContext, ToolMetadata } from '../is-tool';

type RetryBackoff = 'fixed' | 'exponential';

type RetryHookDetail = {
  attempt: number;
  error: unknown;
  context: ToolContext<DefaultToolEvents>;
};

type RetryOptions = {
  attempts?: number;
  delayMs?: number;
  backoff?: RetryBackoff;
  maxDelayMs?: number;
  shouldRetry?: (detail: RetryHookDetail) => boolean | Promise<boolean>;
  onRetry?: (detail: RetryHookDetail) => void | Promise<void>;
};

/**
 * Wraps a tool with automatic retry logic on failure.
 *
 * Retries the tool execution on error with configurable backoff strategies.
 * Useful for handling transient failures in network calls, rate-limited APIs,
 * or flaky external services.
 *
 * @param tool - The tool to wrap with retry logic
 * @param options - Retry configuration
 * @param options.attempts - Maximum number of attempts (default: 3)
 * @param options.delayMs - Initial delay between retries in milliseconds (default: 0)
 * @param options.backoff - Backoff strategy: 'fixed', 'linear', or 'exponential' (default: 'fixed')
 * @param options.maxDelayMs - Maximum delay cap for backoff strategies
 * @param options.shouldRetry - Custom function to determine if error should trigger retry
 * @param options.onRetry - Callback invoked before each retry attempt
 * @returns A new tool that retries on failure
 *
 * @example Basic retry with exponential backoff
 * ```typescript
 * import { createTool } from 'armorer';
 * import { retry } from 'armorer/utilities';
 * import { z } from 'zod';
 *
 * const fetchData = createTool({
 *   name: 'fetch-data',
 *   input: z.object({ url: z.string() }),
 *   async execute({ url }) {
 *     const response = await fetch(url);
 *     if (!response.ok) throw new Error(`HTTP ${response.status}`);
 *     return response.json();
 *   },
 * });
 *
 * const resilientFetch = retry(fetchData, {
 *   attempts: 5,
 *   delayMs: 100,
 *   backoff: 'exponential',
 *   maxDelayMs: 5000,
 * });
 * // Will retry up to 5 times with delays: 100ms, 200ms, 400ms, 800ms, 1600ms
 * ```
 *
 * @example With conditional retry logic
 * ```typescript
 * const apiCall = retry(fetchTool, {
 *   attempts: 3,
 *   delayMs: 1000,
 *   async shouldRetry({ error, attempt }) {
 *     // Only retry on rate limit errors
 *     if (error.message.includes('429')) {
 *       console.log(`Rate limited, retrying (attempt ${attempt})...`);
 *       return true;
 *     }
 *     return false;
 *   },
 * });
 * ```
 */
export function retry<TTool extends AnyTool>(
  tool: TTool,
  options: RetryOptions = {},
): ComposedTool<InferToolInput<TTool>, InferToolOutput<TTool>> {
  const attempts = options.attempts ?? 3;
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new RangeError('retry() expects attempts to be a positive integer');
  }

  const delayMs = options.delayMs ?? 0;
  if (delayMs < 0) {
    throw new RangeError('retry() expects delayMs to be at least 0');
  }

  const maxDelayMs = options.maxDelayMs;
  if (maxDelayMs !== undefined && maxDelayMs < 0) {
    throw new RangeError('retry() expects maxDelayMs to be at least 0');
  }

  const backoff = options.backoff ?? 'fixed';
  const { shouldRetry, onRetry } = options;
  const name = `retry(${tool.name})`;
  const description = `Retry tool: ${tool.description}`;
  const tags = tool.tags && tool.tags.length ? tool.tags : undefined;

  const runWithRetry = async (
    params: unknown,
    context: ToolContext<DefaultToolEvents>,
  ): Promise<InferToolOutput<TTool>> => {
    const input = params as InferToolInput<TTool>;
    const executeOptions =
      context.signal || context.timeout !== undefined || context.stream !== undefined
        ? {
            ...(context.signal ? { signal: context.signal } : {}),
            ...(context.timeout !== undefined ? { timeout: context.timeout } : {}),
            ...(context.stream !== undefined ? { stream: context.stream } : {}),
          }
        : undefined;

    const runTool =
      typeof (tool as { execute?: unknown }).execute === 'function'
        ? (value: InferToolInput<TTool>) =>
            (
              tool as {
                execute: (
                  value: InferToolInput<TTool>,
                  options?: typeof executeOptions,
                ) => Promise<InferToolOutput<TTool>>;
              }
            ).execute(value, executeOptions)
        : (value: InferToolInput<TTool>) =>
            tool(value) as Promise<InferToolOutput<TTool>>;
    let attempt = 0;
    let lastError: unknown;
    let rethrowOriginal = false;

    while (attempt < attempts) {
      attempt += 1;
      if (context.signal?.aborted) {
        throw toError(context.signal.reason ?? new Error('Cancelled'));
      }
      try {
        return await runTool(input);
      } catch (error) {
        if (context.signal?.aborted) {
          throw toError(context.signal.reason ?? error);
        }
        lastError = error;
        if (attempt >= attempts) break;

        if (shouldRetry) {
          const allowed = await shouldRetry({ attempt, error, context });
          if (!allowed) {
            rethrowOriginal = true;
            break;
          }
        }

        if (onRetry) {
          await onRetry({ attempt, error, context });
        }

        const waitMs = resolveRetryDelay(attempt, delayMs, backoff, maxDelayMs);
        if (waitMs > 0) {
          await wait(waitMs, context.signal);
        }
      }
    }

    if (rethrowOriginal) {
      throw toError(lastError);
    }
    throw toError(lastError ?? new Error('retry() failed without an error'));
  };

  const toolOptions: Omit<
    CreateToolOptions<
      InferToolInput<TTool>,
      InferToolOutput<TTool>,
      DefaultToolEvents,
      readonly string[],
      ToolMetadata | undefined,
      ToolContext<DefaultToolEvents>,
      InferToolOutput<TTool>
    >,
    'metadata'
  > & {
    metadata?: ToolMetadata | undefined;
  } = {
    name,
    description,
    input: tool.input as z.ZodType<InferToolInput<TTool>>,
    async execute(params, context) {
      return runWithRetry(params, context);
    },
    ...(tags ? { tags } : {}),
    ...(tool.metadata !== undefined ? { metadata: tool.metadata } : {}),
  };
  return createTool<
    InferToolInput<TTool>,
    InferToolOutput<TTool>,
    DefaultToolEvents,
    readonly string[],
    ToolMetadata | undefined,
    ToolContext<DefaultToolEvents>,
    InferToolOutput<TTool>
  >(toolOptions) as ComposedTool<InferToolInput<TTool>, InferToolOutput<TTool>>;
}

function resolveRetryDelay(
  attempt: number,
  delayMs: number,
  backoff: RetryBackoff,
  maxDelayMs?: number,
): number {
  if (delayMs <= 0) return 0;
  const multiplier = backoff === 'exponential' ? Math.pow(2, attempt - 1) : 1;
  const calculated = delayMs * multiplier;
  if (maxDelayMs === undefined) return calculated;
  return Math.min(calculated, maxDelayMs);
}

function toError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  if (typeof error === 'string') {
    return new Error(error);
  }
  try {
    return new Error(JSON.stringify(error));
  } catch {
    return new Error(String(error));
  }
}

function wait(
  ms: number,
  signal?: ToolContext<DefaultToolEvents>['signal'],
): Promise<void> {
  if (!signal) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  if (signal.aborted) {
    return Promise.reject(toError(signal.reason ?? new Error('Cancelled')));
  }
  return new Promise((resolve, reject) => {
    const id = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(id);
      reject(toError(signal.reason ?? new Error('Cancelled')));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
