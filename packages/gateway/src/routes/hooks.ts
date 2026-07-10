import { BureauError } from 'bureau';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';

import { resolvePrincipal } from '../middleware/authentication';
import type { Bureau, CreateRunRequest } from '../types';

/**
 * Webhook ingress routes — typed dispatch endpoints.
 *
 * Callers MUST name the agent explicitly via the `?agent=<name>` query
 * parameter. No default-agent fallback, no binding table, no routing logic.
 *
 * Each request is idempotency-keyed via the `Idempotency-Key` header. When
 * present, a duplicate key within the same process is rejected with 409; the
 * bureau-level run store is the authority on duplicate detection.
 *
 * `POST /hooks/*` — fires a run synchronously and returns the run summary.
 * The session is named via the optional `?session=<id>` query parameter; omit
 * it for a fresh anonymous session.
 */
export function createHooksRoutes(bureau: Bureau) {
  const app = new Hono();

  /** Tracks in-flight idempotency keys to reject duplicates. */
  const idempotencyKeys = new Set<string>();

  app.post('/*', async (context) => {
    // ── Agent name ─────────────────────────────────────────────────────
    // The caller MUST supply the agent name. There is no default; the
    // gateway never resolves which agent to use on the caller's behalf.
    const agentName = context.req.query('agent');
    if (!agentName || agentName.trim().length === 0) {
      throw new HTTPException(422, {
        message: 'Missing required query parameter: agent. Callers must name the agent explicitly.',
      });
    }

    // ── Idempotency ────────────────────────────────────────────────────
    // Reserve the key synchronously before the first await so that concurrent
    // requests with the same key cannot both pass the check before either adds
    // it (TOCTOU race). The key is released in the catch block on any failure,
    // so a corrected retry with the same key is never spuriously rejected.
    const idempotencyKey = context.req.header('Idempotency-Key');
    if (idempotencyKey) {
      if (idempotencyKeys.has(idempotencyKey)) {
        throw new HTTPException(409, {
          message: `Duplicate idempotency key: ${idempotencyKey}`,
        });
      }
      idempotencyKeys.add(idempotencyKey);
    }

    try {
      // ── Request body ─────────────────────────────────────────────────
      let body: Record<string, unknown>;
      try {
        body = await context.req.json<Record<string, unknown>>();
      } catch {
        throw new HTTPException(400, { message: 'Invalid JSON body' });
      }

      const message = body['message'];
      if (!message || typeof message !== 'string') {
        throw new HTTPException(400, { message: 'Request body must include a "message" string' });
      }

      const sessionId = (context.req.query('session') ?? body['sessionId']) as string | undefined;

      const request: CreateRunRequest = {
        message,
        agentName: agentName.trim(),
        principal: resolvePrincipal(context),
        ...(sessionId ? { sessionId } : {}),
        ...(typeof body['systemPrompt'] === 'string' ? { systemPrompt: body['systemPrompt'] } : {}),
        ...(typeof body['maximumSteps'] === 'number' ? { maximumSteps: body['maximumSteps'] } : {}),
      };

      const summary = await bureau.createRun(request);
      return context.json(summary, 202);
    } catch (error) {
      // Release the idempotency key on any failure so the caller can retry with
      // the same key after correcting the request (invalid body, bad message,
      // bureau errors, etc.).
      if (idempotencyKey) {
        idempotencyKeys.delete(idempotencyKey);
      }
      if (error instanceof BureauError) {
        if (error.code === 'NOT_CONFIGURED') {
          throw new HTTPException(503, { message: error.message });
        }
        if (error.code === 'BAD_REQUEST') {
          throw new HTTPException(400, { message: error.message });
        }
        if (error.code === 'NOT_FOUND') {
          throw new HTTPException(404, { message: error.message });
        }
        // AB-13 — a flow-control policy (concurrency cap, rate limit, or
        // singleton dedupe) rejected this run's admission.
        if (error.code === 'RATE_LIMITED') {
          throw new HTTPException(429, { message: error.message });
        }
      }
      throw error;
    }
  });

  return app;
}
