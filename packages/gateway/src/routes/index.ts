import { Hono } from 'hono';

import type { ApiKeyStore } from '../keys/types';
import type { LiveFrameBroker } from '../live-events';
import { createScopeGuard } from '../middleware/scope-guard';
import type { Bureau } from '../types';
import { SCOPE } from '../types';
import { createAuditRoutes, createConversationRoutes, createMemoryRoutes } from './audit';
import { createConfigurationRoutes } from './configuration';
import { createEventsRoutes } from './events';
import { createHealthRoutes } from './health';
import { createHooksRoutes } from './hooks';
import { createKeysRoutes } from './keys';
import { createOpenAICompatRoutes } from './openai-compat';
import { createReviewsRoutes } from './reviews';
import { createRunsRoutes } from './runs';
import { createSchedulerRoutes } from './scheduler';
import { createSchedulesRoutes } from './schedules';
import { createSessionsRoutes } from './sessions';
import { createUsageRoutes } from './usage';

type CreateRoutesOptions = {
  bureau: Bureau;
  broker: LiveFrameBroker;
  apiKeyStore?: ApiKeyStore;
};

export function createRoutes({ bureau, broker, apiKeyStore }: CreateRoutesOptions) {
  const app = new Hono();

  app.route('/api/v1/health', createHealthRoutes(bureau));

  // ── Audit glass-box: Layer A + Layer B (G5) ─────────────────────────

  // Layer B: `GET /api/v1/audit` — durable trail + live store merge.
  const auditRouter = new Hono();
  auditRouter.get('*', createScopeGuard([SCOPE.SESSIONS_READ]));
  auditRouter.route('/', createAuditRoutes(bureau));
  app.route('/api/v1/audit', auditRouter);

  // Layer A: `GET /api/v1/sessions/:id/conversation` — conversation history.
  // Layered on top of the sessions router (same scope guard applies).
  const conversationRouter = new Hono();
  conversationRouter.get('*', createScopeGuard([SCOPE.SESSIONS_READ]));
  conversationRouter.route('/', createConversationRoutes(bureau));
  app.route('/api/v1/sessions', conversationRouter);

  // Layer A: `GET /api/v1/memory/:namespace` — memory namespace listing.
  const memoryRouter = new Hono();
  memoryRouter.get('*', createScopeGuard([SCOPE.SESSIONS_READ]));
  memoryRouter.route('/', createMemoryRoutes(bureau));
  app.route('/api/v1/memory', memoryRouter);

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
  sessionsRouter.post('*', createScopeGuard([SCOPE.SESSIONS_WRITE]));
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

  // Review queue routes (AB-20): parked tool approvals + human-input waits.
  const reviewsRouter = new Hono();
  reviewsRouter.get('*', createScopeGuard([SCOPE.REVIEWS_READ]));
  reviewsRouter.post('*', createScopeGuard([SCOPE.REVIEWS_WRITE]));
  reviewsRouter.route('/', createReviewsRoutes(bureau));
  app.route('/api/v1/reviews', reviewsRouter);

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

  // Usage/cost accounting (PTDR observability — Layer A live data).
  const usageRouter = new Hono();
  usageRouter.get('*', createScopeGuard([SCOPE.RUNS_READ]));
  usageRouter.route('/', createUsageRoutes(bureau));
  app.route('/api/v1/usage', usageRouter);

  // Durable schedules management.
  const schedulesRouter = new Hono();
  schedulesRouter.get('*', createScopeGuard([SCOPE.SCHEDULES_READ]));
  schedulesRouter.post('*', createScopeGuard([SCOPE.SCHEDULES_WRITE]));
  schedulesRouter.delete('*', createScopeGuard([SCOPE.SCHEDULES_WRITE]));
  schedulesRouter.route('/', createSchedulesRoutes(bureau));
  app.route('/schedules', schedulesRouter);

  return app;
}
