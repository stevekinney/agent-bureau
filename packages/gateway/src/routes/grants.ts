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
 */
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';

import { resolvePrincipal } from '../middleware/authentication';
import type { Bureau } from '../types';
import { parseReviewBody, toHttpException } from './reviews';

const issueGrantBodySchema = z.object({
  tenantId: z.string().min(1),
  ownerId: z.string().min(1),
  agentId: z.string().min(1),
  toolName: z.string().min(1),
  resourcePattern: z.string().min(1).optional(),
  argumentConstraints: z.record(z.string(), z.unknown()).optional(),
  scope: z.enum(['run', 'session', 'principal']),
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
