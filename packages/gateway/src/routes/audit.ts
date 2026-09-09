/**
 * Audit glass-box — Layer A (live) + Layer B (durable trail) routes.
 *
 * **Layer A** reads live state from operative/store, memory, and sessions:
 * - `GET /api/v1/sessions/:id/conversation` — the session's conversation history.
 * - `GET /api/v1/memory/:namespace` — all memory records in a namespace.
 *
 * **Layer B** reads the durable append-only audit trail (KV store):
 * - `GET /api/v1/audit` — combined live + durable audit log.
 *
 * Query parameters for `/audit`:
 * - `since` — epoch-millisecond timestamp; only records at or after this.
 * - `runId` — filter to one run.
 * - `type` — filter to one event type (e.g. `tool.settled`, `run.completed`).
 * - `limit` — max records (default 500, capped at 1000).
 *
 * The ACCEPTANCE invariant (live+durable reconcile on recover) is satisfied
 * when a run's events appear in both the live store's action log AND in the
 * durable trail's records after recovery. The `/api/v1/audit` endpoint queries
 * both and returns a merged, chronologically ordered view.
 */
import { BureauError, serializeActionDetail } from 'bureau';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';

import type { Bureau } from '../types';

/**
 * Create routes for `GET /api/v1/sessions/:id/conversation`.
 *
 * Layer A: reads the session's conversation history from the session store.
 * Mounted by `createRoutes` onto the `/api/v1/sessions` prefix.
 */
export function createConversationRoutes(bureau: Bureau) {
  const app = new Hono();

  /**
   * `GET /api/v1/sessions/:id/conversation`
   *
   * Returns the full `ConversationHistory` for the given session (messages
   * array + id). Useful for chat-UI consumers that need the raw transcript
   * without the full `AgentSession` envelope.
   *
   * Layer A: live session state. Returns 404 when the session does not exist,
   * 503 when no session store is configured.
   */
  app.get('/:id/conversation', async (context) => {
    const sessionId = context.req.param('id');

    try {
      const session = await bureau.getSession(sessionId);
      if (!session) {
        throw new HTTPException(404, { message: 'Session not found' });
      }
      return context.json(session.conversationHistory, 200);
    } catch (error) {
      if (error instanceof HTTPException) throw error;
      if (error instanceof BureauError && error.code === 'NOT_CONFIGURED') {
        throw new HTTPException(503, { message: error.message });
      }
      throw error;
    }
  });

  return app;
}

/**
 * Create routes for `GET /api/v1/memory/:namespace`.
 *
 * Layer A: lists all memory records in a namespace (newest-first, paginated).
 * Mounted by `createRoutes` onto the `/api/v1/memory` prefix.
 */
export function createMemoryRoutes(bureau: Bureau) {
  const app = new Hono();

  /**
   * `GET /api/v1/memory/:namespace`
   *
   * Lists all memory records in the given namespace without semantic search,
   * newest-first. Supports pagination via `?limit=<n>&offset=<n>`.
   *
   * Layer A: live memory state. Returns 503 when no memory backend is
   * configured.
   */
  app.get('/:namespace', async (context) => {
    const namespace = context.req.param('namespace');
    const memory = bureau.memory;

    if (!memory) {
      throw new HTTPException(503, { message: 'No memory backend configured' });
    }

    const limitRaw = context.req.query('limit');
    const offsetRaw = context.req.query('offset');
    const limit = limitRaw !== undefined ? parseInt(limitRaw, 10) : 100;
    const offset = offsetRaw !== undefined ? parseInt(offsetRaw, 10) : 0;

    if (isNaN(limit) || limit <= 0) {
      throw new HTTPException(400, { message: '"limit" must be a positive integer' });
    }
    if (isNaN(offset) || offset < 0) {
      throw new HTTPException(400, { message: '"offset" must be a non-negative integer' });
    }

    const records = await memory.list({ namespace, limit, offset });
    return context.json(records, 200);
  });

  return app;
}

/**
 * Create the `GET /api/v1/audit` route.
 *
 * Returns a merged, chronologically ordered view of:
 * - **Layer B** (durable trail): records sinked to the KV store by the bureau's
 *   `AuditTrail` on qualifying action events.
 * - **Layer A** (live store): actions still in-flight or from a non-persistent
 *   bureau, to ensure in-progress runs are also visible.
 *
 * Mounted by `createRoutes` onto the `/api/v1/audit` prefix.
 */
export function createAuditRoutes(bureau: Bureau) {
  const app = new Hono();

  /**
   * `GET /api/v1/audit`
   *
   * Query parameters:
   * - `since` — epoch-ms timestamp; only records at or after.
   * - `runId` — filter to one run (also accepted as `agent` for API compat).
   * - `type` — filter to one event type (e.g. `tool.settled`, `run.completed`).
   * - `limit` — max records to return (default 500, max 1000).
   *
   * When neither Layer B nor Layer A produces records, returns an empty array.
   * This endpoint is always available (never 503).
   */
  app.get('/', async (context) => {
    const sinceRaw = context.req.query('since');
    const runId = context.req.query('runId') ?? context.req.query('agent');
    const type = context.req.query('type');
    const limitRaw = context.req.query('limit');

    const since = sinceRaw !== undefined ? parseInt(sinceRaw, 10) : undefined;
    if (since !== undefined && isNaN(since)) {
      throw new HTTPException(400, { message: '"since" must be a numeric epoch-ms timestamp' });
    }

    const limitParsed = limitRaw !== undefined ? parseInt(limitRaw, 10) : 500;
    if (limitRaw !== undefined && (isNaN(limitParsed) || limitParsed <= 0)) {
      throw new HTTPException(400, { message: '"limit" must be a positive integer' });
    }
    const limit = Math.min(isNaN(limitParsed) ? 500 : limitParsed, 1000);

    // Layer B — durable trail.
    const auditTrail = bureau.auditTrail;
    const durableRecords = auditTrail ? await auditTrail.query({ since, runId, type, limit }) : [];

    // Layer A — live store actions. Include live actions whose specific event
    // is not already present in the durable trail. We deduplicate on the
    // composite event key (runId + type + sequence + timestamp) rather than on runId alone
    // so that in-flight actions for a run that already has some durable records
    // are not incorrectly suppressed. The durable trail only captures selected
    // AUDIT_EVENT_TYPES; non-audited event types (e.g. generate.*) are never
    // in durableRecords and must always pass through from the live store.
    const liveState = bureau.store.getState();
    // AB-370: dedup on `actionSequence ?? sequence` — the originating
    // operative-store `Action`'s own per-process `sequence`, which is what
    // the live store's `action.sequence` below is also drawn from — NOT on
    // the durable trail's shared, per-bureau ordering counter alone (see
    // `AuditRecord.actionSequence`'s own doc comment in
    // `packages/bureau/src/audit-trail.ts`). `?? sequence` (Codex P2
    // review finding, PR #594, "Preserve deduplication for
    // pre-actionSequence records") covers a durable record a PRIOR version
    // of this trail wrote, before `actionSequence` existed as a distinct
    // field: back then `sequence` WAS the action's own `action.sequence`
    // (the two fields only diverged once this issue shipped), so falling
    // back to `sequence` for such a record still correlates correctly — an
    // upgrade with existing durable history and a reused/restored live
    // store must not start duplicating every pre-upgrade action-derived
    // event. A genuinely out-of-band record (`session.deleted`,
    // `schedule.*`, `review.*`) gets a dedup key from this same fallback
    // too, but that is harmless: those always carry a synthetic runId
    // (`schedule:<id>`/`session:<id>`) or a `review.<kind>.<status>` type
    // string that never appears on the live action stream at all, so this
    // key can never coincidentally match a real live action's key.
    //
    // `timestampMs` is included too (Copilot review finding, PR #594):
    // `action.sequence` is the operative store's per-process counter — it
    // restarts from 0 on every `createStore()` (a fresh process, or a
    // caller-supplied store), so a run that continues across a restart and
    // re-emits the same `type` at the same low per-process sequence number
    // could otherwise collide with an unrelated durable record's
    // correlated sequence and be wrongly suppressed as "already durable".
    // Folding `timestampMs` in correlates the exact event instance, not
    // just its per-process sequence number.
    const durableEventKeys = new Set(
      durableRecords.flatMap(
        (r: {
          runId: string;
          type: string;
          sequence?: number;
          actionSequence?: number;
          timestampMs: number;
        }) => {
          const correlated = r.actionSequence ?? r.sequence;
          return correlated !== undefined
            ? [`${r.runId}:${r.type}:${correlated}:${r.timestampMs}`]
            : [];
        },
      ),
    );

    const liveRecords: Array<{
      timestamp: string;
      timestampMs: number;
      sequence: number;
      runId: string;
      type: string;
      detail: unknown;
    }> = [];

    for (const action of liveState.actions) {
      // Apply filters.
      if (since !== undefined && action.timestamp < since) continue;
      if (runId !== undefined && action.runId !== runId) continue;
      if (type !== undefined && action.type !== type) continue;

      // Exclude actions already present in the durable trail to avoid
      // duplicates. Match on the composite event key (runId + type +
      // sequence + timestamp) so only the exact event is suppressed — not
      // all events for the run. When there is no durable trail (no
      // persistence), include all live actions.
      if (
        auditTrail &&
        durableEventKeys.has(
          `${action.runId}:${action.type}:${action.sequence}:${action.timestamp}`,
        )
      )
        continue;

      liveRecords.push({
        timestamp: new Date(action.timestamp).toISOString(),
        timestampMs: action.timestamp,
        sequence: action.sequence,
        runId: action.runId,
        type: action.type,
        // Serialize the detail through the same pipeline used by the audit
        // trail and the WebSocket frame emitter: strips Conversation instances,
        // serializes Error objects, and removes other non-JSON-safe values so
        // the record is safe to JSON.stringify. The raw detail from the live
        // store can contain cyclic Conversation objects on step.completed and
        // run.completed events, so this step is required.
        detail: serializeActionDetail(action.type, action.detail),
      });
    }

    // AB-370 (Codex P1 review finding, PR #594, two rounds — "Preserve a
    // common order when merging live and durable records", then "Use one
    // domain for same-millisecond comparisons"): `durableRecords` is
    // already correctly ordered by `AuditTrail.query()`'s own
    // (`timestampMs`, `sequence`) comparator — comparing a durable
    // record's `sequence` DIRECTLY against another durable record's
    // `actionSequence` (a single global re-sort naturally does this once
    // both live and durable records are thrown into one array) discards
    // that established order in favor of a domain mismatch that only
    // matters for a durable-VS-live comparison. `liveRecords` is sorted by
    // its own `sequence` (`action.sequence` — a single, self-consistent
    // domain) so it, too, arrives at the merge below already correctly
    // ordered internally.
    liveRecords.sort((a, b) => a.sequence - b.sequence);

    // A proper two-list STABLE merge (mergesort's merge step), not a
    // single `Array.sort` over the concatenation: each list's own,
    // already-correct internal order is preserved (an item is only ever
    // pushed from the FRONT of its own list, never reordered relative to
    // its own list's peers) — the domain-mismatch problem above only ever
    // arises comparing the two lists' current HEADS against each other,
    // which is exactly the one comparison where a durable record's
    // `actionSequence` (the same domain as a live action's own `sequence`)
    // is the right key; a durable record with no `actionSequence`
    // (out-of-band: `session.deleted`, `schedule.*`, `review.*`) falls
    // back to its own `sequence` for this cross-list comparison only —
    // best-effort, since it has no live counterpart to correlate with —
    // via `-1` when even that is absent, the same sentinel
    // `audit-trail.ts`'s own `query()` comparator uses for the same
    // transitivity reason.
    const merged: Array<(typeof durableRecords)[number] | (typeof liveRecords)[number]> = [];
    let durableIndex = 0;
    let liveIndex = 0;
    while (durableIndex < durableRecords.length && liveIndex < liveRecords.length) {
      const durableRecord = durableRecords[durableIndex]!;
      const liveRecord = liveRecords[liveIndex]!;
      if (durableRecord.timestampMs !== liveRecord.timestampMs) {
        if (durableRecord.timestampMs < liveRecord.timestampMs) {
          merged.push(durableRecord);
          durableIndex++;
        } else {
          merged.push(liveRecord);
          liveIndex++;
        }
        continue;
      }
      const durableOrderingKey = durableRecord.actionSequence ?? durableRecord.sequence ?? -1;
      if (durableOrderingKey <= liveRecord.sequence) {
        merged.push(durableRecord);
        durableIndex++;
      } else {
        merged.push(liveRecord);
        liveIndex++;
      }
    }
    while (durableIndex < durableRecords.length) merged.push(durableRecords[durableIndex++]!);
    while (liveIndex < liveRecords.length) merged.push(liveRecords[liveIndex++]!);

    return context.json(merged.slice(0, limit), 200);
  });

  return app;
}
