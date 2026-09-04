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
import { isPrivilegedGatewayConnection, resolvePrincipal } from '../middleware/authentication';
import type {
  Bureau,
  EventHistoryDeletedAggregateOutcome,
  EventHistoryNotFoundOutcome,
  EventHistoryUnsupportedOutcome,
} from '../types';

/**
 * `packages/bureau/src/durable-event-history.ts`'s own validation-error
 * message prefix (`decodeSincePosition`'s bad-cursor `Error`, `page()`'s
 * bad-limit `RangeError`) — the only thrown errors this route may safely
 * report as a 400. Anything else (a storage I/O failure inside
 * `snapshotRetentionFloor()`/`replay()`, say) is a server-side failure,
 * not a caller mistake, and must not be reported — or have its message
 * leaked — as one (copilot review, PR #505).
 */
const DURABLE_EVENT_HISTORY_VALIDATION_ERROR_PREFIX = 'Durable event history:';

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

type EventHistoryOutcome =
  | DurableEventPage
  | DurableEventGap
  | EventHistoryUnsupportedOutcome
  | EventHistoryNotFoundOutcome
  | EventHistoryDeletedAggregateOutcome;

function isGap(outcome: EventHistoryOutcome): outcome is DurableEventGap {
  return 'outcome' in outcome && outcome.outcome === 'gap';
}

function isUnsupported(outcome: EventHistoryOutcome): outcome is EventHistoryUnsupportedOutcome {
  return 'outcome' in outcome && outcome.outcome === 'unsupported-capability';
}

function isNotFound(outcome: EventHistoryOutcome): outcome is EventHistoryNotFoundOutcome {
  return 'outcome' in outcome && outcome.outcome === 'not-found';
}

function isDeletedAggregate(
  outcome: EventHistoryOutcome,
): outcome is EventHistoryDeletedAggregateOutcome {
  return 'outcome' in outcome && outcome.outcome === 'deleted-aggregate';
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
 * `since` cursor or `limit` — this module's own `limit` parsing, or a
 * `bureau.eventHistory` rejection whose message carries the store's own
 * `"Durable event history:"` validation prefix — → 400. Any OTHER thrown
 * error (a storage I/O failure, say) is a server-side fault → 500, with a
 * generic message rather than the raw error leaked to the caller.
 */
export async function respondWithEventHistoryPage(
  context: Context,
  bureau: Bureau,
  owner: DurableEventOwner,
): Promise<Response> {
  const since = context.req.query('since');
  const limit = parseLimit(context.req.query('limit'));
  const privileged = isPrivilegedGatewayConnection(context.req.header('x-api-key-scopes'));
  // AB-313: authorization is skipped for a privileged connection (AB-305's
  // `x-api-key-scopes` admin-key definition) — `Bureau.eventHistory` treats
  // an omitted `principal` as "skip authorization" (an internal/trusted
  // caller), the same privilege model already governing the redaction
  // check further down.
  const principal = privileged ? undefined : resolvePrincipal(context);

  let outcome: EventHistoryOutcome;
  try {
    outcome = await bureau.eventHistory(owner, {
      ...(since !== undefined ? { since } : {}),
      ...(limit !== undefined ? { limit } : {}),
      ...(principal !== undefined ? { principal } : {}),
    });
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith(DURABLE_EVENT_HISTORY_VALIDATION_ERROR_PREFIX)
    ) {
      throw new HTTPException(400, { message: error.message });
    }
    throw new HTTPException(500, {
      message: 'Durable event history lookup failed.',
      cause: error,
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

  if (isNotFound(outcome)) {
    // Same shape and status as `runs.ts`'s/`sessions.ts`'s own resource-
    // not-found responses — never reveals whether `owner` genuinely
    // doesn't exist or the caller simply isn't authorized for it.
    const message = owner.kind === 'run' ? 'Run not found' : 'Session not found';
    throw new HTTPException(404, { message });
  }

  if (isDeletedAggregate(outcome)) {
    return context.json(
      {
        outcome: 'deleted-aggregate',
        owner: outcome.owner,
        events: outcome.events.map((event) => projectDurableEventForPrivilege(event, privileged)),
        hasMore: outcome.hasMore,
        ...(outcome.nextCursor !== undefined ? { nextCursor: outcome.nextCursor } : {}),
      },
      200,
    );
  }

  const page: DurableEventPage = {
    ...outcome,
    events: outcome.events.map((event) => projectDurableEventForPrivilege(event, privileged)),
  };
  return context.json(page, 200);
}
