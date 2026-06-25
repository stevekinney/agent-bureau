import { Hono } from 'hono';

import type { ApiKeyStore } from '../keys/types';
import type { LiveFrameBroker } from '../live-events';
import { createScopeGuard } from '../middleware/scope-guard';
import type { Bureau } from '../types';
import { SCOPE } from '../types';
import { createConfigurationRoutes } from './configuration';
import { createEventsRoutes } from './events';
import { createHealthRoutes } from './health';
import { createHooksRoutes } from './hooks';
import { createKeysRoutes } from './keys';
import { createOpenAICompatRoutes } from './openai-compat';
import { createRunsRoutes } from './runs';
import { createSchedulerRoutes } from './scheduler';
import { createSessionsRoutes } from './sessions';

type CreateRoutesOptions = {
  bureau: Bureau;
  broker: LiveFrameBroker;
  apiKeyStore?: ApiKeyStore;
};

export function createRoutes({ bureau, broker, apiKeyStore }: CreateRoutesOptions) {
  const app = new Hono();

  app.route('/api/v1/health', createHealthRoutes(bureau));

  // Runs routes with scope guards
  const runsRouter = new Hono();
  runsRouter.get('*', createScopeGuard([SCOPE.RUNS_READ]));
  runsRouter.post('*', createScopeGuard([SCOPE.RUNS_WRITE]));
  runsRouter.delete('*', createScopeGuard([SCOPE.RUNS_WRITE]));
  runsRouter.route('/', createRunsRoutes(bureau));
  app.route('/api/v1/runs', runsRouter);

  // Session routes with scope guards
  const sessionsRouter = new Hono();
  sessionsRouter.get('*', createScopeGuard([SCOPE.SESSIONS_READ]));
  sessionsRouter.delete('*', createScopeGuard([SCOPE.SESSIONS_WRITE]));
  sessionsRouter.route('/', createSessionsRoutes(bureau));
  app.route('/api/v1/sessions', sessionsRouter);

  // Configuration routes with scope guard
  const configRouter = new Hono();
  configRouter.get('*', createScopeGuard([SCOPE.CONFIG_READ]));
  configRouter.route('/', createConfigurationRoutes(bureau));
  app.route('/api/v1/configuration', configRouter);

  const eventsRouter = new Hono();
  eventsRouter.get('*', createScopeGuard([SCOPE.RUNS_READ]));
  eventsRouter.route('/', createEventsRoutes(bureau, broker));
  app.route('/api/v1/events', eventsRouter);

  const schedulerRouter = new Hono();
  schedulerRouter.get('*', createScopeGuard([SCOPE.RUNS_READ]));
  schedulerRouter.post('*', createScopeGuard([SCOPE.RUNS_WRITE]));
  schedulerRouter.delete('*', createScopeGuard([SCOPE.RUNS_WRITE]));
  schedulerRouter.route(
    '/',
    createSchedulerRoutes(bureau.scheduler, (request) => bureau.submitSchedulerTask(request)),
  );
  app.route('/api/v1/scheduler', schedulerRouter);

  // Key management routes (only when key store is available)
  if (apiKeyStore) {
    const keysRouter = new Hono();
    keysRouter.use('*', createScopeGuard([SCOPE.KEYS_MANAGE]));
    keysRouter.route('/', createKeysRoutes(apiKeyStore));
    app.route('/api/v1/keys', keysRouter);
  }

  // Webhook ingress — typed dispatch endpoints.
  // Caller MUST name the agent explicitly via ?agent=<name>; no routing, no
  // default-agent fallback. The HOOKS_WRITE scope guards these routes.
  const hooksRouter = new Hono();
  hooksRouter.post('*', createScopeGuard([SCOPE.HOOKS_WRITE]));
  hooksRouter.route('/', createHooksRoutes(bureau));
  app.route('/hooks', hooksRouter);

  // OpenAI-compatible chat completions endpoint.
  // The `model` field in the request body carries the agent name — typed
  // dispatch with no routing. Uses the same RUNS_WRITE scope as direct runs.
  const openaiRouter = new Hono();
  openaiRouter.post('*', createScopeGuard([SCOPE.RUNS_WRITE]));
  openaiRouter.route('/', createOpenAICompatRoutes(bureau));
  app.route('/v1', openaiRouter);

  return app;
}
