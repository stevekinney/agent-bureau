import { createDefaultRuntimeServices, type RuntimeServices } from '@lostgradient/lifecycle';
import { z } from 'zod';

import type { ComposedTool } from '../compose-types';
import { createTool, type InferSchemaInput } from '../create-tool';
import type { DefaultToolEvents, Tool, ToolContext, ToolEventsMap, ToolMetadata } from '../is-tool';
import type { ToolCallReturn } from '../types';

type RetryBackoff = 'fixed' | 'exponential';

type RetryHookDetail = {
  attempt: number;
  error: unknown;
  context: ToolContext;
};

type RetryOptions = {
  attempts?: number;
  delayMs?: number;
  backoff?: RetryBackoff;
  maxDelayMs?: number;
  shouldRetry?: (detail: RetryHookDetail) => boolean | Promise<boolean>;
  onRetry?: (detail: RetryHookDetail) => void | Promise<void>;
  sleep?: (milliseconds: number, signal?: ToolContext['signal']) => Promise<void>;
  /**
   * The injectable runtime-service seam (AB-92's `RuntimeServices`, AB-254)
   * backing this wrap's default `sleep` timer. Resolved once, at wrap time.
   * A test composes its own from `@lostgradient/lifecycle`'s
   * `createManualRuntimeServices()` and drives the backoff delay entirely
   * through `advance()`, with no real timer, instead of supplying `sleep`.
   */
  runtime?: RuntimeServices;
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
 * @param options.backoff - Backoff strategy: 'fixed' or 'exponential' (default: 'fixed')
 * @param options.maxDelayMs - Maximum delay cap for backoff strategies
 * @param options.shouldRetry - Custom function to determine if error should trigger retry
 * @param options.onRetry - Callback invoked before each retry attempt
 * @returns A new tool that retries on failure
 *
 * @example Basic retry with exponential backoff
 * ```typescript
 * import { createTool } from 'armorer';
 * import { retry } from 'armorer';
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
export function retry<
  TSchema extends z.ZodType,
  TEvents extends ToolEventsMap,
  TOutput,
  TMetadata extends ToolMetadata | undefined,
>(
  tool: Tool<TSchema, TEvents, TOutput, TMetadata>,
  options: RetryOptions = {},
): ComposedTool<InferSchemaInput<TSchema>, ToolCallReturn<TOutput>, TMetadata> {
  const { attempts, delayMs, maxDelayMs, backoff } = validateRetryOptions(options);
  const runtime = options.runtime ?? createDefaultRuntimeServices();
  const {
    shouldRetry,
    onRetry,
    sleep = (ms: number, signal?: ToolContext['signal']) => wait(ms, signal, runtime),
  } = options;
  const name = `retry(${tool.name})`;
  const description = `Retry tool: ${tool.description}`;
  const tags = tool.tags && tool.tags.length ? tool.tags : undefined;
  const input = tool.input;
  const metadata = tool.metadata;

  const runWithRetry = async (
    params: InferSchemaInput<TSchema>,
    context: ToolContext,
  ): Promise<ToolCallReturn<TOutput>> => {
    const executeOptions = buildRetryExecuteOptions(context);

    const runTool = (value: InferSchemaInput<TSchema>) => tool.execute(value, executeOptions);
    let attempt = 0;
    let lastError: unknown;

    while (attempt < attempts) {
      attempt += 1;
      if (context.signal?.aborted) {
        throw toError(context.signal.reason ?? new Error('Cancelled'));
      }
      try {
        return await runTool(params);
      } catch (error) {
        lastError = error;
        if (
          !(await prepareNextRetry({
            attempt,
            attempts,
            error,
            context,
            shouldRetry,
            onRetry,
            sleep,
            delayMs,
            backoff,
            maxDelayMs,
          }))
        )
          break;
      }
    }

    throw toError(lastError ?? new Error('retry() failed without an error'));
  };

  return createTool<
    TSchema,
    TOutput,
    DefaultToolEvents,
    readonly string[],
    TMetadata,
    ToolCallReturn<TOutput>
  >({
    name,
    description,
    input,
    async execute(params: InferSchemaInput<TSchema>, context: ToolContext) {
      return runWithRetry(params, context);
    },
    ...(tags ? { tags } : {}),
    metadata,
  });
}

function validateRetryOptions(options: RetryOptions) {
  const attempts = options.attempts ?? 3;
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new RangeError('retry() expects attempts to be a positive integer');
  }
  const delayMs = options.delayMs ?? 0;
  if (delayMs < 0) throw new RangeError('retry() expects delayMs to be at least 0');
  const maxDelayMs = options.maxDelayMs;
  if (maxDelayMs !== undefined && maxDelayMs < 0) {
    throw new RangeError('retry() expects maxDelayMs to be at least 0');
  }
  return { attempts, delayMs, maxDelayMs, backoff: options.backoff ?? 'fixed' };
}

function buildRetryExecuteOptions(context: ToolContext) {
  if (!context.signal && context.timeout === undefined && context.stream === undefined)
    return undefined;
  return {
    ...(context.signal ? { signal: context.signal } : {}),
    ...(context.timeout !== undefined ? { timeout: context.timeout } : {}),
    ...(context.stream !== undefined ? { stream: context.stream } : {}),
  };
}

async function prepareNextRetry({
  attempt,
  attempts,
  error,
  context,
  shouldRetry,
  onRetry,
  sleep,
  delayMs,
  backoff,
  maxDelayMs,
}: {
  attempt: number;
  attempts: number;
  error: unknown;
  context: ToolContext;
  shouldRetry?: RetryOptions['shouldRetry'];
  onRetry?: RetryOptions['onRetry'];
  sleep: NonNullable<RetryOptions['sleep']>;
  delayMs: number;
  backoff: RetryBackoff;
  maxDelayMs: number | undefined;
}): Promise<boolean> {
  if (context.signal?.aborted) throw toError(context.signal.reason ?? error);
  if (attempt >= attempts) return false;
  if (shouldRetry && !(await shouldRetry({ attempt, error, context }))) throw toError(error);
  if (onRetry) await onRetry({ attempt, error, context });
  const waitMs = resolveRetryDelay(attempt, delayMs, backoff, maxDelayMs);
  if (waitMs > 0) await sleep(waitMs, context.signal);
  return true;
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

const defaultWaitRuntime = createDefaultRuntimeServices();

function wait(
  ms: number,
  signal?: ToolContext['signal'],
  runtime: RuntimeServices = defaultWaitRuntime,
): Promise<void> {
  const scheduleTimeout = runtime.timers.setTimeout;
  const cancelTimeout = runtime.timers.clearTimeout;
  if (!signal) {
    return new Promise((resolve) => scheduleTimeout(resolve, ms));
  }
  if (signal.aborted) {
    return Promise.reject(toError(signal.reason ?? new Error('Cancelled')));
  }
  return new Promise((resolve, reject) => {
    const id = scheduleTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      cancelTimeout(id);
      reject(toError(signal.reason ?? new Error('Cancelled')));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export const internalRetryTestUtilities = {
  resolveRetryDelay,
  toError,
  wait,
};
