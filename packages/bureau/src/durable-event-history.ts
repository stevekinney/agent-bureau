/**
 * Durable event history — the restart-durable, owner-scoped read/write
 * surface over Weft's `FleetEventFeed` (AB-91's `ab91-01` slice, AB-310).
 *
 * Every durable event Bureau records is appended to ONE shared, fleet-wide
 * `FleetEventFeed` built over `engine.storage` (the same backend the
 * durable-run engine already persists to — no second durable log). A
 * run's or a session's own history is a FILTER over that global stream,
 * never a separate storage partition: `FleetEventFeed`'s sequence is
 * fleet-global, not owner-scoped (verified — `FleetEventFeed.append`/
 * `replay` carry no per-owner cursor namespace, only the optional
 * `workflowId` field on the input/envelope), so `page()` walks the global
 * replay stream and keeps only the events whose encoded owner matches.
 * Sequence gaps between consecutive returned events are legal and expected
 * — another owner's events occupy the skipped sequence numbers.
 *
 * Owner-scoping convention (binding on every later reader/writer of this
 * store, per the 2026-09-03 coordinator ruling): `FleetEventInput.workflowId`
 * is a single opaque string, so a `DurableEventOwner` is encoded into it as
 * `${owner.kind}:${owner.id}` for exact-string-match filtering in `page()`.
 * The returned `DurableEventEnvelope.owner` is not re-parsed out of that
 * string — both `record()` and `page()` already know the owner
 * authoritatively (the argument just appended, or the filter that just
 * selected the record) — so it is attached directly rather than decoded a
 * second time from the very string that was used to select the record. A
 * grep of `packages/bureau` for every existing `FleetEventFeed` writer and
 * every `appendWorkflowEventIfPresent` call, performed before this
 * convention was adopted, found NONE — this module is the first
 * `FleetEventFeed` writer/reader in the package, so there was no existing
 * convention to adopt instead.
 *
 * Wiring bureau's action stream (`tool.*`, `run.*`, `step.completed`, ...)
 * into `record()` automatically is deliberately NOT done here — see this
 * module's own doc comment on `createDurableEventHistory` for why, and the
 * pull request body for the followUp this is filed under.
 */
import type {
  DurableEventEnvelope,
  DurableEventGap,
  DurableEventOwner,
  DurableEventPage,
} from '@lostgradient/operative/durable';
import {
  createFleetEventFeed,
  type FleetEventEnvelope,
  type FleetEventFeed,
} from '@lostgradient/weft/server/handler';
import type { Storage } from '@lostgradient/weft/storage';
import type { RuntimeServices } from 'lifecycle';

// ── Public surface ──────────────────────────────────────────────────

/** Options for {@link DurableEventHistory.page}. */
export interface DurableEventHistoryPageOptions {
  /** Exclusive cursor — an event AT `since` is never returned. Omit to page from the beginning. */
  since?: string;
  /** Maximum events to return. Defaults to {@link DEFAULT_PAGE_LIMIT}. Must be a positive integer. */
  limit?: number;
}

/**
 * The durable event history object returned by
 * {@link createDurableEventHistory}. Call `dispose()` to release the
 * underlying `FleetEventFeed` (its listener set and live-poll lifecycle
 * signal) — safe even though this module never calls `subscribe()` itself,
 * so there is never a live poll timer to leak; `dispose()` is still the
 * correct symmetric release for the feed handle this store owns.
 */
export interface DurableEventHistory {
  /**
   * Durably append one owner-scoped event. Delegates to
   * `FleetEventFeed.append`, stamping `owner` into the envelope's
   * `workflowId` via the `${owner.kind}:${owner.id}` convention.
   */
  record(owner: DurableEventOwner, kind: string, payload: unknown): Promise<DurableEventEnvelope>;
  /**
   * A bounded, sequence-ordered page of `owner`'s durable events after the
   * exclusive `since` cursor — or a {@link DurableEventGap} when `since`
   * predates the store's retention floor. See this module's top-of-file
   * doc comment for the owner-filtering algorithm.
   */
  page(
    owner: DurableEventOwner,
    options?: DurableEventHistoryPageOptions,
  ): Promise<DurableEventPage | DurableEventGap>;
  /** Releases the underlying `FleetEventFeed`. Idempotent. */
  dispose(): Promise<void>;
}

/** Default `limit` for {@link DurableEventHistory.page} when the caller omits one. */
export const DEFAULT_PAGE_LIMIT = 100;

/**
 * The wrapper this store persists as a `FleetEventInput.payload` — carries
 * the caller's raw `payload` plus a schema version. Schema negotiation
 * itself (rejecting/migrating an unrecognized version) is AB-313's job
 * (`ab91-04`, conformance/versioning); this slice only stamps and reads
 * the field.
 */
interface StoredDurableEventPayload {
  readonly schemaVersion: number;
  readonly payload: unknown;
}

/** The only schema version this slice ever writes. */
const CURRENT_SCHEMA_VERSION = 1;

function encodeOwner(owner: DurableEventOwner): string {
  return `${owner.kind}:${owner.id}`;
}

function isStoredDurableEventPayload(value: unknown): value is StoredDurableEventPayload {
  return (
    typeof value === 'object' &&
    value !== null &&
    'schemaVersion' in value &&
    typeof value.schemaVersion === 'number' &&
    'payload' in value
  );
}

/**
 * Reconstructs a `DurableEventEnvelope` from the underlying
 * `FleetEventEnvelope` plus the `owner` this record was filtered/appended
 * under — `owner` is not re-parsed out of `envelope.workflowId`: both call
 * sites below (`record()`'s own just-appended owner, `page()`'s exact-
 * string-match owner filter) already know it authoritatively, so decoding
 * it a second time out of the very string that was just used to select
 * this record would be redundant. Throws if the payload isn't the
 * `{ schemaVersion, payload }` wrapper this module stamps — corrupt-record
 * TOLERANCE (skip-and-continue, or a typed error result) is AB-313's job;
 * this slice fails loudly on a shape it did not itself produce rather than
 * silently coercing or dropping it.
 */
function toDurableEventEnvelope(
  envelope: FleetEventEnvelope,
  owner: DurableEventOwner,
): DurableEventEnvelope {
  if (!isStoredDurableEventPayload(envelope.payload)) {
    throw new Error(
      `Durable event history: fleet event at sequence ${envelope.sequence} does not carry a recognized stored payload.`,
    );
  }
  return {
    kind: envelope.kind,
    owner,
    sequence: envelope.sequence,
    cursor: envelope.cursor,
    emittedAtMs: envelope.emittedAtMs,
    payload: envelope.payload.payload,
    schemaVersion: envelope.payload.schemaVersion,
  };
}

/**
 * Decodes a `since`/cursor string to its numeric sequence position for the
 * retention-floor comparison, mirroring Weft's own cursor format (an
 * unsigned decimal, or the `-1` sentinel for "before the first event") —
 * `@lostgradient/weft` does not export its `decodeCursor`/`encodeCursor`
 * codec publicly, so this is a narrow, LOCAL re-implementation used only
 * for this one comparison; the cursor value itself is always round-
 * tripped verbatim from `FleetEventEnvelope.cursor`, never re-encoded by
 * this function.
 */
const CURSOR_PATTERN = /^(?:-1|\d+)$/;

function decodeSincePosition(since: string | undefined): number {
  if (since === undefined) return -1;
  if (!CURSOR_PATTERN.test(since)) {
    throw new Error(`Durable event history: invalid cursor "${since}".`);
  }
  const position = Number(since);
  if (!Number.isSafeInteger(position) || position < -1) {
    throw new Error(`Durable event history: invalid cursor "${since}".`);
  }
  return position;
}

/**
 * Builds a `DurableEventHistory` over `storage` — typically
 * `runtime.durable.engine.storage`, the SAME backend the durable-run
 * engine already persists to (no second durable log). `runtime` supplies
 * `clock.now()` for each recorded event's `emittedAtMs`; every ordering
 * assertion this module's own tests make uses a manual clock, never a
 * real sleep.
 *
 * Deliberately a two-argument factory with no `Bureau` handle: this slice
 * ships the store, its owner-scoped read (`page`) and write (`record`)
 * primitives, and Bureau's composition/disposal of one instance per
 * bureau — NOT an automatic listener that sinks bureau's action-stream
 * events (`tool.*`, `run.*`, ...) into `record()` the way
 * `createAuditTrail` sinks them into the KV-based audit log. That
 * producer wiring has no acceptance-criteria bullet, verification
 * command, or testing-plan entry on AB-310, and the ratified
 * `createDurableEventHistory(storage, runtime)` signature itself carries
 * no `Bureau` to subscribe to — see the pull request body for the
 * followUp this is filed under.
 */
export function createDurableEventHistory(
  storage: Storage,
  runtime: RuntimeServices,
): DurableEventHistory {
  const feed: FleetEventFeed = createFleetEventFeed(storage);

  async function record(
    owner: DurableEventOwner,
    kind: string,
    payload: unknown,
  ): Promise<DurableEventEnvelope> {
    const stored: StoredDurableEventPayload = { schemaVersion: CURRENT_SCHEMA_VERSION, payload };
    const appended = await feed.append({
      kind,
      workflowId: encodeOwner(owner),
      emittedAtMs: runtime.clock.now(),
      payload: stored,
    });
    return toDurableEventEnvelope(appended, owner);
  }

  async function page(
    owner: DurableEventOwner,
    options?: DurableEventHistoryPageOptions,
  ): Promise<DurableEventPage | DurableEventGap> {
    const limit = options?.limit ?? DEFAULT_PAGE_LIMIT;
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new RangeError(
        `Durable event history: limit must be a positive integer, got ${limit}.`,
      );
    }
    const since = options?.since;
    const sincePosition = decodeSincePosition(since);

    const floor = await feed.snapshotRetentionFloor();
    if (sincePosition + 1 < floor) {
      return {
        outcome: 'gap',
        requestedCursor: since ?? '-1',
        firstRetainedSequence: floor,
      };
    }

    const targetWorkflowId = encodeOwner(owner);
    const events: DurableEventEnvelope[] = [];
    let hasMore = false;
    for await (const envelope of feed.replay(since === undefined ? {} : { fromCursor: since })) {
      if (envelope.workflowId !== targetWorkflowId) continue;
      if (events.length >= limit) {
        hasMore = true;
        break;
      }
      events.push(toDurableEventEnvelope(envelope, owner));
    }

    const lastEvent = events.at(-1);
    return {
      events,
      hasMore,
      ...(lastEvent !== undefined ? { nextCursor: lastEvent.cursor } : {}),
    };
  }

  function dispose(): Promise<void> {
    feed.dispose();
    return Promise.resolve();
  }

  return { record, page, dispose };
}
