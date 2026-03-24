import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';

import { createAuthentication } from './authentication';
import { errorHandler } from './error-handler';
import { requestIdentifier } from './request-identifier';

function createApp(authToken: string | undefined) {
  const app = new Hono();
  app.use('*', requestIdentifier);
  app.use('*', createAuthentication(authToken));
  app.get('/protected', (c) => c.json({ ok: true }));
  app.onError(errorHandler);
  return app;
}

describe('authentication', () => {
  it('passes all requests when no token is configured', async () => {
    const app = createApp(undefined);
    const response = await app.request('/protected');
    expect(response.status).toBe(200);
  });

  it('rejects requests without authorization header', async () => {
    const app = createApp('secret-token');
    const response = await app.request('/protected');
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error.message).toBe('Missing authorization header');
  });

  it('rejects requests with wrong token', async () => {
    const app = createApp('secret-token');
    const response = await app.request('/protected', {
      headers: { authorization: 'Bearer wrong-token' },
    });
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error.message).toBe('Invalid authorization token');
  });

  it('rejects requests with wrong scheme', async () => {
    const app = createApp('secret-token');
    const response = await app.request('/protected', {
      headers: { authorization: 'Basic secret-token' },
    });
    expect(response.status).toBe(401);
  });

  it('passes requests with correct bearer token', async () => {
    const app = createApp('secret-token');
    const response = await app.request('/protected', {
      headers: { authorization: 'Bearer secret-token' },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
  });
});
