import { BureauError } from 'bureau';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';

import { resolvePrincipal } from '../middleware/authentication';
import { assembleRunTimeline } from '../timeline';
import type { Bureau, CreateRunRequest, PendingReview, RunDetail } from '../types';

export { assembleRunTimeline, type RunTimelineEntry, type RunTimelineEntryKind } from '../timeline';

export function createRunsRoutes(bureau: Bureau) {
  const app = new Hono();

  app.post('/', async (context) => {
    let body: CreateRunRequest;
    try {
      body = await context.req.json<CreateRunRequest>();
    } catch {
      throw new HTTPException(400, { message: 'Invalid JSON body' });
    }
    try {
      // Overwrite any caller-supplied `principal` with the authenticated
      // principal from the verified request header — never trust it from an
      // untrusted request body (AB-54 usage analytics attribution).
      const summary = await bureau.createRun({ ...body, principal: resolvePrincipal(context) });
      return context.json(summary, 201);
    } catch (error) {
      if (error instanceof BureauError) {
        if (error.code === 'NOT_CONFIGURED')
          throw new HTTPException(503, { message: error.message });
        if (error.code === 'BAD_REQUEST') throw new HTTPException(400, { message: error.message });
        // AB-13 — a flow-control policy (concurrency cap, rate limit, or
        // singleton dedupe) rejected this run's admission.
        if (error.code === 'RATE_LIMITED') throw new HTTPException(429, { message: error.message });
      }
      throw error;
    }
  });

  app.get('/', (context) => {
    const status = context.req.query('status');
    return context.json(bureau.listRuns(status), 200);
  });

  app.get('/:id', (context) => {
    const detail = buildRunDetailResponse(bureau, context.req.param('id'));
    if (!detail) throw new HTTPException(404, { message: 'Run not found' });
    return context.json(detail, 200);
  });

  app.post('/:id/abort', (context) => {
    try {
      const run = bureau.abortRun(context.req.param('id'));
      return context.json(run, 200);
    } catch (error) {
      if (error instanceof BureauError) {
        if (error.code === 'NOT_FOUND') throw new HTTPException(404, { message: error.message });
        if (error.code === 'CONFLICT') throw new HTTPException(409, { message: error.message });
      }
      throw error;
    }
  });

  app.delete('/:id', (context) => {
    try {
      bureau.deleteRun(context.req.param('id'));
      return context.body(null, 204);
    } catch (error) {
      if (error instanceof BureauError) {
        if (error.code === 'NOT_FOUND') throw new HTTPException(404, { message: error.message });
        if (error.code === 'CONFLICT') throw new HTTPException(409, { message: error.message });
      }
      throw error;
    }
  });

  return app;
}

// ── Shared response builder (used by both the JSON route and the SSR /runs/:id page) ──

export interface RunDetailResponse extends RunDetail {
  timeline: ReturnType<typeof assembleRunTimeline>;
}

/**
 * Finds the pending human-wait review (if any) parking `runId` — the resume
 * affordance the run-detail view offers a parked run, reusing AB-20's review
 * queue plumbing (`Bureau.listPendingReviews`/`resolveReview`) rather than
 * inventing a second resume path. `undefined` when the run is not currently
 * parked on a human-wait signal (including tool-approval parks, which have
 * no `runId`-scoped signal to resume via this affordance).
 */
export function findParkedReview(
  reviews: readonly PendingReview[],
  runId: string,
): PendingReview | undefined {
  return reviews.find((review) => review.kind === 'human-wait' && review.runId === runId);
}

/**
 * Builds the full run-detail response — the run record plus its assembled
 * timeline — shared by `GET /api/v1/runs/:id` and the SSR `/runs/:id` page
 * (`server/pages.ts`) so both surfaces agree on shape. `undefined` when the
 * run does not exist.
 */
export function buildRunDetailResponse(bureau: Bureau, id: string): RunDetailResponse | undefined {
  const run = bureau.getRun(id);
  if (!run) return undefined;
  return { ...run, timeline: assembleRunTimeline(run.events) };
}
