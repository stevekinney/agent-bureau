import type { ProviderName } from './types.ts';

const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

/**
 * Wraps SDK errors from any provider with consistent metadata.
 */
export class ProviderError extends Error {
  readonly provider: ProviderName;
  override readonly cause: unknown;
  readonly statusCode?: number;
  readonly retryable: boolean;

  constructor(options: {
    provider: ProviderName;
    cause: unknown;
    message?: string;
    statusCode?: number;
  }) {
    const statusCode = options.statusCode ?? extractStatusCode(options.cause);
    const message =
      options.message ?? `[provider:${options.provider}] ${extractMessage(options.cause)}`;

    super(message);
    this.name = 'ProviderError';
    this.provider = options.provider;
    this.cause = options.cause;
    this.statusCode = statusCode;
    this.retryable = statusCode !== undefined && RETRYABLE_STATUS_CODES.has(statusCode);
  }
}

/**
 * Returns true when the error is a retryable ProviderError.
 * Designed for use as `retry.shouldRetry` in operative's RetryOptions.
 */
export function shouldRetryProviderError(error: unknown): boolean {
  return error instanceof ProviderError && error.retryable;
}

/**
 * Extracts an HTTP status code from an arbitrary SDK error shape, checking `status`, `statusCode`,
 * and a nested `error.status` (the shape some SDKs use). Returns `undefined` when no code is found.
 */
export function extractStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;

  if ('status' in error && typeof error.status === 'number') {
    return error.status;
  }

  if ('statusCode' in error && typeof error.statusCode === 'number') {
    return error.statusCode;
  }

  if (
    'error' in error &&
    error.error &&
    typeof error.error === 'object' &&
    'status' in error.error &&
    typeof error.error.status === 'number'
  ) {
    return error.error.status;
  }

  return undefined;
}

function extractMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'Unknown error';
}
