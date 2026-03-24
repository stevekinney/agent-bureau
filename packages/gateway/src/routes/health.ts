import { Hono } from 'hono';

import type { Bureau, HealthResponse } from '../types';

export function createHealthRoutes(bureau: Bureau) {
  const app = new Hono();

  app.get('/live', (context) => {
    const body: HealthResponse = { status: 'ok' };
    return context.json(body, 200);
  });

  app.get('/ready', (context) => {
    const body: HealthResponse = { status: bureau.ready ? 'ok' : 'unavailable' };
    return context.json(body, bureau.ready ? 200 : 503);
  });

  return app;
}
