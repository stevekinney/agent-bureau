import { BureauError } from 'bureau';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';

import type { Bureau } from '../types';

/**
 * `list`/`get`/`delete` below reach NOT_CONFIGURED only via `requireSessionStore()`
 * (subject: 'persistence' — 503, an operator-fixable misconfiguration, see #254).
 * `signal`/`update`/`query` reach it only via the `!runtime.durable` guard
 * (subject: 'durable' — 501, this deployment does not compose the capability at
 * all). A durable engine cannot exist without a session store
 * (runtime-composition.ts: `durable` ⟹ `durableStorage` ⟹ `kv` ⟹ `sessionStore`),
 * so `requireSessionStore()` can never throw once the durable guard has passed —
 * do not add a 503 branch to signal/update/query for that reason (see PR #259).
 */
export function createSessionsRoutes(bureau: Bureau) {
  const app = new Hono();

  app.get('/', async (context) => {
    try {
      const sessions = await bureau.listSessions();
      return context.json(sessions, 200);
    } catch (error) {
      if (error instanceof BureauError && error.code === 'NOT_CONFIGURED') {
        throw new HTTPException(503, { message: error.message });
      }
      throw error;
    }
  });

  app.get('/:id', async (context) => {
    try {
      const session = await bureau.getSession(context.req.param('id'));
      if (!session) throw new HTTPException(404, { message: 'Session not found' });
      return context.json(session, 200);
    } catch (error) {
      if (error instanceof BureauError && error.code === 'NOT_CONFIGURED') {
        throw new HTTPException(503, { message: error.message });
      }
      throw error;
    }
  });

  app.delete('/:id', async (context) => {
    try {
      await bureau.deleteSession(context.req.param('id'));
      return context.body(null, 204);
    } catch (error) {
      if (error instanceof BureauError && error.code === 'NOT_CONFIGURED') {
        throw new HTTPException(503, { message: error.message });
      }
      throw error;
    }
  });

  /**
   * POST /sessions/:id/signal — fire-and-forget signal delivery to a session's
   * in-flight durable run. Releases a parked HITL workflow (`ctx.waitForSignal`)
   * or injects input into an in-flight step. Body: `{ name, payload? }`.
   *
   * Returns 202 on success; 404 when the session or its run is not found; 501
   * when no durable engine is configured.
   */
  app.post('/:id/signal', async (context) => {
    const sessionId = context.req.param('id');

    let body: { name?: unknown; payload?: unknown };
    try {
      body = await context.req.json();
    } catch {
      throw new HTTPException(400, { message: 'Invalid JSON body' });
    }

    if (!body.name || typeof body.name !== 'string') {
      throw new HTTPException(400, { message: '"name" must be a non-empty string' });
    }

    try {
      await bureau.signalSession(sessionId, body.name, body.payload);
      return context.json({ status: 'delivered', sessionId, name: body.name }, 202);
    } catch (error) {
      if (error instanceof BureauError) {
        if (error.code === 'NOT_FOUND') throw new HTTPException(404, { message: error.message });
        if (error.code === 'NOT_CONFIGURED')
          return context.json({ error: { code: 'NOT_CONFIGURED', message: error.message } }, 501);
      }
      throw error;
    }
  });

  /**
   * POST /sessions/:id/update — validated request/response update to a session's
   * in-flight durable run. Body: `{ name, payload? }`. Returns the update result.
   *
   * Returns 200 with `{ result }` on success; 404 when the session or its run is
   * not found; 501 when no durable engine is configured.
   */
  app.post('/:id/update', async (context) => {
    const sessionId = context.req.param('id');

    let body: { name?: unknown; payload?: unknown };
    try {
      body = await context.req.json();
    } catch {
      throw new HTTPException(400, { message: 'Invalid JSON body' });
    }

    if (!body.name || typeof body.name !== 'string') {
      throw new HTTPException(400, { message: '"name" must be a non-empty string' });
    }

    try {
      const result = await bureau.updateSession(sessionId, body.name, body.payload);
      return context.json({ result }, 200);
    } catch (error) {
      if (error instanceof BureauError) {
        if (error.code === 'NOT_FOUND') throw new HTTPException(404, { message: error.message });
        if (error.code === 'NOT_CONFIGURED')
          return context.json({ error: { code: 'NOT_CONFIGURED', message: error.message } }, 501);
      }
      throw error;
    }
  });

  /**
   * GET /sessions/:id/query — read-only live-state query against a session's
   * in-flight durable run. Query params: `name` (required), `input` (optional
   * JSON-encoded string). Returns `{ result }`.
   *
   * Returns 200 with `{ result }` on success; 400 when `name` is missing; 404
   * when the session or its run is not found; 501 when no durable engine is
   * configured.
   */
  app.get('/:id/query', async (context) => {
    const sessionId = context.req.param('id');
    const name = context.req.query('name');
    const rawInput = context.req.query('input');

    if (!name) {
      throw new HTTPException(400, { message: '"name" query parameter is required' });
    }

    let input: unknown;
    if (rawInput !== undefined) {
      try {
        input = JSON.parse(rawInput);
      } catch {
        throw new HTTPException(400, { message: '"input" must be valid JSON when provided' });
      }
    }

    try {
      const result = await bureau.querySession(sessionId, name, input);
      return context.json({ result }, 200);
    } catch (error) {
      if (error instanceof BureauError) {
        if (error.code === 'NOT_FOUND') throw new HTTPException(404, { message: error.message });
        if (error.code === 'NOT_CONFIGURED')
          return context.json({ error: { code: 'NOT_CONFIGURED', message: error.message } }, 501);
      }
      throw error;
    }
  });

  return app;
}
