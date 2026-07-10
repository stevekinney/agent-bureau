/**
 * Audit trail — Layer B (durable append-only trail).
 *
 * Sinks `tool.*`, memory-write, and run-transition events from the bureau's
 * action stream into the KV store as an append-only audit log under the
 * `audit:v1:` prefix. The trail survives process restarts and outlives the
 * in-memory operative/store ring buffer (`maxActions`).
 *
 * Key schema: `audit:v1:<timestamp-padded>:<sequence>` so natural sort order
 * is chronological. Values are JSON-serialized {@link AuditRecord}.
 *
 * Layer A (live) is the operative/store; Layer B is this trail. Together they
 * form the glass-box audit surface for the gateway.
 */
import type { TextValueStore } from '@lostgradient/weft/storage';

import { serializeActionDetail } from './serialization';
import type { Bureau } from './types';

// ── Public surface ──────────────────────────────────────────────────

/** Event types that are sunk into the durable audit trail. */
export const AUDIT_EVENT_TYPES = [
  // Tool lifecycle
  'tool.started',
  'tool.settled',
  'tool.error',
  // Run lifecycle transitions
  'run.completed',
  'run.error',
  'run.aborted',
  // Step lifecycle
  'step.completed',
] as const;

export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];

/** A single entry in the durable audit log. */
export interface AuditRecord {
  /** ISO-8601 timestamp. */
  timestamp: string;
  /** Epoch milliseconds (for range queries). */
  timestampMs: number;
  /** Monotonically increasing per-process counter from the operative store. */
  sequence: number;
  /** The originating run id. */
  runId: string;
  /** The event type (one of {@link AuditEventType}). */
  type: string;
  /** Serializable detail snapshot from the operative store's action. */
  detail: unknown;
  /**
   * The authenticated principal attributed with this record (e.g.
   * `api-key:<id>` or `static-token`). Only present on records written via
   * {@link AuditTrail.record} — out-of-band human decisions (AB-20 review
   * queue approve/deny). Bureau-action-stream records (`tool.*`, `run.*`,
   * `step.completed`) have no principal; they are attributed to the run.
   */
  principal?: string;
}

/**
 * Query options for {@link AuditTrail.query}.
 *
 * All filters are AND-ed together. Omitting a filter means "no restriction".
 */
export interface AuditQueryOptions {
  /** Only records at or after this epoch-millisecond timestamp. */
  since?: number;
  /** Only records whose `runId` matches this run. */
  runId?: string;
  /** Only records whose `type` equals this string. */
  type?: string;
  /** Maximum number of records to return. Defaults to 500. */
  limit?: number;
}

/**
 * The audit trail object returned by {@link createAuditTrail}. Call
 * `dispose()` to unsubscribe from the bureau's action stream.
 */
export interface AuditTrail {
  /**
   * Query the durable trail. Returns records in chronological order (oldest
   * first) matching all supplied filters. Falls back to an empty array when
   * no KV store is available (non-persistent bureau).
   */
  query(options?: AuditQueryOptions): Promise<AuditRecord[]>;
  /**
   * Write an out-of-band record directly into the durable trail, bypassing the
   * bureau action-stream listener. Used by `resolveReview` (AB-20 review
   * queue) to attribute a human's approve/deny decision to `entry.principal` —
   * a decision made outside any run's step loop, so it never appears on the
   * bureau's `action` event stream. A no-op when no KV store is configured
   * (ephemeral bureau); the review is still resolved, just not durably
   * recorded — Layer A (live) has no equivalent for out-of-band records.
   */
  record(entry: {
    runId: string;
    type: string;
    detail: unknown;
    principal?: string;
  }): Promise<void>;
  /** Stop listening to bureau events and release the subscription. */
  dispose(): void;
}

// ── Key encoding ────────────────────────────────────────────────────

const PREFIX = 'audit:v1:';

/** Encode a key so chronological sort is lexicographic. */
function encodeKey(timestampMs: number, sequence: number, runId: string): string {
  // 16-digit zero-padded timestamp covers dates through year 9999.
  // Append the sequence number (within-millisecond tiebreak) and the runId
  // (cross-process-lifetime tiebreak) so the full key is globally unique.
  //
  // Why runId is required: `sequence` is a per-store-lifetime counter that resets
  // to 0 on every process restart. A clock rewind (NTP step-back, VM snapshot
  // restore, manual clock set) after restart means a new event can share both
  // `timestamp` and `sequence` with a previously-persisted record, silently
  // overwriting it and violating the append-only invariant. Including `runId` —
  // which is derived from sessionId + run-sequence and thus unique across
  // restarts — makes collision impossible: two keys can match only if they share
  // the same runId, which only occurs for the *same* run, whose new events land
  // at strictly later timestamps due to Weft's replay ordering.
  const ts = timestampMs.toString().padStart(16, '0');
  const seq = sequence.toString().padStart(12, '0');
  return `${PREFIX}${ts}:${seq}:${runId}`;
}

// ── Audit trail factory ─────────────────────────────────────────────

/**
 * Creates an audit trail attached to the given bureau.
 *
 * When `kv` is provided (bureau has `.persistence()`), sinks qualifying
 * action events into the KV store. When `kv` is absent, the trail still
 * subscribes (so `dispose()` is always safe) but writes nowhere — the
 * glass-box audit surface is Layer A only.
 *
 * @param bureau - The bureau to observe.
 * @param kv - The KV store to persist audit records into. `undefined` when
 *   the bureau has no persistence configured.
 */
export function createAuditTrail(bureau: Bureau, kv: TextValueStore | undefined): AuditTrail {
  // Determine which event types qualify as audit events.
  const auditEventSet = new Set<string>(AUDIT_EVENT_TYPES);

  // Out-of-band records (via `record()`) have no operative store `Action` to
  // draw a `sequence` from — they happen outside any run's step loop.
  // `encodeKey` zero-pads `sequence` as an unsigned decimal, so the counter
  // must stay non-negative for the lexicographic key sort to hold, and
  // `query()`/`/api/v1/audit` order ties by ASCENDING sequence — so it must
  // count UP (not down) for later same-millisecond records to sort after
  // earlier ones. Starting well below `Number.MAX_SAFE_INTEGER` (10 billion
  // of headroom — far more manual records than any process could plausibly
  // emit) keeps every value in that same large, real-action-sequence-proof
  // range (the store's own sequence always starts at 0) while leaving room
  // to increment without exceeding `MAX_SAFE_INTEGER`.
  let manualSequence = Number.MAX_SAFE_INTEGER - 10_000_000_000;

  // Subscribe to the bureau's action stream. The bureau re-emits every
  // operative store action as an ActionEvent, so we don't need to reach into
  // the store directly — the event surface is the intended integration point.
  const listener = (event: import('./events').ActionEvent) => {
    const { action } = event;
    if (!auditEventSet.has(action.type)) return;
    if (!kv) return;

    // Serialize the detail through the same pipeline used for WebSocket frames:
    // strips Conversation instances, serializes Error objects, and removes
    // other non-JSON-safe values so the record is safe to JSON.stringify.
    const serializedDetail = serializeActionDetail(action.type, action.detail);

    const record: AuditRecord = {
      timestamp: new Date(action.timestamp).toISOString(),
      timestampMs: action.timestamp,
      sequence: action.sequence,
      runId: action.runId,
      type: action.type,
      detail: serializedDetail,
    };

    const key = encodeKey(action.timestamp, action.sequence, action.runId);
    // Fire-and-forget: a write failure must never crash the run. The audit
    // trail is best-effort — a gap is surfaced by log, never by a crash.
    kv.set(key, JSON.stringify(record)).catch((error: unknown) => {
      console.error(`[audit-trail] Failed to persist audit record for key "${key}":`, error);
    });
  };

  bureau.addEventListener('action', listener);

  return {
    async record(entry: {
      runId: string;
      type: string;
      detail: unknown;
      principal?: string;
    }): Promise<void> {
      if (!kv) return;

      const timestampMs = Date.now();
      const sequence = manualSequence++;

      const record: AuditRecord = {
        timestamp: new Date(timestampMs).toISOString(),
        timestampMs,
        sequence,
        runId: entry.runId,
        type: entry.type,
        detail: entry.detail,
        ...(entry.principal !== undefined ? { principal: entry.principal } : {}),
      };

      const key = encodeKey(timestampMs, sequence, entry.runId);
      try {
        await kv.set(key, JSON.stringify(record));
      } catch (error: unknown) {
        // Best-effort, matching the listener above: a write failure must
        // never fail the caller's approve/deny decision.
        console.error(`[audit-trail] Failed to persist audit record for key "${key}":`, error);
      }
    },

    async query(options: AuditQueryOptions = {}): Promise<AuditRecord[]> {
      if (!kv) return [];

      const { since, runId, type, limit = 500 } = options;

      // List all audit keys under the prefix, then filter. For large logs a
      // range-prefix trick could narrow further (the timestamp is the first
      // segment after the prefix), but correctness-first: list all, filter in
      // memory. Suitable for per-run/per-session audit volumes.
      const keys = await kv.list(PREFIX);

      const records: AuditRecord[] = [];
      for (const key of keys) {
        const raw = await kv.get(key);
        if (!raw) continue;

        let record: AuditRecord;
        try {
          record = JSON.parse(raw) as AuditRecord;
        } catch {
          continue;
        }

        if (since !== undefined && record.timestampMs < since) continue;
        if (runId !== undefined && record.runId !== runId) continue;
        if (type !== undefined && record.type !== type) continue;

        records.push(record);

        // Apply the limit AFTER filtering so we count only records that match all
        // predicates. Stopping before filtering would cause the loop to break on
        // non-matching records and miss in-range entries later in the key scan.
        if (records.length >= limit) break;
      }

      return records;
    },

    dispose(): void {
      bureau.removeEventListener('action', listener);
    },
  };
}
