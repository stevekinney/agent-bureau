import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';

import type { ApiErrorResponse } from '../types';
import { errorHandler } from './error-handler';
import { requestIdentifier } from './request-identifier';

function createApp() {
  const app = new Hono();
  app.use('*', requestIdentifier);

  app.get('/http-error', () => {
    throw new HTTPException(404, { message: 'Thing not found' });
  });

  app.get('/unexpected', () => {
    throw new Error('kaboom');
  });

  app.onError(errorHandler);
  return app;
}

describe('errorHandler', () => {
  it('formats HTTPException into ApiErrorResponse', async () => {
    const app = createApp();
    const response = await app.request('/http-error');
    expect(response.status).toBe(404);

    const body: ApiErrorResponse = await response.json();
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.message).toBe('Thing not found');
    expect(body.error.requestId).toBeString();
  });

  it('formats unexpected errors as 500', async () => {
    const app = createApp();
    const response = await app.request('/unexpected');
    expect(response.status).toBe(500);

    const body: ApiErrorResponse = await response.json();
    expect(body.error.code).toBe('INTERNAL_ERROR');
    expect(body.error.message).toBe('An unexpected error occurred');
  });

  it('includes the request ID in error responses', async () => {
    const app = createApp();
    const response = await app.request('/http-error', {
      headers: { 'x-request-id': 'err-req-1' },
    });

    const body: ApiErrorResponse = await response.json();
    expect(body.error.requestId).toBe('err-req-1');
  });

  it('maps status codes to correct error codes', async () => {
    const app = new Hono();
    app.use('*', requestIdentifier);

    for (const [status] of [
      [400, 'BAD_REQUEST'],
      [401, 'UNAUTHORIZED'],
      [403, 'FORBIDDEN'],
      [409, 'CONFLICT'],
      [501, 'NOT_IMPLEMENTED'],
    ] as const) {
      app.get(`/err-${status}`, () => {
        throw new HTTPException(status, { message: `Error ${status}` });
      });
    }

    app.onError(errorHandler);

    for (const [status, code] of [
      [400, 'BAD_REQUEST'],
      [401, 'UNAUTHORIZED'],
      [403, 'FORBIDDEN'],
      [409, 'CONFLICT'],
      [501, 'NOT_IMPLEMENTED'],
    ] as const) {
      const response = await app.request(`/err-${status}`);
      expect(response.status).toBe(status);
      const body: ApiErrorResponse = await response.json();
      expect(body.error.code).toBe(code);
    }
  });
});
