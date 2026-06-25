import { Hono } from 'hono';

import type { Bureau } from '../types';

/**
 * Creates the usage/cost accounting routes.
 *
 * `GET /usage` — returns aggregated token usage across all runs, plus a
 * per-run breakdown. This is the PTDR (paid ÷ delivered) observability surface
 * from the G2 cancellation work, exposed over the door (folds into audit Layer B).
 *
 * The data comes from the in-memory `bureau.listRuns()` surface (Layer A: live).
 * A durable audit trail (Layer B) is a future addition once the persistent sink
 * for `tool.*` events is wired.
 *
 * Query parameters:
 * - `status` — filter runs by status (matches the existing `listRuns` filter).
 * - `sessionId` — filter to runs belonging to a specific session.
 */
export function createUsageRoutes(bureau: Bureau) {
  const app = new Hono();

  app.get('/', (context) => {
    const statusFilter = context.req.query('status');
    const sessionIdFilter = context.req.query('sessionId');

    const runs = bureau.listRuns(statusFilter);

    const filtered = sessionIdFilter ? runs.filter((r) => r.sessionId === sessionIdFilter) : runs;

    const aggregate = filtered.reduce(
      (acc, run) => {
        acc.promptTokens += run.usage?.prompt ?? 0;
        acc.completionTokens += run.usage?.completion ?? 0;
        acc.totalTokens += run.usage?.total ?? 0;
        acc.runCount += 1;
        return acc;
      },
      { promptTokens: 0, completionTokens: 0, totalTokens: 0, runCount: 0 },
    );

    return context.json(
      {
        aggregate,
        runs: filtered.map((run) => ({
          runId: run.id,
          sessionId: run.sessionId,
          status: run.status,
          usage: {
            promptTokens: run.usage?.prompt ?? 0,
            completionTokens: run.usage?.completion ?? 0,
            totalTokens: run.usage?.total ?? 0,
          },
          steps: run.steps,
        })),
      },
      200,
    );
  });

  return app;
}
