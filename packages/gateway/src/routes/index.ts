import { Hono } from 'hono';

import type { Bureau } from '../types';
import { createConfigurationRoutes } from './configuration';
import { createConversationsRoutes } from './conversations';
import { createHealthRoutes } from './health';
import { createRunsRoutes } from './runs';

export function createRoutes(bureau: Bureau) {
  const app = new Hono();

  app.route('/api/v1/health', createHealthRoutes(bureau));
  app.route('/api/v1/runs', createRunsRoutes(bureau));
  app.route('/api/v1/conversations', createConversationsRoutes(bureau));
  app.route('/api/v1/configuration', createConfigurationRoutes(bureau));

  return app;
}
