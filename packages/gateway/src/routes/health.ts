import { Hono } from 'hono';
import type { GenerateFunction } from 'operative';
import type { Store } from 'sentinel';

import type { HealthResponse } from '../types';

interface HealthDependencies {
  store: Store;
  generate: GenerateFunction | undefined;
}

export function createHealthRoutes(dependencies: HealthDependencies) {
  const app = new Hono();

  app.get('/live', (context) => {
    const body: HealthResponse = { status: 'ok' };
    return context.json(body, 200);
  });

  app.get('/ready', (context) => {
    const ready = dependencies.store !== undefined && dependencies.generate !== undefined;
    const body: HealthResponse = { status: ready ? 'ok' : 'unavailable' };
    return context.json(body, ready ? 200 : 503);
  });

  return app;
}
