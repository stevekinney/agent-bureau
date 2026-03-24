import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';

import { requestIdentifier } from './request-identifier';

function createApp() {
  const app = new Hono();
  app.use('*', requestIdentifier);
  app.get('/test', (c) => c.json({ requestId: c.get('requestId' as never) }));
  return app;
}

describe('requestIdentifier', () => {
  it('generates a request ID when none is provided', async () => {
    const app = createApp();
    const response = await app.request('/test');
    const id = response.headers.get('x-request-id');
    expect(id).toBeString();
    expect(id!.length).toBeGreaterThan(0);
  });

  it('reuses the request ID from the incoming header', async () => {
    const app = createApp();
    const response = await app.request('/test', {
      headers: { 'x-request-id': 'custom-id-123' },
    });
    expect(response.headers.get('x-request-id')).toBe('custom-id-123');
  });

  it('makes the request ID available via context', async () => {
    const app = createApp();
    const response = await app.request('/test', {
      headers: { 'x-request-id': 'ctx-id' },
    });
    const body = await response.json();
    expect(body.requestId).toBe('ctx-id');
  });
});
