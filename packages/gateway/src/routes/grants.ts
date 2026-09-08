/**
 * Reusable approval grant routes (AB-46, AB-346): a grant lets a matching
 * future tool call skip human review entirely.
 *
 * - `POST /api/v1/grants` — issue a new grant.
 * - `DELETE /api/v1/grants/:id` — revoke a grant.
 * - `GET /api/v1/grants` — list the caller's own grants.
 *
 * Every mutating route attributes its action to the authenticated principal
 * (`resolvePrincipal`, the same seam the review routes use): `POST /grants`
 * always issues the grant to the CALLER's own `principalId`, ignoring any
 * `principalId` present in the request body, and both `GET /grants` and
 * `DELETE /grants/:id` are scoped to the caller's own grants — a caller can
 * neither see nor revoke a grant issued to a different principal, mirroring
 * the review routes' `resolvePrincipal`-based attribution.
 *
 * `policyRevision` is likewise never accepted from the request body (the
 * schema below has no such field): `Toolbox.issueGrant` defaults it to the
 * toolbox's own current revision when omitted, and AB-46's decision record
 * describes `policyRevision` purely as an internal "reuses armorer's
 * existing policyRevision" field, not a caller-supplied override. Accepting
 * a client value here would let an untrusted caller pre-sign a grant for a
 * predictable FUTURE policy revision — dormant until that revision deploys,
 * then valid — defeating a policy bump's intended invalidation of
 * previously issued authority (review finding, this pull request).
 *
 * Status codes follow the existing `POST /schedules` / `DELETE
 * /schedules/:id` convention this gateway already establishes
 * (`schedules.ts`): `201` for issuance, `200` for listing, `204` for
 * revocation.
 *
 * `scope` (AB-364): `'run'` requires a `runId` in the body and matches only
 * calls from that run; `'session'` requires a `sessionId` and matches any
 * run of that session; `'principal'` matches as before, with no identifier
 * required. A body missing the identifier its chosen scope needs is
 * rejected with `400` (`issueGrantBodySchema`'s `superRefine`) before
 * `Toolbox.issueGrant` is ever called — which enforces the same rule
 * independently (`GrantError`, code `invalid-scope`) for callers that mint
 * grants directly against the toolbox rather than through this route.
 */
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';

import { resolvePrincipal } from '../middleware/authentication';
import type { Bureau } from '../types';
import { parseReviewBody, toHttpException } from './reviews';

const issueGrantBodySchema = z
  .object({
    tenantId: z.string().min(1),
    ownerId: z.string().min(1),
    agentId: z.string().min(1),
    toolName: z.string().min(1),
    resourcePattern: z.string().min(1).optional(),
    argumentConstraints: z.record(z.string(), z.unknown()).optional(),
    scope: z.enum(['run', 'session', 'principal']),
    // Required when `scope` is `'run'`/`'session'` respectively (AB-364),
    // enforced below by `superRefine` rather than a per-scope discriminated
    // union: a `run` grant carrying an incidental `sessionId` (or vice
    // versa) is not itself invalid — only the identifier the CHOSEN scope
    // needs is required — and the ruling never says the other one must be
    // absent. `.trim()` before `.min(1)` matches `createRunFromRequest`'s
    // own `request.sessionId?.trim()` canonicalization
    // (`packages/bureau/src/create-bureau.ts`): without it, a session id
    // supplied here with incidental whitespace would sign a grant that can
    // never match the trimmed session id a real run actually carries, and a
    // whitespace-only value would pass `min(1)` untrimmed while Bureau
    // rejects the same value for a run (review finding, chatgpt-codex-connector).
    runId: z.string().trim().min(1).optional(),
    sessionId: z.string().trim().min(1).optional(),
    expiresAt: z.number(),
    // A fractional or non-positive maxUses would break usage-counting
    // semantics downstream: `Toolbox.issueGrant` initializes
    // `usesRemaining` to `maxUses` verbatim and matching only requires
    // `usesRemaining > 0` after decrementing by exactly 1 per use, so e.g.
    // `maxUses: 1.5` grants two uses instead of one, and `maxUses: 0` (or
    // negative) silently mints a permanently unusable grant rather than
    // rejecting the request (review finding, this pull request).
    maxUses: z.number().int().positive(),
    delegationBehavior: z.enum(['inherits-to-children', 'does-not-propagate']),
  })
  .superRefine((value, ctx) => {
    if (value.scope === 'run' && !value.runId) {
      ctx.addIssue({
        code: 'custom',
        path: ['runId'],
        message: 'A "run"-scoped grant requires a runId.',
      });
    }
    if (value.scope === 'session' && !value.sessionId) {
      ctx.addIssue({
        code: 'custom',
        path: ['sessionId'],
        message: 'A "session"-scoped grant requires a sessionId.',
      });
    }
  });

export function createGrantsRoutes(bureau: Bureau) {
  const app = new Hono();

  app.post('/', async (context) => {
    const body = await parseReviewBody(context, issueGrantBodySchema);

    try {
      const grant = await bureau.issueGrant({
        ...body,
        // The caller's own authenticated principal, never a client-supplied
        // value — a request body carries no `principalId` field at all (see
        // the schema above), so this is the only source.
        principalId: resolvePrincipal(context),
      });
      return context.json(grant, 201);
    } catch (error) {
      throw toHttpException(error);
    }
  });

  app.get('/', async (context) => {
    try {
      const grants = await bureau.listGrants({ principalId: resolvePrincipal(context) });
      return context.json(grants, 200);
    } catch (error) {
      throw toHttpException(error);
    }
  });

  app.delete('/:id', async (context) => {
    const id = context.req.param('id');
    const principalId = resolvePrincipal(context);

    try {
      const callerGrants = await bureau.listGrants({ principalId });
      if (!callerGrants.some((grant) => grant.id === id)) {
        throw new HTTPException(404, { message: `Grant with id "${id}" not found` });
      }
      await bureau.revokeGrant(id);
      return context.body(null, 204);
    } catch (error) {
      if (error instanceof HTTPException) throw error;
      throw toHttpException(error);
    }
  });

  return app;
}
