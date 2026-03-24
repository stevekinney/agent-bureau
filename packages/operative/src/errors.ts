export class ElicitationDeniedError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = 'ElicitationDeniedError';
  }
}

export class BudgetExceededError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = 'BudgetExceededError';
  }
}

export type ErrorCategory =
  | 'rate-limit'
  | 'timeout'
  | 'authentication'
  | 'server'
  | 'client'
  | 'network'
  | 'unknown';

export interface ClassifiedError {
  category: ErrorCategory;
  retryable: boolean;
  statusCode?: number;
  provider?: string;
  original: unknown;
}

function categorizeStatusCode(statusCode: number): ErrorCategory {
  if (statusCode === 429) return 'rate-limit';
  if (statusCode === 401 || statusCode === 403) return 'authentication';
  if (statusCode >= 500) return 'server';
  if (statusCode >= 400) return 'client';
  return 'unknown';
}

/**
 * Classifies an error into a structured category with retryability info.
 * User-land helper — not called by the loop.
 */
export function classifyError(error: unknown): ClassifiedError {
  const base: ClassifiedError = {
    category: 'unknown',
    retryable: false,
    original: error,
  };

  if (error === null || error === undefined) return base;

  const errorObject = error as Record<string, unknown>;

  if (typeof errorObject['provider'] === 'string') {
    base.provider = errorObject['provider'];
  }

  const statusCode =
    typeof errorObject['statusCode'] === 'number'
      ? errorObject['statusCode']
      : typeof errorObject['status'] === 'number'
        ? errorObject['status']
        : undefined;

  if (statusCode !== undefined) {
    base.statusCode = statusCode;
  }

  if (typeof errorObject['retryable'] === 'boolean') {
    base.retryable = errorObject['retryable'];
    if (statusCode !== undefined) {
      base.category = categorizeStatusCode(statusCode);
    }
    return base;
  }

  if (statusCode !== undefined) {
    base.category = categorizeStatusCode(statusCode);
    base.retryable = statusCode === 429 || statusCode >= 500;
    return base;
  }

  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  if (/ECONNREFUSED|ETIMEDOUT|fetch failed/i.test(message)) {
    base.category = 'network';
    base.retryable = true;
    return base;
  }

  if (error instanceof Error) {
    if (error.name === 'AbortError' || error.name === 'TimeoutError') {
      base.category = 'timeout';
      base.retryable = false;
      return base;
    }
  }

  return base;
}
