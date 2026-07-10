/**
 * Review queue routes (AB-20): parked runs awaiting human review — armorer's
 * `needs_approval` tool-approval flow AND durable `requestHumanInput`
 * (`ctx.waitForSignal`) waits.
 *
 * - `GET /api/v1/reviews` — list every pending review (both kinds).
 * - `POST /api/v1/reviews/:id/approve` — resume the parked run (executes the
 *   tool for a `tool-approval`, delivers the signal for a `human-wait`).
 * - `POST /api/v1/reviews/:id/deny` — record the decision without resuming.
 *
 * Both mutating routes attribute the decision to the authenticated principal
 * (the `x-auth-principal` header the authentication middleware injects) and
 * record it in the bureau's audit trail via `Bureau.resolveReview`.
 */
import { BureauError } from 'bureau';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';

import { resolvePrincipal } from '../middleware/authentication';
import type { Bureau } from '../types';

const approveBodySchema = z
  .object({
    arguments: z.unknown(),
    payload: z.unknown(),
    reason: z.string().optional(),
  })
  .partial();

const denyBodySchema = z
  .object({
    reason: z.string().optional(),
  })
  .partial();

/**
 * Parses and validates a mutating review route's JSON body against `schema`.
 * Rejects with `400` for both malformed JSON AND a syntactically valid but
 * non-object payload (e.g. `null`, `"hi"`, `[]`) — the boundary check the
 * route bodies (which dereference fields like `body.payload` directly) rely
 * on to never see a shape they can't index into.
 */
async function parseReviewBody<TSchema extends z.ZodTypeAny>(
  context: { req: { text(): Promise<string> } },
  schema: TSchema,
): Promise<z.infer<TSchema>> {
  const rawBody = await context.req.text();
  if (rawBody.length === 0) {
    return schema.parse({});
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    throw new HTTPException(400, { message: 'Invalid JSON body' });
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new HTTPException(400, { message: 'Request body must be a JSON object' });
  }
  return result.data;
}

function toHttpException(error: unknown): HTTPException {
  if (error instanceof BureauError) {
    if (error.code === 'NOT_FOUND') return new HTTPException(404, { message: error.message });
    if (error.code === 'NOT_CONFIGURED') return new HTTPException(503, { message: error.message });
    if (error.code === 'BAD_REQUEST') return new HTTPException(400, { message: error.message });
    if (error.code === 'CONFLICT') return new HTTPException(409, { message: error.message });
  }
  return new HTTPException(500, {
    message: error instanceof Error ? error.message : String(error),
  });
}

export function createReviewsRoutes(bureau: Bureau) {
  const app = new Hono();

  app.get('/', (context) => {
    return context.json(bureau.listPendingReviews(), 200);
  });

  app.post('/:id/approve', async (context) => {
    const id = context.req.param('id');
    const body = await parseReviewBody(context, approveBodySchema);

    try {
      const outcome = await bureau.resolveReview({
        id,
        decision: 'approve',
        principal: resolvePrincipal(context),
        ...(Object.prototype.hasOwnProperty.call(body, 'arguments')
          ? { arguments: body.arguments }
          : {}),
        ...(body.payload !== undefined ? { payload: body.payload } : {}),
        ...(body.reason !== undefined ? { reason: body.reason } : {}),
      });
      return context.json(outcome, 200);
    } catch (error) {
      throw toHttpException(error);
    }
  });

  app.post('/:id/deny', async (context) => {
    const id = context.req.param('id');
    const body = await parseReviewBody(context, denyBodySchema);

    try {
      const outcome = await bureau.resolveReview({
        id,
        decision: 'deny',
        principal: resolvePrincipal(context),
        ...(body.reason !== undefined ? { reason: body.reason } : {}),
      });
      return context.json(outcome, 200);
    } catch (error) {
      throw toHttpException(error);
    }
  });

  return app;
}
