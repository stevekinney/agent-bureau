import { Hono } from 'hono';

import type { Bureau } from '../types';
import { respondWithEventHistoryPage } from './event-history';

/**
 * `GET /api/v1/schedules/:id/events` — durable event-history paging for a
 * schedule's own DEFINITION events (`schedule.created`/`paused`/`resumed`/
 * `cancelled`, AB-320) — never a fire, which stays on the fired run's own
 * `{ kind: 'run', id: runId }` owner ("a schedule fire is an ordinary run",
 * AB-87). This is its own small router (AB-312's coordinator amendment)
 * because `createSchedulesRoutes` (`schedules.ts`) is mounted at `/schedules`,
 * not `/api/v1/schedules` — the coordinator's specified path for this
 * route — so it cannot simply be added there without also moving every
 * other schedule route's own path (out of scope here).
 */
export function createScheduleEventsRoutes(bureau: Bureau) {
  const app = new Hono();

  app.get('/:id/events', (context) =>
    respondWithEventHistoryPage(context, bureau, { kind: 'schedule', id: context.req.param('id') }),
  );

  return app;
}
