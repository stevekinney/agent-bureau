import { Hono } from 'hono';

import type { ApiKeyStore } from '../keys/types';
import { createScopeGuard } from '../middleware/scope-guard';
import type { Bureau } from '../types';
import { SCOPE } from '../types';
import { createConfigurationRoutes } from './configuration';
import { createConversationsRoutes } from './conversations';
import { createHealthRoutes } from './health';
import { createKeysRoutes } from './keys';
import { createRunsRoutes } from './runs';
import { createSchedulerRoutes } from './scheduler';

type CreateRoutesOptions = {
  bureau: Bureau;
  apiKeyStore?: ApiKeyStore;
};

export function createRoutes({ bureau, apiKeyStore }: CreateRoutesOptions) {
  const app = new Hono();

  app.route('/api/v1/health', createHealthRoutes(bureau));

  // Runs routes with scope guards
  const runsRouter = new Hono();
  runsRouter.get('*', createScopeGuard([SCOPE.RUNS_READ]));
  runsRouter.post('*', createScopeGuard([SCOPE.RUNS_WRITE]));
  runsRouter.delete('*', createScopeGuard([SCOPE.RUNS_WRITE]));
  runsRouter.route('/', createRunsRoutes(bureau));
  app.route('/api/v1/runs', runsRouter);

  // Conversations routes with scope guards
  const conversationsRouter = new Hono();
  conversationsRouter.get('*', createScopeGuard([SCOPE.CONVERSATIONS_READ]));
  conversationsRouter.delete('*', createScopeGuard([SCOPE.CONVERSATIONS_WRITE]));
  conversationsRouter.route('/', createConversationsRoutes(bureau));
  app.route('/api/v1/conversations', conversationsRouter);

  // Configuration routes with scope guard
  const configRouter = new Hono();
  configRouter.get('*', createScopeGuard([SCOPE.CONFIG_READ]));
  configRouter.route('/', createConfigurationRoutes(bureau));
  app.route('/api/v1/configuration', configRouter);

  app.route('/api/v1/scheduler', createSchedulerRoutes(bureau.scheduler));

  // Key management routes (only when key store is available)
  if (apiKeyStore) {
    const keysRouter = new Hono();
    keysRouter.use('*', createScopeGuard([SCOPE.KEYS_MANAGE]));
    keysRouter.route('/', createKeysRoutes(apiKeyStore));
    app.route('/api/v1/keys', keysRouter);
  }

  return app;
}
