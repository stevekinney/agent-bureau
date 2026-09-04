/**
 * Durable-event-history compatibility fixtures (AB-91's `ab91-05` child,
 * AB-314) — reusable seed data and helpers so a consumer (most directly
 * AB-275, "Add Gateway restart and durable-history replay conformance")
 * can build against a known, pre-populated durable history without
 * re-deriving what a compatible event page/envelope looks like from
 * scratch.
 *
 * This module ships NO production behavior: it composes the real
 * `createDurableEventHistory` (AB-310/AB-311/AB-313) over a real
 * `BureauStorageFixture` (AB-261) exactly the way `packages/bureau/src/
 * durable-event-history.test.ts` already does, and records a fixed,
 * ordered sequence of events through the module's own public `record()`
 * — never by poking `FleetEventFeed` directly, except in
 * {@link seedSchemaVersionMismatchRecord}, whose whole point is to write a
 * record `record()` itself could never produce.
 *
 * Two independent concerns, kept as two separate exports rather than one
 * combined helper, because a consumer wanting one rarely wants the other:
 *
 * - {@link createDurableEventHistoryFixture} — seeds
 *   {@link DURABLE_EVENT_HISTORY_FIXTURE_SEQUENCE} across a SQLite or LMDB
 *   backend and hands back the seeded envelopes plus the storage fixture,
 *   so a restart-proof consumer (AB-275) can dispose the writing instance,
 *   reopen the SAME backend path, and assert the sequence survives.
 * - {@link seedSchemaVersionMismatchRecord} — the event-schema
 *   compatibility half of this issue's acceptance criteria: proves a
 *   CURRENT-schema-version record round-trips normally (the trivial case,
 *   `createDurableEventHistoryFixture`'s own seeded envelopes already
 *   cover it) and gives a caller a one-line way to also seed a
 *   deliberately older/malformed-shaped record for asserting the
 *   rejection `durable-event-history.ts`'s `UnsupportedDurableEventSchemaVersionError`
 *   documents (AB-313, `ab91-04`) — never silently coerced or upgraded.
 */
import type { DurableEventEnvelope, DurableEventOwner } from '@lostgradient/operative/durable';
import { createFleetEventFeed, type FleetEventFeed } from '@lostgradient/weft/server/handler';
import {
  resolveStorage,
  type Storage,
  type StorageConfiguration,
} from '@lostgradient/weft/storage';
import type { RuntimeServices } from 'lifecycle';
import { createManualRuntimeServices } from 'lifecycle';

import { createDurableEventHistory, type DurableEventHistory } from '../durable-event-history';
import type { BureauStorageFixture } from './storage-fixtures';
import { createLmdbStorageFixture, createSqliteStorageFixture } from './storage-fixtures';

/** One record in {@link DURABLE_EVENT_HISTORY_FIXTURE_SEQUENCE}. */
export interface DurableEventHistoryFixtureRecord {
  readonly owner: DurableEventOwner;
  readonly kind: string;
  readonly payload: unknown;
}

/**
 * A fixed, ordered sequence of durable events spanning all three owner
 * kinds `DurableEventOwner` supports (`'run'`, `'session'`, `'schedule'`,
 * AB-320) — one aggregate's full lifecycle shape for each: a run's
 * started/completed pair, a session's created/saved pair, and a
 * schedule's created/paused definition pair (AB-87: a schedule FIRE is
 * recorded under the fired run's own `'run'` owner, never `'schedule'` —
 * deliberately not modeled again here since the run rows above already
 * cover that shape). Recorded through `history.record()` in this exact
 * order by {@link createDurableEventHistoryFixture}, so the resulting
 * `sequence`/`cursor` values are deterministic (`0..6` on a freshly
 * allocated backend) and reproducible across the SQLite and LMDB variants
 * of the same fixture.
 */
export const DURABLE_EVENT_HISTORY_FIXTURE_SEQUENCE: readonly DurableEventHistoryFixtureRecord[] = [
  {
    owner: { kind: 'run', id: 'fixture-run-1' },
    kind: 'run.started',
    payload: { attempt: 1 },
  },
  {
    owner: { kind: 'run', id: 'fixture-run-1' },
    kind: 'step.completed',
    payload: { step: 1 },
  },
  {
    owner: { kind: 'run', id: 'fixture-run-1' },
    kind: 'run.completed',
    payload: { finishReason: 'success' },
  },
  {
    owner: { kind: 'session', id: 'fixture-session-1' },
    kind: 'session.created',
    payload: { sessionId: 'fixture-session-1' },
  },
  {
    owner: { kind: 'session', id: 'fixture-session-1' },
    kind: 'session.saved',
    payload: { sessionId: 'fixture-session-1' },
  },
  {
    owner: { kind: 'schedule', id: 'fixture-schedule-1' },
    kind: 'schedule.created',
    payload: { scheduleId: 'fixture-schedule-1', agentName: 'fixture-agent' },
  },
  {
    owner: { kind: 'schedule', id: 'fixture-schedule-1' },
    kind: 'schedule.paused',
    payload: { scheduleId: 'fixture-schedule-1' },
  },
];

/** Options for {@link createDurableEventHistoryFixture}. */
export interface DurableEventHistoryFixtureOptions {
  /** Which persistent backend to seed. */
  readonly backend: 'sqlite' | 'lmdb';
  /**
   * Defaults to a freshly constructed, fully independent
   * `createManualRuntimeServices()` instance when omitted — matching
   * `createBureauTestHarness`'s own default (AB-261), so two fixtures
   * built without an explicit `runtime` never share a clock or identifier
   * sequence.
   */
  readonly runtime?: RuntimeServices;
  /**
   * A caller-supplied backend path/directory. Forwarded verbatim to
   * `createSqliteStorageFixture`/`createLmdbStorageFixture` — when
   * present, the underlying `BureauStorageFixture` is NOT owned and
   * `dispose()` leaves the path alone (the exact contract those two
   * factories already document), which is what a restart-proof consumer
   * (AB-275) needs: seed once, dispose the writing instance, reopen the
   * same path in a fresh process or handle.
   */
  readonly path?: string;
  /**
   * Overrides {@link DURABLE_EVENT_HISTORY_FIXTURE_SEQUENCE}. Defaults to
   * the module constant — a caller exercising a variant sequence (e.g. one
   * exercising every `DurableEventOwnerKind` in a different order) can
   * still reuse this fixture's storage-fixture wiring without duplicating
   * it.
   */
  readonly sequence?: readonly DurableEventHistoryFixtureRecord[];
}

/**
 * The seeded fixture {@link createDurableEventHistoryFixture} returns. The
 * writing `DurableEventHistory` instance and its `Storage` handle are
 * ALREADY disposed by the time this resolves (mirroring
 * `durable-event-history.test.ts`'s own "restart durability" tests' own
 * write-then-close-then-reopen pattern) — a consumer proving restart
 * durability reopens `storage.configuration` itself via a fresh
 * `resolveStorage`/`createDurableEventHistory` pair, rather than reusing a
 * handle this fixture already closed.
 */
export interface DurableEventHistoryFixture {
  /** The owned storage fixture backing the seeded backend. */
  readonly storage: BureauStorageFixture<StorageConfiguration>;
  /** The runtime the seed was recorded under — reuse it to reopen with the same clock. */
  readonly runtime: RuntimeServices;
  /**
   * The envelopes `history.record()` returned for each entry of the
   * sequence, in order — the authoritative "known, versioned" shape a
   * consumer diffs a real replay against, rather than re-deriving expected
   * `sequence`/`cursor`/`schemaVersion` values by hand.
   */
  readonly envelopes: readonly DurableEventEnvelope[];
  /**
   * Removes the backend's allocated path (a no-op when the caller supplied
   * `options.path` — see {@link DurableEventHistoryFixtureOptions.path}).
   */
  dispose(): Promise<void>;
}

/**
 * Seeds {@link DURABLE_EVENT_HISTORY_FIXTURE_SEQUENCE} (or
 * `options.sequence`) into a fresh SQLite or LMDB backend, in order,
 * through a real `createDurableEventHistory` instance — the same
 * production write path `createDurableEventProducer` uses, never a direct
 * `FleetEventFeed.append`. The writing instance and its `Storage` handle
 * are disposed before this resolves, so the returned `storage` fixture's
 * `configuration` is immediately safe to reopen for a restart-durability
 * assertion.
 */
export async function createDurableEventHistoryFixture(
  options: DurableEventHistoryFixtureOptions,
): Promise<DurableEventHistoryFixture> {
  const runtime = options.runtime ?? createManualRuntimeServices();
  const sequence = options.sequence ?? DURABLE_EVENT_HISTORY_FIXTURE_SEQUENCE;

  const storageFixture =
    options.backend === 'sqlite'
      ? createSqliteStorageFixture({ runtime, path: options.path })
      : createLmdbStorageFixture({ runtime, path: options.path });

  let storage: Storage | undefined;
  try {
    storage = await resolveStorage(storageFixture.configuration);
    const history: DurableEventHistory = createDurableEventHistory(storage, runtime);
    const envelopes: DurableEventEnvelope[] = [];
    try {
      for (const record of sequence) {
        envelopes.push(await history.record(record.owner, record.kind, record.payload));
      }
    } finally {
      await history.dispose();
    }

    return {
      storage: storageFixture,
      runtime,
      envelopes,
      dispose: () => storageFixture.dispose(),
    };
  } catch (error) {
    // Best-effort cleanup, mirroring `createBureauTestHarness`'s own
    // `disposeQuietly` (`./harness.ts`): a failure while cleaning up after
    // the ORIGINAL seeding error must never replace it — the caller needs
    // to see why seeding failed, not why disposal also failed.
    try {
      await storageFixture.dispose();
    } catch {
      // Swallowed deliberately — see the comment above.
    }
    throw error;
  } finally {
    storage?.[Symbol.dispose]();
  }
}

/**
 * The wrapper `durable-event-history.ts` itself stamps onto every stored
 * `FleetEventInput.payload` — duplicated here (rather than imported) only
 * because the module does not export it: this fixture is deliberately
 * producing a record shape `record()` itself would never write, so it
 * mirrors the wrapper structurally instead of reaching into the module's
 * private surface.
 */
interface StoredDurableEventPayloadFixtureShape {
  readonly schemaVersion: number;
  readonly payload: unknown;
}

/**
 * Directly appends a durable event record carrying an arbitrary
 * `schemaVersion` — deliberately bypassing `DurableEventHistory.record()`
 * (which always stamps the CURRENT version) — for the event-schema
 * compatibility fixture this issue's acceptance criteria names: proving a
 * deliberately older/malformed-shaped record is rejected exactly as
 * `UnsupportedDurableEventSchemaVersionError`
 * (`packages/bureau/src/durable-event-history.ts`) specifies, not
 * silently coerced. Mirrors the raw-`FleetEventFeed`-append pattern
 * `durable-event-history.test.ts`'s own schema-version-mismatch test
 * already uses (AB-313), factored out here for reuse.
 *
 * Opens and disposes its OWN short-lived `FleetEventFeed` over `storage` —
 * never the caller's own `DurableEventHistory` instance's feed, which has
 * no lower-level "append this exact raw shape" primitive to reach through.
 */
export async function seedSchemaVersionMismatchRecord(
  storage: Storage,
  owner: DurableEventOwner,
  kind: string,
  schemaVersion: number,
  payload: unknown,
): Promise<void> {
  const rawFeed: FleetEventFeed = createFleetEventFeed(storage);
  const stored: StoredDurableEventPayloadFixtureShape = { schemaVersion, payload };
  try {
    await rawFeed.append({
      kind,
      workflowId: `${owner.kind}:${owner.id}`,
      emittedAtMs: 0,
      payload: stored,
    });
  } finally {
    rawFeed.dispose();
  }
}
