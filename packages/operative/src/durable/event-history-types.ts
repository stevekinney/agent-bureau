/**
 * Durable event history types (AB-91's `ab91-01` slice, AB-310).
 *
 * These are the wire types `packages/bureau/src/durable-event-history.ts`
 * exchanges with a caller. They deliberately do NOT re-export Weft's own
 * `Cursor`/`FleetEventEnvelope`/`FleetEventGapEnvelope` types
 * (`@lostgradient/weft/server/handler`) — Bureau's durable event history is
 * a redacted, owner-scoped PROJECTION of the underlying fleet feed, not a
 * pass-through of Weft's own surface, so it gets its own stable public
 * shape independent of Weft's.
 *
 * A `DurableEventEnvelope.cursor` string is, today, produced by round-
 * tripping the underlying `FleetEventEnvelope.cursor` Weft already minted —
 * but callers must treat it as opaque (never parse it, only pass it back as
 * `since`), the same discipline Weft's own `Cursor` type documents.
 */

/** The two aggregate kinds a durable event can be scoped to. */
export type DurableEventOwnerKind = 'run' | 'session';

/** Identifies the run or session a durable event belongs to. */
export interface DurableEventOwner {
  readonly kind: DurableEventOwnerKind;
  readonly id: string;
}

/**
 * One committed, owner-scoped durable event. A structurally redacted
 * subset/superset of Weft's `FleetEventEnvelope`
 * (`packages/weft/src/server/workflow-event-feed.ts:194-201`): `owner`
 * replaces the raw `workflowId` string (encoded as `${owner.kind}:${owner.id}`
 * for storage — packages/bureau/src/durable-event-history.ts's owner-
 * scoping convention), and `schemaVersion` is new — Weft's own envelope
 * carries no schema version at all.
 */
export interface DurableEventEnvelope {
  readonly kind: string;
  readonly owner: DurableEventOwner;
  readonly sequence: number;
  readonly cursor: string;
  readonly emittedAtMs: number;
  readonly payload: unknown;
  readonly schemaVersion: number;
}

/**
 * A bounded, sequence-ordered page of durable events for one owner.
 * `hasMore: true` means at least one further matching event exists past
 * `events` — page again with `since: nextCursor` (or the last returned
 * event's own `cursor`) to continue. `nextCursor` is present whenever
 * `events` is non-empty, whether or not `hasMore` is true, so a caller can
 * always resume from where a page left off.
 */
export interface DurableEventPage {
  readonly events: readonly DurableEventEnvelope[];
  readonly hasMore: boolean;
  readonly nextCursor?: string;
}

/**
 * Returned instead of a `DurableEventPage` when the requested `since`
 * cursor is older than the store's own retention floor — durably
 * distinguishable from an ordinary empty page (`{ events: [], hasMore:
 * false }`, which means "caller is caught up," not "history was lost").
 * Mirrors Weft's own `FleetEventGapEnvelope` payload shape
 * (`workflow-event-feed.ts:251-257`).
 */
export interface DurableEventGap {
  readonly outcome: 'gap';
  readonly requestedCursor: string;
  readonly firstRetainedSequence: number;
}
