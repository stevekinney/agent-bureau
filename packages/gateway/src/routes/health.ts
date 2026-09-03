import { Hono } from 'hono';

import type { LiveFrameBroker } from '../live-events';
import type { Bureau, HealthResponse, ReadyResponse } from '../types';

export function createHealthRoutes(bureau: Bureau, broker: LiveFrameBroker) {
  const app = new Hono();

  app.get('/live', (context) => {
    const body: HealthResponse = { status: 'ok' };
    return context.json(body, 200);
  });

  app.get('/ready', (context) => {
    const bureauSubsystem: ReadyResponse['subsystems']['bureau'] = bureau.ready
      ? 'ok'
      : 'unavailable';

    let total = 0;
    let late = 0;
    let unreachable = 0;
    for (const connection of broker.getConnectionRegistry().values()) {
      total += 1;
      const { reachability } = connection.snapshot();
      if (reachability === 'late') {
        late += 1;
      } else if (reachability === 'unreachable') {
        unreachable += 1;
      }
    }

    // AB-219: no regression on the existing `bureau.ready` -> 503 contract.
    // `'degraded'` is additive and always returns 200 — a consumer that
    // only checks the HTTP status code observes no new failure mode.
    const status: ReadyResponse['status'] =
      bureauSubsystem === 'unavailable' ? 'unavailable' : unreachable > 0 ? 'degraded' : 'ok';

    const body: ReadyResponse = {
      status,
      subsystems: {
        bureau: bureauSubsystem,
        connections: { total, late, unreachable },
      },
    };

    return context.json(body, bureauSubsystem === 'unavailable' ? 503 : 200);
  });

  return app;
}
