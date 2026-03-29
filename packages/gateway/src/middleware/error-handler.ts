import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';

import type { ApiErrorResponse } from '../types';

/**
 * Global error handler that produces a consistent `ApiErrorResponse` envelope.
 */
export function errorHandler(error: Error, context: Context): Response {
  const requestId = context.get('requestId') as string | undefined;

  if (error instanceof HTTPException) {
    // If the exception carries a custom response (e.g., rate limiter with headers),
    // use it directly to preserve headers like retry-after.
    if (error.res) {
      return error.res;
    }

    const body: ApiErrorResponse = {
      error: {
        code: statusToCode(error.status),
        message: error.message,
        requestId,
      },
    };
    return context.json(body, error.status);
  }

  const body: ApiErrorResponse = {
    error: {
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
      requestId,
    },
  };
  return context.json(body, 500);
}

function statusToCode(status: number): string {
  switch (status) {
    case 400:
      return 'BAD_REQUEST';
    case 401:
      return 'UNAUTHORIZED';
    case 403:
      return 'FORBIDDEN';
    case 404:
      return 'NOT_FOUND';
    case 409:
      return 'CONFLICT';
    case 429:
      return 'RATE_LIMITED';
    case 501:
      return 'NOT_IMPLEMENTED';
    default:
      return 'INTERNAL_ERROR';
  }
}
