import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';

import { errorHandler } from './error-handler';
import { requestIdentifier } from './request-identifier';
import { createScopeGuard } from './scope-guard';

function createApp(requiredScopes: string[]) {
  const app = new Hono();
  app.use('*', requestIdentifier);
  app.get('/test', createScopeGuard(requiredScopes), (c) => c.json({ ok: true }));
  app.onError(errorHandler);
  return app;
}

describe('scope guard', () => {
  it('passes when key has the required scope', async () => {
    const app = createApp(['runs:read']);
    const response = await app.request('/test', {
      headers: { 'x-api-key-scopes': 'runs:read,runs:write' },
    });
    expect(response.status).toBe(200);
  });

  it('passes when key has empty scopes (admin)', async () => {
    const app = createApp(['runs:read']);
    const response = await app.request('/test', {
      headers: { 'x-api-key-scopes': '' },
    });
    expect(response.status).toBe(200);
  });

  it('passes when no scopes header is present (unauthenticated or static token)', async () => {
    const app = createApp(['runs:read']);
    const response = await app.request('/test');
    expect(response.status).toBe(200);
  });

  it('rejects when key lacks the required scope', async () => {
    const app = createApp(['runs:write']);
    const response = await app.request('/test', {
      headers: { 'x-api-key-scopes': 'runs:read' },
    });
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error.message).toContain('Insufficient scope');
  });

  it('requires all specified scopes', async () => {
    const app = createApp(['runs:read', 'runs:write']);
    const response = await app.request('/test', {
      headers: { 'x-api-key-scopes': 'runs:read' },
    });
    expect(response.status).toBe(403);
  });

  it('passes when key has all required scopes', async () => {
    const app = createApp(['runs:read', 'runs:write']);
    const response = await app.request('/test', {
      headers: { 'x-api-key-scopes': 'runs:read,runs:write,config:read' },
    });
    expect(response.status).toBe(200);
  });

  it('passes when no scopes are required', async () => {
    const app = createApp([]);
    const response = await app.request('/test', {
      headers: { 'x-api-key-scopes': 'runs:read' },
    });
    expect(response.status).toBe(200);
  });
});
