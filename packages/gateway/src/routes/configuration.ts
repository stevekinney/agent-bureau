import { Hono } from 'hono';

import type { Bureau } from '../types';

export function createConfigurationRoutes(bureau: Bureau) {
  const app = new Hono();

  app.get('/', (context) => {
    return context.json(bureau.getConfiguration(), 200);
  });

  app.get('/tools', (context) => {
    return context.json(bureau.getTools(), 200);
  });

  return app;
}
