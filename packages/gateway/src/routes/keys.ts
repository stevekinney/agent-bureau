import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';

import type { ApiKeyStore } from '../keys/types';

/**
 * Creates routes for API key lifecycle management. These routes should be
 * guarded by the `keys:manage` scope in the gateway wiring.
 */
export function createKeysRoutes(apiKeyStore: ApiKeyStore) {
  const app = new Hono();

  app.post('/', async (context) => {
    let body: { name?: string; scopes?: string[]; expiresAt?: string };
    try {
      body = await context.req.json();
    } catch {
      throw new HTTPException(400, { message: 'Invalid JSON body' });
    }

    if (!body.name || typeof body.name !== 'string') {
      throw new HTTPException(400, { message: 'Request must include a "name" string' });
    }

    const result = await apiKeyStore.create({
      name: body.name,
      scopes: body.scopes,
      expiresAt: body.expiresAt,
    });

    return context.json(result, 201);
  });

  app.get('/', async (context) => {
    const keys = await apiKeyStore.list();
    return context.json(keys, 200);
  });

  app.delete('/:id', async (context) => {
    await apiKeyStore.revoke(context.req.param('id'));
    return context.body(null, 204);
  });

  app.post('/:id/rotate', async (context) => {
    try {
      const result = await apiKeyStore.rotate(context.req.param('id'));
      return context.json(result, 200);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('API key not found')) {
        throw new HTTPException(404, { message: error.message });
      }
      throw error;
    }
  });

  return app;
}
