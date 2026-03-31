import { Hono } from 'hono';

import { ALL_RUNS_SUBSCRIPTION, type LiveFrameBroker } from '../live-events';
import type { Bureau, ServerFrame } from '../types';

function collectRunIds(url: URL): string[] {
  const runIds = url.searchParams.getAll('runId').filter(Boolean);

  if (runIds.length === 0) {
    return [ALL_RUNS_SUBSCRIPTION];
  }

  return [...new Set(runIds)];
}

/**
 * Creates an SSE endpoint that streams normalized live frames for one or more runs.
 */
export function createEventsRoutes(bureau: Bureau, broker: LiveFrameBroker) {
  const app = new Hono();

  app.get('/', (context) => {
    const url = new URL(context.req.url);
    const runIds = collectRunIds(url);
    const includeScheduler = url.searchParams.get('scheduler') === 'true';
    const initialFrames: ServerFrame[] = [];

    if (includeScheduler && bureau.scheduler) {
      initialFrames.push({
        type: 'scheduler.state',
        state: bureau.scheduler.getState(),
      });
    }

    return broker.createEventStreamResponse(context.req.raw, {
      runIds,
      includeScheduler,
      initialFrames,
    });
  });

  return app;
}
