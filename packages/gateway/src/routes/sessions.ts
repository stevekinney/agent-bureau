import type {
  SessionInputDeliveryMode,
  UserAdmissibleContent,
} from '@lostgradient/operative/durable';
import { BureauError } from 'bureau';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';

import { resolvePrincipal } from '../middleware/authentication';
import type { Bureau, SessionInputAdmissionOutcome, SessionInputAdmissionRequest } from '../types';

/**
 * AB-196 — runtime enforcement of the AB-42/AB-202 payload allowlist:
 * `TextContent` (citations forbidden — structurally excluded, not merely
 * dropped, matching `UserAdmissibleContent`'s `citations?: never`),
 * `ImageContent`, and `DocumentContent`. Every other `MultiModalContent`
 * variant (`thinking`, `redacted_thinking`, `server_tool_use`,
 * `web_search_tool_result`, the code-execution/web-fetch result kinds,
 * `container_upload`) fails to match any branch of this discriminated union
 * and is rejected with 400 before `submitSessionInput` is ever called. See
 * `documentation/operative-type-safe-api.md`'s "Session input admission"
 * section, "User-admissible payload only".
 */
const userAdmissibleContentSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('text'),
      text: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal('image'),
      url: z.string().url(),
      mimeType: z.string().optional(),
      text: z.string().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('document'),
      name: z.string().min(1),
      mimeType: z.string().min(1),
      source: z.discriminatedUnion('kind', [
        z
          .object({
            kind: z.literal('base64'),
            data: z.string().min(1),
          })
          .strict(),
        z
          .object({
            kind: z.literal('reference'),
            uri: z.string().min(1),
          })
          .strict(),
      ]),
    })
    .strict(),
]) satisfies z.ZodType<UserAdmissibleContent>;

const sessionInputDeliveryModeSchema = z.enum([
  'steer',
  'queue',
]) satisfies z.ZodType<SessionInputDeliveryMode>;

/**
 * AB-196 — `POST /:id/input`'s body schema: `SessionInputAdmissionRequest`
 * minus `principal`. Deliberately not `.strict()`: a body-supplied
 * `principal` (or any other unknown field) is accepted by the schema and
 * then silently stripped by plain `z.object` parsing, never reaching
 * `SessionInputAdmissionRequest` — the route always sets `principal` from
 * `resolvePrincipal(context)` afterward, matching `hooks.ts:152`'s
 * convention. This is what the acceptance criterion means by "ignored/
 * overwritten, never trusted": a spoofed `principal` in the body has no
 * effect on the resolved caller identity, rather than failing the request.
 */
const sessionInputAdmissionRequestBodySchema = z.object({
  id: z.string().min(1).optional(),
  deliveryMode: sessionInputDeliveryModeSchema,
  payload: z.union([z.string(), z.array(userAdmissibleContentSchema)]),
  expiresAt: z.string().min(1).optional(),
  supersedes: z.string().min(1).optional(),
}) satisfies z.ZodType<Omit<SessionInputAdmissionRequest, 'principal'>>;

function parseNonNegativeInteger(value: string | undefined, name: string, allowZero: boolean) {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) {
    throw new HTTPException(400, {
      message: `"${name}" must be a ${allowZero ? 'non-negative' : 'positive'} integer`,
    });
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || (!allowZero && parsed === 0)) {
    throw new HTTPException(400, {
      message: `"${name}" must be a ${allowZero ? 'non-negative' : 'positive'} integer`,
    });
  }
  return parsed;
}

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
      const limit = parseNonNegativeInteger(context.req.query('limit'), 'limit', false);
      const offset = parseNonNegativeInteger(context.req.query('offset'), 'offset', true);
      const sessions = await bureau.listSessions({ limit, offset });
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
        if (error.code === 'CONFLICT') throw new HTTPException(409, { message: error.message });
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
   * not found; 501 when no durable engine is configured, OR when a durable
   * engine IS configured (AB-192: the built-in `agentRun` workflow registers
   * no `ctx.onUpdate` handler, so this always rejects with `UNSUPPORTED_CAPABILITY`).
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
        if (error.code === 'CONFLICT') throw new HTTPException(409, { message: error.message });
        if (error.code === 'NOT_CONFIGURED')
          return context.json({ error: { code: 'NOT_CONFIGURED', message: error.message } }, 501);
        if (error.code === 'UNSUPPORTED_CAPABILITY')
          return context.json(
            { error: { code: 'UNSUPPORTED_CAPABILITY', message: error.message } },
            501,
          );
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
   * configured, OR when a durable engine IS configured (AB-192: the built-in
   * `agentRun` workflow registers no `ctx.onQuery` handler, so this always
   * rejects with `UNSUPPORTED_CAPABILITY`).
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
        if (error.code === 'UNSUPPORTED_CAPABILITY')
          return context.json(
            { error: { code: 'UNSUPPORTED_CAPABILITY', message: error.message } },
            501,
          );
      }
      throw error;
    }
  });

  /**
   * POST /sessions/:id/input — admit a caller's session input (AB-42/AB-194,
   * gateway wiring per AB-196). Validates the body against
   * {@link sessionInputAdmissionRequestBodySchema} first — a schema-validation
   * failure returns 400 before `bureau.submitSessionInput` is ever called.
   * `principal` always comes from `resolvePrincipal(context)`
   * (`hooks.ts:152`'s convention); a body-supplied `principal` is never
   * trusted, matching the schema comment above.
   *
   * Maps every `SessionInputAdmissionOutcome` variant to a fixed HTTP
   * status: `admitted`/`replayed` → 202, `conflict` → 409, `not-found` →
   * 404, `session-terminal` → 410, `unsupported-capability` → 501 (matching
   * the existing 501 convention at `sessions.ts:104-105`/`:139-140`/
   * `:179-180`), `backlog-exhausted` → 429.
   */
  app.post('/:id/input', async (context) => {
    const sessionId = context.req.param('id');

    let rawBody: unknown;
    try {
      rawBody = await context.req.json();
    } catch {
      throw new HTTPException(400, { message: 'Invalid JSON body' });
    }

    const parsed = sessionInputAdmissionRequestBodySchema.safeParse(rawBody);
    if (!parsed.success) {
      const fieldErrors = parsed.error.flatten().fieldErrors;
      const message = Object.entries(fieldErrors)
        .map(([field, errors]) => `${field}: ${errors?.join(', ') ?? 'invalid'}`)
        .join('; ');
      throw new HTTPException(400, { message: message || 'Invalid request body' });
    }

    const request: SessionInputAdmissionRequest = {
      ...parsed.data,
      principal: resolvePrincipal(context),
    };

    const outcome: SessionInputAdmissionOutcome = await bureau.submitSessionInput(
      sessionId,
      request,
    );

    switch (outcome.outcome) {
      case 'admitted':
      case 'replayed':
        return context.json({ outcome: outcome.outcome, receipt: outcome.receipt }, 202);
      case 'conflict':
        return context.json(
          {
            error: {
              code: 'CONFLICT',
              message: `Session input conflict: ${outcome.conflict.reason}`,
              conflict: outcome.conflict,
            },
          },
          409,
        );
      case 'not-found':
        throw new HTTPException(404, { message: 'Session not found' });
      case 'session-terminal':
        return context.json(
          {
            error: {
              code: 'SESSION_TERMINAL',
              message: `Session "${outcome.sessionId}" is terminal`,
            },
          },
          410,
        );
      case 'unsupported-capability':
        return context.json(
          { error: { code: 'UNSUPPORTED_CAPABILITY', message: outcome.reason } },
          501,
        );
      case 'backlog-exhausted':
        return context.json(
          {
            error: {
              code: 'BACKLOG_EXHAUSTED',
              message: `Backlog limit of ${outcome.limit} exhausted for scope "${outcome.scope}"`,
              scope: outcome.scope,
              limit: outcome.limit,
            },
          },
          429,
        );
    }
  });

  return app;
}
