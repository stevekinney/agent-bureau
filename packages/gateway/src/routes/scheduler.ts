import { Hono } from 'hono';
import type { Scheduler } from 'operative';

/**
 * Creates HTTP routes for scheduler state inspection and manual task submission.
 */
export function createSchedulerRoutes(scheduler: Scheduler | undefined) {
  const app = new Hono();

  app.get('/', (context) => {
    if (!scheduler) {
      return context.json(
        { error: { code: 'NOT_CONFIGURED', message: 'Scheduler not configured' } },
        501,
      );
    }
    return context.json(scheduler.getState());
  });

  app.post('/heartbeat', (context) => {
    if (!scheduler) {
      return context.json(
        { error: { code: 'NOT_CONFIGURED', message: 'Scheduler not configured' } },
        501,
      );
    }
    // The heartbeat route is a no-op placeholder — the heartbeat system
    // manages its own ticking. This route exists for future manual triggering.
    return context.json({ message: 'Heartbeat not configured via this endpoint' }, 200);
  });

  return app;
}
