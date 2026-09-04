/**
 * Shared paging-route logic for Gateway's durable-event-history endpoints
 * (AB-312): `GET /api/v1/runs/:id/events`, `GET /api/v1/sessions/:id/events`,
 * and `GET /api/v1/schedules/:id/events` — each a thin route registration
 * in its own owner's route file, all backed by this one implementation so
 * the query parsing, status-code mapping, and AB-305 privilege projection
 * live in exactly one place.
 */
import type {
  DurableEventGap,
  DurableEventOwner,
  DurableEventPage,
} from '@lostgradient/operative/durable';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';

import { projectDurableEventForPrivilege } from '../live-events';
import { isPrivilegedGatewayConnection } from '../middleware/authentication';
import type { Bureau, EventHistoryUnsupportedOutcome } from '../types';

/** Parses and validates the `limit` query parameter. Throws a 400 `HTTPException` for anything malformed. */
function parseLimit(raw: string | undefined): number | undefined {
  if (raw === undefined) {
    return undefined;
  }

  if (!/^\d+$/.test(raw)) {
    throw new HTTPException(400, { message: '"limit" must be a positive integer' });
  }

  const limit = Number(raw);
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new HTTPException(400, { message: '"limit" must be a positive integer' });
  }

  return limit;
}

function isGap(
  outcome: DurableEventPage | DurableEventGap | EventHistoryUnsupportedOutcome,
): outcome is DurableEventGap {
  return 'outcome' in outcome && outcome.outcome === 'gap';
}

function isUnsupported(
  outcome: DurableEventPage | DurableEventGap | EventHistoryUnsupportedOutcome,
): outcome is EventHistoryUnsupportedOutcome {
  return 'outcome' in outcome && outcome.outcome === 'unsupported-capability';
}

/**
 * The shared handler behind every `GET .../:id/events` durable-history
 * paging route. `owner` is this route's fixed `DurableEventOwnerKind` with
 * the request's own `:id` param.
 *
 * Status mapping: a `DurableEventPage` → 200 (its `events` each projected
 * through {@link projectDurableEventForPrivilege}, AB-305's principal
 * projection applied to paged events, per the coordinator's amendment on
 * this issue); a `DurableEventGap` (the requested `since` predates the
 * store's retention floor) → 410 Gone, matching the expired-locator
 * precedent (`documentation/operative-type-safe-api.md`'s retention-expiry
 * section) rather than an empty 200; `unsupported-capability` (no
 * persistent storage backend configured) → 501, matching the existing
 * `NOT_CONFIGURED`/`UNSUPPORTED_CAPABILITY` convention `sessions.ts`
 * already uses for the same missing-durable-backend case; a malformed
 * `since` cursor or `limit` (caught from `bureau.eventHistory`'s own thrown
 * `Error`/`RangeError`, or from this module's own `limit` parsing) → 400.
 */
export async function respondWithEventHistoryPage(
  context: Context,
  bureau: Bureau,
  owner: DurableEventOwner,
): Promise<Response> {
  const since = context.req.query('since');
  const limit = parseLimit(context.req.query('limit'));
  const privileged = isPrivilegedGatewayConnection(context.req.header('x-api-key-scopes'));

  let outcome: DurableEventPage | DurableEventGap | EventHistoryUnsupportedOutcome;
  try {
    outcome = await bureau.eventHistory(owner, {
      ...(since !== undefined ? { since } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
  } catch (error) {
    throw new HTTPException(400, {
      message: error instanceof Error ? error.message : 'Invalid "since" cursor or "limit"',
    });
  }

  if (isGap(outcome)) {
    return context.json(outcome, 410);
  }

  if (isUnsupported(outcome)) {
    return context.json(
      {
        error: {
          code: 'UNSUPPORTED_CAPABILITY',
          message: 'No persistent storage backend is configured for durable event history.',
        },
      },
      501,
    );
  }

  const page: DurableEventPage = {
    ...outcome,
    events: outcome.events.map((event) => projectDurableEventForPrivilege(event, privileged)),
  };
  return context.json(page, 200);
}
