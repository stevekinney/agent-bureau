import { BureauError } from 'bureau';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';

import type { Bureau } from '../types';

const CreateScheduleSchema = z.object({
  /** Human-readable operator label stored with the schedule. */
  description: z.string().min(1).optional(),
  /** Bureau agent name to run on each schedule fire. */
  agentName: z.string().min(1),
  /** Input message delivered to the agent each fire. */
  input: z.string().min(1),
  /**
   * Schedule specification. Accepts:
   * - Cron expression: `'0 9 * * *'`
   * - Duration shorthand for a fixed interval: `'6h'`, `'30s'`, `'5 minutes'`
   *   (weft's duration grammar; ISO-8601 like `'PT6H'` is not supported).
   */
  spec: z.string().min(1),
  /**
   * Session id for recurring-conversation semantics: each fire appends a run to
   * this session. When omitted, each fire is a fresh standalone session. Must be
   * non-empty when present (a blank id is rejected, not coerced to stateless).
   */
  sessionId: z.string().min(1).optional(),
  /** Overlap policy when a prior fire is still running. Defaults to `'skip'`. */
  overlap: z.enum(['skip', 'allow']).optional(),
});

/**
 * Creates the durable schedule management routes.
 *
 * All routes require a durable engine (`bureau.persistence` configured with a
 * `StorageConfiguration`). Routes return 501 when no engine is composed.
 *
 * - `POST   /schedules`        — register a new recurring schedule
 * - `GET    /schedules`        — list all schedules
 * - `GET    /schedules/:id`    — get a specific schedule
 * - `POST   /schedules/:id/pause`   — pause a schedule
 * - `POST   /schedules/:id/resume`  — resume a paused schedule
 * - `DELETE /schedules/:id`    — cancel and remove a schedule
 */
export function createSchedulesRoutes(bureau: Bureau) {
  const app = new Hono();

  app.post('/', async (context) => {
    let rawBody: unknown;
    try {
      rawBody = await context.req.json();
    } catch {
      throw new HTTPException(400, { message: 'Invalid JSON body' });
    }

    const parsed = CreateScheduleSchema.safeParse(rawBody);
    if (!parsed.success) {
      const fieldErrors = parsed.error.flatten().fieldErrors;
      const message = Object.entries(fieldErrors)
        .map(([field, errors]) => `${field}: ${errors?.join(', ') ?? 'invalid'}`)
        .join('; ');
      throw new HTTPException(400, { message: message || 'Invalid request body' });
    }

    let summary;
    try {
      summary = await bureau.createSchedule(parsed.data);
    } catch (error) {
      if (error instanceof BureauError) {
        // A durable bureau with no generate configured rejects NOT_CONFIGURED
        // rather than register a schedule whose every fire would fail. Surface it
        // the same way the no-durable-engine case below does (501 NOT_CONFIGURED).
        if (error.code === 'NOT_CONFIGURED') {
          return context.json({ error: { code: 'NOT_CONFIGURED', message: error.message } }, 501);
        }
        // Incoherent definitions (blank recurring sessionId, overlap 'allow' with a
        // recurring sessionId) reject BAD_REQUEST → 400, matching the runs route.
        if (error.code === 'BAD_REQUEST') {
          throw new HTTPException(400, { message: error.message });
        }
      }
      throw error;
    }
    if (summary === undefined) {
      return context.json(
        { error: { code: 'NOT_CONFIGURED', message: 'Durable engine not configured' } },
        501,
      );
    }

    return context.json(summary, 201);
  });

  app.get('/', async (context) => {
    const result = await bureau.listSchedules();
    if (result === undefined) {
      return context.json(
        { error: { code: 'NOT_CONFIGURED', message: 'Durable engine not configured' } },
        501,
      );
    }
    return context.json(result, 200);
  });

  app.get('/:id', async (context) => {
    const summary = await bureau.getSchedule(context.req.param('id'));
    if (summary === undefined) {
      return context.json(
        { error: { code: 'NOT_CONFIGURED', message: 'Durable engine not configured' } },
        501,
      );
    }
    if (summary === null) {
      throw new HTTPException(404, { message: 'Schedule not found' });
    }
    return context.json(summary, 200);
  });

  app.post('/:id/pause', async (context) => {
    const result = await bureau.pauseSchedule(context.req.param('id'));
    if (result === undefined) {
      return context.json(
        { error: { code: 'NOT_CONFIGURED', message: 'Durable engine not configured' } },
        501,
      );
    }
    return context.json({ status: 'paused' }, 200);
  });

  app.post('/:id/resume', async (context) => {
    const result = await bureau.resumeSchedule(context.req.param('id'));
    if (result === undefined) {
      return context.json(
        { error: { code: 'NOT_CONFIGURED', message: 'Durable engine not configured' } },
        501,
      );
    }
    return context.json({ status: 'resumed' }, 200);
  });

  app.delete('/:id', async (context) => {
    const result = await bureau.cancelSchedule(context.req.param('id'));
    if (result === undefined) {
      return context.json(
        { error: { code: 'NOT_CONFIGURED', message: 'Durable engine not configured' } },
        501,
      );
    }
    return context.body(null, 204);
  });

  return app;
}
