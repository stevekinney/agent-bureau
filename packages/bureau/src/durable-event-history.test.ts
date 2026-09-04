/**
 * Tests for `createDurableEventHistory` (AB-91's `ab91-01` slice, AB-310).
 *
 * Uses `resolveStorage({ type: 'memory' })` directly for the ordering/gap/
 * validation tests — `MemoryStorage` implements the same `Storage` contract
 * `FleetEventFeed` requires (`conditionalBatch`), so no real backend is
 * needed to prove owner-filtering, cursor, and retention-floor logic. The
 * SQLite and LMDB restart-durability tests reuse AB-261's
 * `createSqliteStorageFixture`/`createLmdbStorageFixture` fixtures — no new
 * storage-fixture code — and never sleep: every ordering assertion relies
 * on `createManualRuntimeServices()`'s manual clock.
 */
import {
  AgentScheduledEvent,
  ScheduleCancelledEvent,
  ScheduleCompletedEvent,
  ScheduleFailedEvent,
  SchedulePausedEvent,
  ScheduleResumedEvent,
} from '@lostgradient/operative';
import type { DurableEventEnvelope, DurableEventOwner } from '@lostgradient/operative/durable';
import type { Subscription } from '@lostgradient/operative/liveness';
import type { Action } from '@lostgradient/operative/store';
import { createFleetEventFeed, type FleetEventFeed } from '@lostgradient/weft/server/handler';
import { KEYS, resolveStorage, type Storage } from '@lostgradient/weft/storage';
import { describe, expect, it } from 'bun:test';
import { CompletableEventTarget, createManualRuntimeServices } from 'lifecycle';

import {
  createDurableEventHistory,
  createDurableEventProducer,
  DEFAULT_PAGE_LIMIT,
  type DurableEventHistory,
} from './durable-event-history';
import {
  ActionEvent,
  type BureauEventMap,
  ReviewApprovedEvent,
  ReviewCanceledEvent,
  ReviewDeniedEvent,
  ReviewExpiredEvent,
  ReviewRejectedEvent,
  ReviewRevokedEvent,
  ReviewSupersededEvent,
} from './events';
import { createLmdbStorageFixture, createSqliteStorageFixture } from './test/storage-fixtures';
import type { Bureau, BureauDiagnostic } from './types';

async function createMemoryStorage(): Promise<Storage> {
  return resolveStorage({ type: 'memory' });
}

/**
 * Wraps `storage` so its FIRST `get(gateKey)` call blocks until the test
 * calls `release()` — used to force a deterministic (never real-timing)
 * append in the exact window between `subscribeEventHistory`'s underlying
 * `FleetEventFeed.subscribe()` snapshotting the fleet's tail sequence and
 * that same call's first replay read, which is `loadConsistentReplayPage`'s
 * `storage.get(KEYS.fleetEventWatermark())` (weft's
 * `replay-live-feed-internals.ts`/`fleet-event-feed.ts`) — the concrete
 * read this module's own `page()` performs too, for the retention-floor
 * check, but `subscribeEventHistory` never calls `snapshotRetentionFloor()`
 * itself (see its own doc comment), so gating this key only ever catches
 * weft's own replay read, never a second, competing read from this module.
 *
 * Deliberately does NOT gate `get(KEYS.fleetEventTail())` (used by
 * `snapshotTailSequence()`, called BEFORE the watermark read) or any
 * `conditionalBatch`/scan a concurrent `history.record()` needs — gating
 * either would deadlock the concurrent writer against the very read it is
 * supposed to race.
 */
function createReplayGateBarrier(
  storage: Storage,
  gateKey: string,
): { readonly storage: Storage; waitUntilGated(): Promise<void>; release(): void } {
  let hasGated = false;
  let resolveGated!: () => void;
  const gated = new Promise<void>((resolve) => {
    resolveGated = resolve;
  });
  let resolveReleased!: () => void;
  const released = new Promise<void>((resolve) => {
    resolveReleased = resolve;
  });

  const gatedStorage = new Proxy(storage, {
    get(target, property, receiver) {
      if (property === 'get') {
        return async (key: string): Promise<Uint8Array | null> => {
          if (!hasGated && key === gateKey) {
            hasGated = true;
            resolveGated();
            await released;
          }
          return target.get(key);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  return {
    storage: gatedStorage,
    waitUntilGated: () => gated,
    release: () => {
      resolveReleased();
    },
  };
}

/**
 * A deterministic, non-polling collector for `subscribeEventHistory`
 * tests: every wait resolves from a callback the listener/diagnostic sink
 * itself triggers (never a real timer, never a fixed-iteration retry
 * loop).
 */
function createCollector(): {
  readonly events: DurableEventEnvelope[];
  push(event: DurableEventEnvelope): void;
  waitForCount(count: number): Promise<void>;
  waitForSequence(sequence: number): Promise<void>;
  waitForClosed(subscription: Subscription): Promise<void>;
} {
  const events: DurableEventEnvelope[] = [];
  let onPush: (() => void) | undefined;

  function push(event: DurableEventEnvelope): void {
    events.push(event);
    onPush?.();
  }

  async function waitForCount(count: number): Promise<void> {
    while (events.length < count) {
      await new Promise<void>((resolve) => {
        onPush = resolve;
      });
    }
  }

  async function waitForSequence(sequence: number): Promise<void> {
    while (!events.some((event) => event.sequence >= sequence)) {
      await new Promise<void>((resolve) => {
        onPush = resolve;
      });
    }
  }

  async function waitForClosed(subscription: Subscription): Promise<void> {
    // `closed` flips inside the subscription's own `finally` block, which
    // runs strictly after the abort listener's synchronous work — polling
    // the microtask queue observes that completion without a real timer.
    while (!subscription.closed) {
      await Promise.resolve();
    }
  }

  return { events, push, waitForCount, waitForSequence, waitForClosed };
}

describe('createDurableEventHistory', () => {
  describe('record()', () => {
    it('stamps owner into workflowId and returns the decoded envelope', async () => {
      const storage = await createMemoryStorage();
      const runtime = createManualRuntimeServices();
      const history = createDurableEventHistory(storage, runtime);

      runtime.setTime(Date.parse('2026-09-03T00:00:00.000Z'));
      const envelope = await history.record({ kind: 'run', id: 'run-1' }, 'tool.started', {
        toolName: 'search',
      });

      expect(envelope.kind).toBe('tool.started');
      expect(envelope.owner).toEqual({ kind: 'run', id: 'run-1' });
      expect(envelope.sequence).toBe(0);
      expect(envelope.cursor).toBe('0');
      expect(envelope.emittedAtMs).toBe(Date.parse('2026-09-03T00:00:00.000Z'));
      expect(envelope.payload).toEqual({ toolName: 'search' });
      expect(envelope.schemaVersion).toBe(1);

      await history.dispose();
    });

    it('round-trips an id containing a colon', async () => {
      const storage = await createMemoryStorage();
      const runtime = createManualRuntimeServices();
      const history = createDurableEventHistory(storage, runtime);

      const owner = { kind: 'session' as const, id: 'sess:with:colons' };
      await history.record(owner, 'session.created', { hello: 'world' });

      const page = await history.page(owner);
      if ('outcome' in page) throw new Error('expected a page, got a gap');
      expect(page.events).toHaveLength(1);
      expect(page.events[0]?.owner).toEqual(owner);

      await history.dispose();
    });
  });

  describe('page() ordering and owner filtering', () => {
    it('returns events in sequence order for one owner while interleaved events from a second owner produce legal gaps', async () => {
      const storage = await createMemoryStorage();
      const runtime = createManualRuntimeServices();
      const history = createDurableEventHistory(storage, runtime);

      const runA = { kind: 'run' as const, id: 'run-a' };
      const runB = { kind: 'run' as const, id: 'run-b' };

      await history.record(runA, 'run.started', { step: 0 }); // sequence 0
      await history.record(runB, 'run.started', { step: 0 }); // sequence 1
      await history.record(runA, 'tool.started', { step: 1 }); // sequence 2
      await history.record(runB, 'tool.started', { step: 1 }); // sequence 3
      await history.record(runA, 'run.completed', { step: 2 }); // sequence 4

      const page = await history.page(runA);
      if ('outcome' in page) throw new Error('expected a page, got a gap');

      expect(page.events.map((event) => event.sequence)).toEqual([0, 2, 4]);
      expect(page.events.map((event) => event.kind)).toEqual([
        'run.started',
        'tool.started',
        'run.completed',
      ]);
      expect(page.hasMore).toBe(false);
      expect(page.nextCursor).toBe('4');

      await history.dispose();
    });

    it('honors an exclusive since cursor', async () => {
      const storage = await createMemoryStorage();
      const runtime = createManualRuntimeServices();
      const history = createDurableEventHistory(storage, runtime);
      const owner = { kind: 'run' as const, id: 'run-1' };

      const first = await history.record(owner, 'run.started', {});
      await history.record(owner, 'step.completed', {});

      const page = await history.page(owner, { since: first.cursor });
      if ('outcome' in page) throw new Error('expected a page, got a gap');
      expect(page.events.map((event) => event.kind)).toEqual(['step.completed']);

      await history.dispose();
    });

    it('bounds the page by limit and reports hasMore', async () => {
      const storage = await createMemoryStorage();
      const runtime = createManualRuntimeServices();
      const history = createDurableEventHistory(storage, runtime);
      const owner = { kind: 'run' as const, id: 'run-1' };

      for (let index = 0; index < 5; index += 1) {
        await history.record(owner, 'step.completed', { index });
      }

      const firstPage = await history.page(owner, { limit: 2 });
      if ('outcome' in firstPage) throw new Error('expected a page, got a gap');
      expect(firstPage.events).toHaveLength(2);
      expect(firstPage.hasMore).toBe(true);
      expect(firstPage.nextCursor).toBe(firstPage.events[1]?.cursor);

      const secondPage = await history.page(owner, {
        since: firstPage.nextCursor,
        limit: 2,
      });
      if ('outcome' in secondPage) throw new Error('expected a page, got a gap');
      expect(secondPage.events).toHaveLength(2);
      expect(secondPage.hasMore).toBe(true);

      const thirdPage = await history.page(owner, {
        since: secondPage.nextCursor,
        limit: 2,
      });
      if ('outcome' in thirdPage) throw new Error('expected a page, got a gap');
      expect(thirdPage.events).toHaveLength(1);
      expect(thirdPage.hasMore).toBe(false);

      await history.dispose();
    });

    it('uses DEFAULT_PAGE_LIMIT when limit is omitted', async () => {
      const storage = await createMemoryStorage();
      const runtime = createManualRuntimeServices();
      const history = createDurableEventHistory(storage, runtime);
      const owner = { kind: 'run' as const, id: 'run-1' };

      for (let index = 0; index < DEFAULT_PAGE_LIMIT + 1; index += 1) {
        await history.record(owner, 'step.completed', { index });
      }

      const page = await history.page(owner);
      if ('outcome' in page) throw new Error('expected a page, got a gap');
      expect(page.events).toHaveLength(DEFAULT_PAGE_LIMIT);
      expect(page.hasMore).toBe(true);

      await history.dispose();
    });

    it('returns an ordinary empty page — not a gap — when the owner is caught up and retention has not advanced', async () => {
      const storage = await createMemoryStorage();
      const runtime = createManualRuntimeServices();
      const history = createDurableEventHistory(storage, runtime);
      const owner = { kind: 'run' as const, id: 'run-1' };

      const recorded = await history.record(owner, 'run.started', {});
      const page = await history.page(owner, { since: recorded.cursor });

      expect(page).toEqual({ events: [], hasMore: false });

      await history.dispose();
    });

    it('returns an empty page for an owner with no events at all', async () => {
      const storage = await createMemoryStorage();
      const runtime = createManualRuntimeServices();
      const history = createDurableEventHistory(storage, runtime);

      await history.record({ kind: 'run', id: 'run-a' }, 'run.started', {});

      const page = await history.page({ kind: 'run', id: 'run-b' });
      expect(page).toEqual({ events: [], hasMore: false });

      await history.dispose();
    });

    it('rejects a non-positive-integer limit', async () => {
      const storage = await createMemoryStorage();
      const runtime = createManualRuntimeServices();
      const history = createDurableEventHistory(storage, runtime);
      const owner = { kind: 'run' as const, id: 'run-1' };

      expect(history.page(owner, { limit: 0 })).rejects.toThrow(RangeError);
      expect(history.page(owner, { limit: -1 })).rejects.toThrow(RangeError);
      expect(history.page(owner, { limit: 1.5 })).rejects.toThrow(RangeError);

      await history.dispose();
    });

    it('rejects a malformed since cursor', async () => {
      const storage = await createMemoryStorage();
      const runtime = createManualRuntimeServices();
      const history = createDurableEventHistory(storage, runtime);
      const owner = { kind: 'run' as const, id: 'run-1' };

      expect(history.page(owner, { since: 'not-a-cursor' })).rejects.toThrow();

      await history.dispose();
    });

    it('rejects a since cursor whose digits exceed the safe-integer range', async () => {
      const storage = await createMemoryStorage();
      const runtime = createManualRuntimeServices();
      const history = createDurableEventHistory(storage, runtime);
      const owner = { kind: 'run' as const, id: 'run-1' };

      expect(history.page(owner, { since: '99999999999999999999' })).rejects.toThrow(
        /invalid cursor/,
      );

      await history.dispose();
    });
  });

  describe('page() retention-floor gap', () => {
    it('returns a gap, distinguishable from an empty page, when since predates the retention floor', async () => {
      const storage = await createMemoryStorage();
      const runtime = createManualRuntimeServices();
      const history = createDurableEventHistory(storage, runtime);
      const owner = { kind: 'run' as const, id: 'run-1' };

      const first = await history.record(owner, 'run.started', {}); // sequence 0
      await history.record(owner, 'step.completed', {}); // sequence 1
      await history.record(owner, 'run.completed', {}); // sequence 2

      // Retire sequences 0 and 1 by advancing the retention floor to 2
      // from a second feed sharing the same storage — legitimate multi-
      // consumer access (WFT-83 made the fleet feed safe over shared
      // storage), and this module deliberately does not expose `retain()`
      // itself. `first.cursor` ("0") now predates the new floor.
      const adminFeed: FleetEventFeed = createFleetEventFeed(storage);
      const retained = await adminFeed.retain({ beforeSequence: 2 });
      expect(retained).toBe(2);
      adminFeed.dispose();

      const gap = await history.page(owner, { since: first.cursor });
      expect(gap).toEqual({
        outcome: 'gap',
        requestedCursor: first.cursor,
        firstRetainedSequence: 2,
      });

      await history.dispose();
    });

    it('gaps a cursorless caller too, when retention has already advanced past the beginning', async () => {
      const storage = await createMemoryStorage();
      const runtime = createManualRuntimeServices();
      const history = createDurableEventHistory(storage, runtime);
      const owner = { kind: 'run' as const, id: 'run-1' };

      await history.record(owner, 'run.started', {});
      await history.record(owner, 'step.completed', {});

      const adminFeed: FleetEventFeed = createFleetEventFeed(storage);
      await adminFeed.retain({ beforeSequence: 1 });
      adminFeed.dispose();

      const gap = await history.page(owner);
      expect(gap).toEqual({
        outcome: 'gap',
        requestedCursor: '-1',
        firstRetainedSequence: 1,
      });

      await history.dispose();
    });
  });

  describe('corrupt/unrecognized record handling', () => {
    it('never surfaces an event with no workflowId through an owner-scoped page', async () => {
      const storage = await createMemoryStorage();
      const runtime = createManualRuntimeServices();
      const history = createDurableEventHistory(storage, runtime);

      // A record written by something else entirely (no workflowId at
      // all) can never match `page()`'s exact-string-match owner filter,
      // so it is silently excluded rather than causing a decode failure —
      // proving the filter, independent of this store's own writes.
      const rawFeed: FleetEventFeed = createFleetEventFeed(storage);
      await rawFeed.append({ kind: 'fleet:other', emittedAtMs: 0, payload: {} });
      rawFeed.dispose();

      const page = await history.page({ kind: 'run', id: 'run-1' });
      expect(page).toEqual({ events: [], hasMore: false });

      await history.dispose();
    });

    it('skips a fleet event whose payload is not the stored-wrapper shape, diagnosing rather than aborting the page (AB-313)', async () => {
      const storage = await createMemoryStorage();
      const runtime = createManualRuntimeServices();
      const diagnostics: BureauDiagnostic[] = [];
      const history = createDurableEventHistory(storage, runtime, (diagnostic) => {
        diagnostics.push(diagnostic);
      });
      const owner = { kind: 'run' as const, id: 'run-1' };

      const good1 = await history.record(owner, 'run.started', {});

      const rawFeed: FleetEventFeed = createFleetEventFeed(storage);
      await rawFeed.append({
        kind: 'legacy.kind',
        workflowId: 'run:run-1',
        emittedAtMs: 0,
        payload: 'not-a-wrapper',
      });
      rawFeed.dispose();

      const good2 = await history.record(owner, 'run.completed', {});

      const page = await history.page(owner);
      expect(page).toEqual({
        events: [good1, good2],
        hasMore: false,
        nextCursor: good2.cursor,
      });
      expect(
        diagnostics.some((diagnostic) =>
          diagnostic.message.includes('Skipped corrupt durable record'),
        ),
      ).toBe(true);

      await history.dispose();
    });

    it('skips a stored record with an unrecognized schemaVersion, diagnosing rather than aborting the page (AB-313)', async () => {
      const storage = await createMemoryStorage();
      const runtime = createManualRuntimeServices();
      const diagnostics: BureauDiagnostic[] = [];
      const history = createDurableEventHistory(storage, runtime, (diagnostic) => {
        diagnostics.push(diagnostic);
      });
      const owner = { kind: 'run' as const, id: 'run-1' };

      const good1 = await history.record(owner, 'run.started', {});

      const rawFeed: FleetEventFeed = createFleetEventFeed(storage);
      await rawFeed.append({
        kind: 'run.error',
        workflowId: 'run:run-1',
        emittedAtMs: 0,
        payload: { schemaVersion: 999, payload: { bogus: true } },
      });
      rawFeed.dispose();

      const good2 = await history.record(owner, 'run.completed', {});

      const page = await history.page(owner);
      expect(page).toEqual({
        events: [good1, good2],
        hasMore: false,
        nextCursor: good2.cursor,
      });
      expect(
        diagnostics.some((diagnostic) =>
          diagnostic.message.includes('Skipped corrupt durable record'),
        ),
      ).toBe(true);

      await history.dispose();
    });

    it('never reports hasMore: true because of a corrupt record sitting at the limit boundary with nothing valid after it (copilot review, PR #551)', async () => {
      const storage = await createMemoryStorage();
      const runtime = createManualRuntimeServices();
      const history = createDurableEventHistory(storage, runtime);
      const owner = { kind: 'run' as const, id: 'run-1' };

      const good1 = await history.record(owner, 'run.started', {});

      const rawFeed: FleetEventFeed = createFleetEventFeed(storage);
      await rawFeed.append({
        kind: 'legacy.kind',
        workflowId: 'run:run-1',
        emittedAtMs: 0,
        payload: 'not-a-wrapper',
      });
      rawFeed.dispose();

      // limit: 1 — exactly `good1`'s count. The only record after it is
      // corrupt and skipped, so there is genuinely nothing more to page to.
      const page = await history.page(owner, { limit: 1 });
      expect(page).toEqual({ events: [good1], hasMore: false, nextCursor: good1.cursor });

      await history.dispose();
    });

    it('reports hasMore: true when a genuine valid record follows a corrupt one at the limit boundary', async () => {
      const storage = await createMemoryStorage();
      const runtime = createManualRuntimeServices();
      const history = createDurableEventHistory(storage, runtime);
      const owner = { kind: 'run' as const, id: 'run-1' };

      const good1 = await history.record(owner, 'run.started', {});

      const rawFeed: FleetEventFeed = createFleetEventFeed(storage);
      await rawFeed.append({
        kind: 'legacy.kind',
        workflowId: 'run:run-1',
        emittedAtMs: 0,
        payload: 'not-a-wrapper',
      });
      rawFeed.dispose();

      await history.record(owner, 'run.completed', {}); // a real record beyond the limit

      const page = await history.page(owner, { limit: 1 });
      expect(page).toEqual({ events: [good1], hasMore: true, nextCursor: good1.cursor });

      await history.dispose();
    });
  });

  describe('dispose()', () => {
    it('is safe to call more than once', async () => {
      const storage = await createMemoryStorage();
      const runtime = createManualRuntimeServices();
      const history: DurableEventHistory = createDurableEventHistory(storage, runtime);

      await history.dispose();
      await history.dispose();
    });
  });

  describe('restart durability', () => {
    it('survives reopening the same SQLite backend across two independently constructed instances', async () => {
      const runtime = createManualRuntimeServices();
      const fixture = createSqliteStorageFixture({ runtime });
      const owner = { kind: 'run' as const, id: 'run-1' };

      try {
        const storage1 = await resolveStorage(fixture.configuration);
        const history1 = createDurableEventHistory(storage1, runtime);
        await history1.record(owner, 'run.started', { attempt: 1 });
        await history1.record(owner, 'step.completed', { attempt: 1 });
        await history1.dispose();
        storage1[Symbol.dispose]();

        const storage2 = await resolveStorage(fixture.configuration);
        const history2 = createDurableEventHistory(storage2, runtime);
        const page = await history2.page(owner);
        if ('outcome' in page) throw new Error('expected a page, got a gap');

        expect(page.events.map((event) => event.kind)).toEqual(['run.started', 'step.completed']);
        expect(page.events.map((event) => event.sequence)).toEqual([0, 1]);

        await history2.dispose();
        storage2[Symbol.dispose]();
      } finally {
        await fixture.dispose();
      }
    });

    it('survives reopening the same SQLite backend across two independently constructed instances for a schedule owner (AB-320)', async () => {
      const runtime = createManualRuntimeServices();
      const fixture = createSqliteStorageFixture({ runtime });
      const owner = { kind: 'schedule' as const, id: 'sched-1' };

      try {
        const storage1 = await resolveStorage(fixture.configuration);
        const history1 = createDurableEventHistory(storage1, runtime);
        await history1.record(owner, 'schedule.created', { scheduleId: 'sched-1' });
        await history1.record(owner, 'schedule.paused', { scheduleId: 'sched-1' });
        await history1.dispose();
        storage1[Symbol.dispose]();

        const storage2 = await resolveStorage(fixture.configuration);
        const history2 = createDurableEventHistory(storage2, runtime);
        const page = await history2.page(owner);
        if ('outcome' in page) throw new Error('expected a page, got a gap');

        expect(page.events.map((event) => event.kind)).toEqual([
          'schedule.created',
          'schedule.paused',
        ]);
        expect(page.events.map((event) => event.sequence)).toEqual([0, 1]);

        await history2.dispose();
        storage2[Symbol.dispose]();
      } finally {
        await fixture.dispose();
      }
    });

    it('survives reopening the same LMDB backend across two independently constructed instances', async () => {
      const runtime = createManualRuntimeServices();
      const fixture = createLmdbStorageFixture({ runtime });
      const owner = { kind: 'session' as const, id: 'session-1' };

      try {
        const storage1 = await resolveStorage(fixture.configuration);
        const history1 = createDurableEventHistory(storage1, runtime);
        await history1.record(owner, 'session.created', { attempt: 1 });
        await history1.record(owner, 'session.deleted', { attempt: 1 });
        await history1.dispose();
        // LMDB's single-writer lock: the first handle must be fully closed
        // before a second handle opens the same directory, or the second
        // open deadlocks (per the fixture's own doc comment).
        storage1[Symbol.dispose]();

        const storage2 = await resolveStorage(fixture.configuration);
        const history2 = createDurableEventHistory(storage2, runtime);
        const page = await history2.page(owner);
        if ('outcome' in page) throw new Error('expected a page, got a gap');

        expect(page.events.map((event) => event.kind)).toEqual([
          'session.created',
          'session.deleted',
        ]);
        expect(page.events.map((event) => event.sequence)).toEqual([0, 1]);

        await history2.dispose();
        storage2[Symbol.dispose]();
      } finally {
        await fixture.dispose();
      }
    });
  });

  describe('subscribeEventHistory()', () => {
    it('never starts work: a fresh, never-appended-to owner replays zero events and then waits live with no error', async () => {
      const storage = await createMemoryStorage();
      const runtime = createManualRuntimeServices();
      const history = createDurableEventHistory(storage, runtime);
      const owner = { kind: 'run' as const, id: 'run-1' };

      const collector = createCollector();
      const subscription = history.subscribeEventHistory(owner, collector.push);
      expect(subscription.closed).toBe(false);
      expect(collector.events).toEqual([]);

      // Prove the subscription is genuinely live (not merely "hasn't
      // crashed yet") by recording a real event through it — never-
      // starts-work is a claim about what happens BEFORE any event
      // exists, not about the subscription being inert forever.
      const recorded = await history.record(owner, 'run.started', {});
      await collector.waitForSequence(recorded.sequence);
      expect(collector.events.map((event) => event.kind)).toEqual(['run.started']);

      subscription.unsubscribe();
      await history.dispose();
    });

    it('replays existing history in order, then continues with live events, with no gap or duplicate', async () => {
      const storage = await createMemoryStorage();
      const runtime = createManualRuntimeServices();
      const history = createDurableEventHistory(storage, runtime);
      const owner = { kind: 'run' as const, id: 'run-1' };

      await history.record(owner, 'run.started', { step: 0 });
      await history.record(owner, 'step.completed', { step: 0 });

      const collector = createCollector();
      const subscription = history.subscribeEventHistory(owner, collector.push);

      await collector.waitForCount(2);
      expect(collector.events.map((event) => event.kind)).toEqual([
        'run.started',
        'step.completed',
      ]);

      const third = await history.record(owner, 'run.completed', { step: 1 });
      await collector.waitForSequence(third.sequence);
      expect(collector.events.map((event) => event.kind)).toEqual([
        'run.started',
        'step.completed',
        'run.completed',
      ]);

      subscription.unsubscribe();
      await history.dispose();
    });

    it('honors an exclusive since cursor: the event AT since is never replayed, only what comes strictly after it', async () => {
      const storage = await createMemoryStorage();
      const runtime = createManualRuntimeServices();
      const history = createDurableEventHistory(storage, runtime);
      const owner = { kind: 'run' as const, id: 'run-1' };

      const first = await history.record(owner, 'run.started', {});
      const second = await history.record(owner, 'step.completed', {});

      const collector = createCollector();
      const subscription = history.subscribeEventHistory(owner, collector.push, {
        since: first.cursor,
      });

      await collector.waitForSequence(second.sequence);
      // Exclusive: `first` itself never arrives, only `second` (and later
      // live events) — proving `since` behaves the same way here as it
      // already does for `page()`'s own exclusive cursor.
      expect(collector.events.map((event) => event.kind)).toEqual(['step.completed']);

      const third = await history.record(owner, 'run.completed', {});
      await collector.waitForSequence(third.sequence);
      expect(collector.events.map((event) => event.kind)).toEqual([
        'step.completed',
        'run.completed',
      ]);

      subscription.unsubscribe();
      await history.dispose();
    });

    it('never delivers another owner’s events', async () => {
      const storage = await createMemoryStorage();
      const runtime = createManualRuntimeServices();
      const history = createDurableEventHistory(storage, runtime);
      const owner = { kind: 'run' as const, id: 'run-a' };
      const otherOwner = { kind: 'run' as const, id: 'run-b' };

      const collector = createCollector();
      const subscription = history.subscribeEventHistory(owner, collector.push);

      await history.record(otherOwner, 'run.started', {});
      const last = await history.record(owner, 'run.started', {});

      // A cursor-carrying event for THIS owner proves the live leg has
      // caught up through (at least) `last`'s sequence without needing a
      // real sleep: the owner filter would have delivered `otherOwner`'s
      // event too, at the same point in the stream, if it were broken.
      await collector.waitForSequence(last.sequence);
      expect(collector.events.map((event) => event.owner)).toEqual([owner]);

      subscription.unsubscribe();
      await history.dispose();
    });

    it('delivers an event committed during the replay-to-live handoff exactly once — a manual barrier, never real timing', async () => {
      const rawStorage = await createMemoryStorage();
      const barrier = createReplayGateBarrier(rawStorage, KEYS.fleetEventWatermark());
      const runtime = createManualRuntimeServices();
      const history = createDurableEventHistory(barrier.storage, runtime);
      const owner = { kind: 'run' as const, id: 'run-1' };

      const collector = createCollector();
      const subscription = history.subscribeEventHistory(owner, collector.push);

      // Block the underlying replay exactly at its first storage read —
      // AFTER the fleet's tail sequence has been snapshotted (Weft's own
      // `snapshotTailSequence()`, a different key) but BEFORE the replay
      // leg consumes anything. Appending here, through the SAME
      // `history`/feed so the live leg's storage re-read (not a poll
      // timer) is guaranteed to observe it, forces exactly the race this
      // test exists to prove deterministic delivery for.
      await barrier.waitUntilGated();
      const eventA = await history.record(owner, 'run.completed', { step: 1 });
      barrier.release();

      await collector.waitForSequence(eventA.sequence);
      expect(collector.events.map((event) => event.kind)).toEqual(['run.completed']);

      // Prove no duplicate by observing a SECOND, distinguishable live
      // event arrive cleanly after the first, rather than checking a
      // count at one instant.
      const eventB = await history.record(owner, 'run.aborted', { step: 2 });
      await collector.waitForSequence(eventB.sequence);
      expect(collector.events.map((event) => event.kind)).toEqual(['run.completed', 'run.aborted']);

      subscription.unsubscribe();
      await history.dispose();
    });

    it('delivers the full event set to each of multiple independent subscribers, unaffected by another’s disposal', async () => {
      const storage = await createMemoryStorage();
      const runtime = createManualRuntimeServices();
      const history = createDurableEventHistory(storage, runtime);
      const owner = { kind: 'run' as const, id: 'run-1' };

      const first = await history.record(owner, 'run.started', {});

      const collectorA = createCollector();
      const subscriptionA = history.subscribeEventHistory(owner, collectorA.push);
      await collectorA.waitForSequence(first.sequence);

      const collectorB = createCollector();
      const subscriptionB = history.subscribeEventHistory(owner, collectorB.push);
      await collectorB.waitForSequence(first.sequence);

      // Dispose A; B must keep receiving events undisturbed.
      subscriptionA.unsubscribe();
      expect(subscriptionA.closed).toBe(true);

      const second = await history.record(owner, 'run.completed', {});
      await collectorB.waitForSequence(second.sequence);
      expect(collectorB.events.map((event) => event.kind)).toEqual([
        'run.started',
        'run.completed',
      ]);

      // A received nothing past its own disposal.
      expect(collectorA.events.map((event) => event.kind)).toEqual(['run.started']);

      // The underlying feed is unaffected by A's disposal — a THIRD,
      // brand-new subscription still works.
      const collectorC = createCollector();
      const subscriptionC = history.subscribeEventHistory(owner, collectorC.push);
      await collectorC.waitForSequence(second.sequence);
      expect(collectorC.events.map((event) => event.kind)).toEqual([
        'run.started',
        'run.completed',
      ]);

      subscriptionB.unsubscribe();
      subscriptionC.unsubscribe();
      await history.dispose();
    });

    it('ends the subscription when the passed AbortSignal aborts', async () => {
      const storage = await createMemoryStorage();
      const runtime = createManualRuntimeServices();
      const history = createDurableEventHistory(storage, runtime);
      const owner = { kind: 'run' as const, id: 'run-1' };

      const controller = new AbortController();
      const collector = createCollector();
      const subscription = history.subscribeEventHistory(owner, collector.push, {
        signal: controller.signal,
      });

      // The subscription's own internal generator only observes the abort
      // once it resumes (weft's `createDurableSubscription` checks
      // `signal?.aborted` at the top of each loop iteration, awaited
      // inside `waitForAppendOrPoll`) — recording a first, harmless event
      // BEFORE aborting gives the loop a deterministic point to resume at
      // and notice the signal, rather than racing whether the abort
      // listener or the initial replay runs first.
      const before = await history.record(owner, 'run.started', {});
      await collector.waitForSequence(before.sequence);

      controller.abort();
      await collector.waitForClosed(subscription);
      expect(subscription.closed).toBe(true);

      await history.record(owner, 'run.completed', {});
      // Nothing further arrives — proven by disposing and observing the
      // collector's event count is unchanged after the store itself is
      // torn down (a duplicate/late delivery would have landed by then).
      await history.dispose();
      expect(collector.events.map((event) => event.kind)).toEqual(['run.started']);
    });

    it('rejects a malformed since cursor synchronously, before any replay starts', async () => {
      const storage = await createMemoryStorage();
      const runtime = createManualRuntimeServices();
      const history = createDurableEventHistory(storage, runtime);
      const owner = { kind: 'run' as const, id: 'run-1' };

      expect(() =>
        history.subscribeEventHistory(owner, () => {}, { since: 'not-a-cursor' }),
      ).toThrow();

      await history.dispose();
    });

    it('isolates a throwing listener: delivery continues for the next event', async () => {
      const storage = await createMemoryStorage();
      const runtime = createManualRuntimeServices();
      const diagnostics: BureauDiagnostic[] = [];
      const history = createDurableEventHistory(storage, runtime, (diagnostic) => {
        diagnostics.push(diagnostic);
      });
      const owner = { kind: 'run' as const, id: 'run-1' };

      const collector = createCollector();
      const subscription = history.subscribeEventHistory(owner, (event) => {
        collector.push(event);
        if (event.kind === 'run.started') {
          throw new Error('listener boom');
        }
      });

      const first = await history.record(owner, 'run.started', {});
      await collector.waitForSequence(first.sequence);

      const second = await history.record(owner, 'run.completed', {});
      await collector.waitForSequence(second.sequence);

      expect(collector.events.map((event) => event.kind)).toEqual(['run.started', 'run.completed']);
      expect(subscription.closed).toBe(false);
      expect(diagnostics.some((diagnostic) => diagnostic.message.includes('Listener threw'))).toBe(
        true,
      );

      subscription.unsubscribe();
      await history.dispose();
    });

    it('ends the subscription (via the diagnostic sink) when a stored record is corrupt, rather than throwing', async () => {
      const storage = await createMemoryStorage();
      const runtime = createManualRuntimeServices();
      let notifyDiagnosed: (() => void) | undefined;
      const diagnosed = new Promise<void>((resolve) => {
        notifyDiagnosed = resolve;
      });
      const diagnostics: BureauDiagnostic[] = [];
      const history = createDurableEventHistory(storage, runtime, (diagnostic) => {
        diagnostics.push(diagnostic);
        notifyDiagnosed?.();
      });
      const owner = { kind: 'run' as const, id: 'run-1' };

      const collector = createCollector();
      const subscription = history.subscribeEventHistory(owner, collector.push);

      const rawFeed: FleetEventFeed = createFleetEventFeed(storage);
      await rawFeed.append({
        kind: 'legacy.kind',
        workflowId: 'run:run-1',
        emittedAtMs: 0,
        payload: 'not-a-wrapper',
      });
      rawFeed.dispose();

      // The listener never fires (the corrupt record fails decode before
      // `listener` is called) — the diagnostic sink is the only signal.
      // `closed` itself flips slightly later, once returning out of the
      // `for await` loop drains the underlying async generator's own
      // `finally` (its iterator-return protocol), so wait for that too —
      // deterministically (microtask draining), never a real timer.
      await diagnosed;
      await collector.waitForClosed(subscription);

      expect(collector.events).toEqual([]);
      expect(subscription.closed).toBe(true);
      expect(
        diagnostics.some((diagnostic) => diagnostic.message.includes('corrupt durable record')),
      ).toBe(true);

      subscription.unsubscribe();
      await history.dispose();
    });

    it('ends the subscription (via the diagnostic sink) when the underlying replay itself rejects — not a value the listener ever sees', async () => {
      const storage = await createMemoryStorage();
      const runtime = createManualRuntimeServices();
      let notifyDiagnosed: (() => void) | undefined;
      const diagnosed = new Promise<void>((resolve) => {
        notifyDiagnosed = resolve;
      });
      const diagnostics: BureauDiagnostic[] = [];
      const history = createDurableEventHistory(storage, runtime, (diagnostic) => {
        diagnostics.push(diagnostic);
        notifyDiagnosed?.();
      });
      const owner = { kind: 'run' as const, id: 'run-1' };

      // Establish a valid record so `snapshotTailSequence()`/the retention
      // watermark are both present, then corrupt the STORED BYTES for that
      // record directly — this fails inside weft's own
      // `loadConsistentReplayPage` (`decodeStorageValue`/`isFleetEventEnvelope`),
      // rejecting the replay `AsyncIterable` itself, unlike the sibling test
      // above (a well-formed envelope whose PAYLOAD this module's own
      // `toDurableEventEnvelope` rejects, inside this module's loop body).
      await history.record(owner, 'run.started', {});
      await storage.put(KEYS.fleetEvent(0), new Uint8Array([1, 2, 3, 4]));

      const collector = createCollector();
      const subscription = history.subscribeEventHistory(owner, collector.push);

      await diagnosed;
      await collector.waitForClosed(subscription);

      expect(collector.events).toEqual([]);
      expect(subscription.closed).toBe(true);
      expect(
        diagnostics.some((diagnostic) => diagnostic.message.includes('ended with an error')),
      ).toBe(true);

      subscription.unsubscribe();
      await history.dispose();
    });

    it('silently skips a since predating the retention floor, delivering only what is still retained — unlike page(), which reports an explicit gap', async () => {
      const storage = await createMemoryStorage();
      const runtime = createManualRuntimeServices();
      const history = createDurableEventHistory(storage, runtime);
      const owner = { kind: 'run' as const, id: 'run-1' };

      const first = await history.record(owner, 'run.started', {}); // sequence 0
      await history.record(owner, 'step.completed', {}); // sequence 1
      const third = await history.record(owner, 'run.completed', {}); // sequence 2

      const adminFeed: FleetEventFeed = createFleetEventFeed(storage);
      await adminFeed.retain({ beforeSequence: 2 });
      adminFeed.dispose();

      // Confirm page() would report a gap for the very same since — the
      // contrast this test is named for.
      const gap = await history.page(owner, { since: first.cursor });
      expect(gap).toEqual({
        outcome: 'gap',
        requestedCursor: first.cursor,
        firstRetainedSequence: 2,
      });

      const collector = createCollector();
      const subscription = history.subscribeEventHistory(owner, collector.push);

      await collector.waitForSequence(third.sequence);
      expect(collector.events.map((event) => event.sequence)).toEqual([2]);

      subscription.unsubscribe();
      await history.dispose();
    });
  });
});

/**
 * A fake bureau event surface for `createDurableEventProducer()` unit
 * tests below — a real, typed `CompletableEventTarget<BureauEventMap>`
 * (the same base class `create-bureau.ts`'s own `emitter` uses), exposed
 * through the two methods `createDurableEventProducer` actually calls
 * (`addEventListener`/`removeEventListener` — verified by reading that
 * function's body, which touches no other `Bureau` member). Building a
 * full structural `Bureau` fake here would mean stubbing dozens of
 * unrelated members for a producer that only ever listens; the cast below
 * is narrow, load-bearing for this one call site, and ESLint's `as`/`any`
 * discipline is relaxed in test files (`testing-standards.md`).
 */
function createFakeBureauEventSurface(): {
  readonly bureau: Bureau;
  dispatchAction(action: Action): void;
  dispatchScheduleCompleted(event: ScheduleCompletedEvent): void;
  dispatchScheduleFailed(event: ScheduleFailedEvent): void;
  dispatchScheduleCreated(event: AgentScheduledEvent): void;
  dispatchSchedulePaused(event: SchedulePausedEvent): void;
  dispatchScheduleResumed(event: ScheduleResumedEvent): void;
  dispatchScheduleCancelled(event: ScheduleCancelledEvent): void;
  dispatchReviewApproved(event: ReviewApprovedEvent): void;
  dispatchReviewDenied(event: ReviewDeniedEvent): void;
  dispatchReviewRejected(event: ReviewRejectedEvent): void;
  dispatchReviewExpired(event: ReviewExpiredEvent): void;
  dispatchReviewRevoked(event: ReviewRevokedEvent): void;
  dispatchReviewCanceled(event: ReviewCanceledEvent): void;
  dispatchReviewSuperseded(event: ReviewSupersededEvent): void;
} {
  const target = new CompletableEventTarget<BureauEventMap>();
  const bureau = {
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
  } as unknown as Bureau;

  return {
    bureau,
    dispatchAction: (action) => {
      target.dispatch(new ActionEvent(action));
    },
    dispatchScheduleCompleted: (event) => {
      target.dispatch(event);
    },
    dispatchScheduleFailed: (event) => {
      target.dispatch(event);
    },
    dispatchScheduleCreated: (event) => {
      target.dispatch(event);
    },
    dispatchSchedulePaused: (event) => {
      target.dispatch(event);
    },
    dispatchScheduleResumed: (event) => {
      target.dispatch(event);
    },
    dispatchScheduleCancelled: (event) => {
      target.dispatch(event);
    },
    dispatchReviewApproved: (event) => {
      target.dispatch(event);
    },
    dispatchReviewDenied: (event) => {
      target.dispatch(event);
    },
    dispatchReviewRejected: (event) => {
      target.dispatch(event);
    },
    dispatchReviewExpired: (event) => {
      target.dispatch(event);
    },
    dispatchReviewRevoked: (event) => {
      target.dispatch(event);
    },
    dispatchReviewCanceled: (event) => {
      target.dispatch(event);
    },
    dispatchReviewSuperseded: (event) => {
      target.dispatch(event);
    },
  };
}

function createAction(overrides: Partial<Action> = {}): Action {
  return {
    sequence: 0,
    runId: 'run-1',
    type: 'run.completed',
    detail: {},
    timestamp: 0,
    ...overrides,
  };
}

/** A `DurableEventHistory` fake that records every `record()` call — `page`/`subscribeEventHistory`/`dispose` are unused by the producer and throw if ever called. */
function createRecordingHistory(
  recordImpl?: (owner: DurableEventOwner, kind: string, payload: unknown) => Promise<void>,
): {
  readonly history: DurableEventHistory;
  readonly calls: { owner: DurableEventOwner; kind: string; payload: unknown }[];
} {
  const calls: { owner: DurableEventOwner; kind: string; payload: unknown }[] = [];
  const history: DurableEventHistory = {
    async record(owner, kind, payload) {
      calls.push({ owner, kind, payload });
      if (recordImpl) await recordImpl(owner, kind, payload);
      return {
        kind,
        owner,
        sequence: calls.length - 1,
        cursor: String(calls.length - 1),
        emittedAtMs: 0,
        payload,
        schemaVersion: 1,
      };
    },
    page() {
      throw new Error('unused by createDurableEventProducer');
    },
    subscribeEventHistory() {
      throw new Error('unused by createDurableEventProducer');
    },
    dispose: async () => {},
  };
  return { history, calls };
}

describe('createDurableEventProducer()', () => {
  it('records a run-durable action type under the run owner, with the same serialized detail the audit trail would produce', async () => {
    const runtime = createManualRuntimeServices();
    const { bureau, dispatchAction } = createFakeBureauEventSurface();
    const { history, calls } = createRecordingHistory();
    const producer = createDurableEventProducer(bureau, history, runtime);

    dispatchAction(createAction({ type: 'run.completed', runId: 'run-1', detail: { ok: true } }));
    await runtime.deferred.drain();

    expect(calls).toEqual([
      { owner: { kind: 'run', id: 'run-1' }, kind: 'run.completed', payload: { ok: true } },
    ]);

    await producer.dispose();
  });

  it('records every run-durable action type: completed, error, aborted, tripwire', async () => {
    const runtime = createManualRuntimeServices();
    const { bureau, dispatchAction } = createFakeBureauEventSurface();
    const { history, calls } = createRecordingHistory();
    const producer = createDurableEventProducer(bureau, history, runtime);

    for (const type of ['run.completed', 'run.error', 'run.aborted', 'run.tripwire']) {
      dispatchAction(createAction({ type, runId: 'run-1' }));
    }
    await runtime.deferred.drain();

    expect(calls.map((call) => call.kind)).toEqual([
      'run.completed',
      'run.error',
      'run.aborted',
      'run.tripwire',
    ]);

    await producer.dispose();
  });

  it('ignores an action type outside the durable run/session sets — tool.* and step.completed are audit-trail-only, never durable', async () => {
    const runtime = createManualRuntimeServices();
    const { bureau, dispatchAction } = createFakeBureauEventSurface();
    const { history, calls } = createRecordingHistory();
    const producer = createDurableEventProducer(bureau, history, runtime);

    dispatchAction(createAction({ type: 'tool.started' }));
    dispatchAction(createAction({ type: 'step.completed' }));
    await runtime.deferred.drain();

    expect(calls).toEqual([]);

    await producer.dispose();
  });

  it('records a session-durable action type under the session owner from its detail.sessionId', async () => {
    const runtime = createManualRuntimeServices();
    const { bureau, dispatchAction } = createFakeBureauEventSurface();
    const { history, calls } = createRecordingHistory();
    const producer = createDurableEventProducer(bureau, history, runtime);

    dispatchAction(
      createAction({
        type: 'session.created',
        runId: 'run-1',
        detail: { sessionId: 'sess-A', agentName: 'x' },
      }),
    );
    await runtime.deferred.drain();

    expect(calls).toEqual([
      {
        owner: { kind: 'session', id: 'sess-A' },
        kind: 'session.created',
        payload: { sessionId: 'sess-A', agentName: 'x' },
      },
    ]);

    await producer.dispose();
  });

  it('drops a session-durable action with no string sessionId on its detail, diagnosing instead of fabricating an owner', async () => {
    const runtime = createManualRuntimeServices();
    const { bureau, dispatchAction } = createFakeBureauEventSurface();
    const { history, calls } = createRecordingHistory();
    const diagnostics: BureauDiagnostic[] = [];
    const producer = createDurableEventProducer(bureau, history, runtime, (diagnostic) =>
      diagnostics.push(diagnostic),
    );

    dispatchAction(createAction({ type: 'session.saved', detail: { agentName: 'x' } }));
    dispatchAction(createAction({ type: 'session.saved', detail: { sessionId: 42 } }));
    await runtime.deferred.drain();

    expect(calls).toEqual([]);
    expect(
      diagnostics.filter(
        (diagnostic) =>
          diagnostic.scope === 'durable-event-history' &&
          diagnostic.message.includes('no string sessionId'),
      ),
    ).toHaveLength(2);

    await producer.dispose();
  });

  it('records schedule.completed and schedule.failed under the fired run\'s own owner — "a schedule fire is an ordinary run" (AB-87)', async () => {
    const runtime = createManualRuntimeServices();
    const { bureau, dispatchScheduleCompleted, dispatchScheduleFailed } =
      createFakeBureauEventSurface();
    const { history, calls } = createRecordingHistory();
    const producer = createDurableEventProducer(bureau, history, runtime);

    dispatchScheduleCompleted(new ScheduleCompletedEvent('sched-1', 'run-1'));
    dispatchScheduleFailed(new ScheduleFailedEvent('sched-2', 'run-2'));
    await runtime.deferred.drain();

    expect(calls).toEqual([
      {
        owner: { kind: 'run', id: 'run-1' },
        kind: 'schedule.completed',
        payload: { scheduleId: 'sched-1', runId: 'run-1' },
      },
      {
        owner: { kind: 'run', id: 'run-2' },
        kind: 'schedule.failed',
        payload: { scheduleId: 'sched-2', runId: 'run-2' },
      },
    ]);

    await producer.dispose();
  });

  it('records schedule.created under the schedule owner (AB-320)', async () => {
    const runtime = createManualRuntimeServices();
    const { bureau, dispatchScheduleCreated } = createFakeBureauEventSurface();
    const { history, calls } = createRecordingHistory();
    const producer = createDurableEventProducer(bureau, history, runtime);

    dispatchScheduleCreated(
      new AgentScheduledEvent({
        agentName: 'triage',
        scheduleId: 'sched-1',
        spec: { cron: '* * * * *' },
        sessionId: 'sess-1',
      }),
    );
    await runtime.deferred.drain();

    expect(calls).toEqual([
      {
        owner: { kind: 'schedule', id: 'sched-1' },
        kind: 'schedule.created',
        payload: {
          scheduleId: 'sched-1',
          agentName: 'triage',
          spec: { cron: '* * * * *' },
          sessionId: 'sess-1',
        },
      },
    ]);

    await producer.dispose();
  });

  it('records schedule.created with no sessionId key when the event carries none (AB-320)', async () => {
    const runtime = createManualRuntimeServices();
    const { bureau, dispatchScheduleCreated } = createFakeBureauEventSurface();
    const { history, calls } = createRecordingHistory();
    const producer = createDurableEventProducer(bureau, history, runtime);

    dispatchScheduleCreated(
      new AgentScheduledEvent({
        agentName: 'triage',
        scheduleId: 'sched-1',
        spec: { every: '5m' },
      }),
    );
    await runtime.deferred.drain();

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      owner: { kind: 'schedule', id: 'sched-1' },
      kind: 'schedule.created',
      payload: { scheduleId: 'sched-1', agentName: 'triage', spec: { every: '5m' } },
    });
    expect(calls[0]?.payload).not.toHaveProperty('sessionId');

    await producer.dispose();
  });

  it('records schedule.paused under the schedule owner (AB-320)', async () => {
    const runtime = createManualRuntimeServices();
    const { bureau, dispatchSchedulePaused } = createFakeBureauEventSurface();
    const { history, calls } = createRecordingHistory();
    const producer = createDurableEventProducer(bureau, history, runtime);

    dispatchSchedulePaused(new SchedulePausedEvent('sched-1'));
    await runtime.deferred.drain();

    expect(calls).toEqual([
      {
        owner: { kind: 'schedule', id: 'sched-1' },
        kind: 'schedule.paused',
        payload: { scheduleId: 'sched-1' },
      },
    ]);

    await producer.dispose();
  });

  it('records schedule.resumed under the schedule owner (AB-320)', async () => {
    const runtime = createManualRuntimeServices();
    const { bureau, dispatchScheduleResumed } = createFakeBureauEventSurface();
    const { history, calls } = createRecordingHistory();
    const producer = createDurableEventProducer(bureau, history, runtime);

    dispatchScheduleResumed(new ScheduleResumedEvent('sched-1'));
    await runtime.deferred.drain();

    expect(calls).toEqual([
      {
        owner: { kind: 'schedule', id: 'sched-1' },
        kind: 'schedule.resumed',
        payload: { scheduleId: 'sched-1' },
      },
    ]);

    await producer.dispose();
  });

  it('records schedule.cancelled under the schedule owner (AB-320)', async () => {
    const runtime = createManualRuntimeServices();
    const { bureau, dispatchScheduleCancelled } = createFakeBureauEventSurface();
    const { history, calls } = createRecordingHistory();
    const producer = createDurableEventProducer(bureau, history, runtime);

    dispatchScheduleCancelled(new ScheduleCancelledEvent('sched-1'));
    await runtime.deferred.drain();

    expect(calls).toEqual([
      {
        owner: { kind: 'schedule', id: 'sched-1' },
        kind: 'schedule.cancelled',
        payload: { scheduleId: 'sched-1' },
      },
    ]);

    await producer.dispose();
  });

  it("records each review.* lifecycle event under the fired review's own run owner, with the minimal privileged payload (AB-224)", async () => {
    const runtime = createManualRuntimeServices();
    const {
      bureau,
      dispatchReviewApproved,
      dispatchReviewDenied,
      dispatchReviewRejected,
      dispatchReviewExpired,
      dispatchReviewRevoked,
      dispatchReviewCanceled,
      dispatchReviewSuperseded,
    } = createFakeBureauEventSurface();
    const { history, calls } = createRecordingHistory();
    const producer = createDurableEventProducer(bureau, history, runtime);

    dispatchReviewApproved(
      new ReviewApprovedEvent('approval:run-1:call-1', 'run-1', 'operator-a', 'tool-approval'),
    );
    dispatchReviewDenied(
      new ReviewDeniedEvent('approval:run-1:call-2', 'run-1', 'operator-b', 'tool-approval'),
    );
    dispatchReviewRejected(
      new ReviewRejectedEvent('approval:run-1:call-3', 'run-1', 'operator-c', 'tool-approval'),
    );
    dispatchReviewExpired(
      new ReviewExpiredEvent(
        'approval:run-1:call-4',
        'run-1',
        'system:expiry-sweep',
        'tool-approval',
      ),
    );
    dispatchReviewRevoked(
      new ReviewRevokedEvent(
        'approval:run-1:call-5',
        'run-1',
        'system:run-deletion',
        'tool-approval',
      ),
    );
    dispatchReviewCanceled(
      new ReviewCanceledEvent('human-wait:run-1:sig', 'run-1', 'system:run-abort', 'human-wait'),
    );
    dispatchReviewSuperseded(
      new ReviewSupersededEvent(
        'approval:run-1:call-6',
        'run-1',
        'system:supersession',
        'tool-approval',
      ),
    );
    await runtime.deferred.drain();

    expect(calls).toEqual([
      {
        owner: { kind: 'run', id: 'run-1' },
        kind: 'review.approved',
        payload: {
          reviewId: 'approval:run-1:call-1',
          runId: 'run-1',
          principal: 'operator-a',
          kind: 'tool-approval',
        },
      },
      {
        owner: { kind: 'run', id: 'run-1' },
        kind: 'review.denied',
        payload: {
          reviewId: 'approval:run-1:call-2',
          runId: 'run-1',
          principal: 'operator-b',
          kind: 'tool-approval',
        },
      },
      {
        owner: { kind: 'run', id: 'run-1' },
        kind: 'review.rejected',
        payload: {
          reviewId: 'approval:run-1:call-3',
          runId: 'run-1',
          principal: 'operator-c',
          kind: 'tool-approval',
        },
      },
      {
        owner: { kind: 'run', id: 'run-1' },
        kind: 'review.expired',
        payload: {
          reviewId: 'approval:run-1:call-4',
          runId: 'run-1',
          principal: 'system:expiry-sweep',
          kind: 'tool-approval',
        },
      },
      {
        owner: { kind: 'run', id: 'run-1' },
        kind: 'review.revoked',
        payload: {
          reviewId: 'approval:run-1:call-5',
          runId: 'run-1',
          principal: 'system:run-deletion',
          kind: 'tool-approval',
        },
      },
      {
        owner: { kind: 'run', id: 'run-1' },
        kind: 'review.canceled',
        payload: {
          reviewId: 'human-wait:run-1:sig',
          runId: 'run-1',
          principal: 'system:run-abort',
          kind: 'human-wait',
        },
      },
      {
        owner: { kind: 'run', id: 'run-1' },
        kind: 'review.superseded',
        payload: {
          reviewId: 'approval:run-1:call-6',
          runId: 'run-1',
          principal: 'system:supersession',
          kind: 'tool-approval',
        },
      },
    ]);

    await producer.dispose();
  });

  it('the schedule page excludes fires, and the fired run page excludes definition events (AB-320)', async () => {
    const runtime = createManualRuntimeServices();
    const storage = await createMemoryStorage();
    const history = createDurableEventHistory(storage, runtime);
    const {
      bureau,
      dispatchScheduleCreated,
      dispatchSchedulePaused,
      dispatchScheduleResumed,
      dispatchScheduleCancelled,
      dispatchScheduleCompleted,
    } = createFakeBureauEventSurface();
    const producer = createDurableEventProducer(bureau, history, runtime);

    dispatchScheduleCreated(
      new AgentScheduledEvent({ agentName: 'triage', scheduleId: 'sched-1', spec: { cron: '*' } }),
    );
    dispatchSchedulePaused(new SchedulePausedEvent('sched-1'));
    dispatchScheduleCompleted(new ScheduleCompletedEvent('sched-1', 'run-1'));
    dispatchScheduleResumed(new ScheduleResumedEvent('sched-1'));
    dispatchScheduleCancelled(new ScheduleCancelledEvent('sched-1'));
    await runtime.deferred.drain();

    const schedulePage = await history.page({ kind: 'schedule', id: 'sched-1' });
    if ('outcome' in schedulePage) throw new Error('expected a page, got a gap');
    expect(schedulePage.events.map((event) => event.kind)).toEqual([
      'schedule.created',
      'schedule.paused',
      'schedule.resumed',
      'schedule.cancelled',
    ]);

    const runPage = await history.page({ kind: 'run', id: 'run-1' });
    if ('outcome' in runPage) throw new Error('expected a page, got a gap');
    expect(runPage.events.map((event) => event.kind)).toEqual(['schedule.completed']);

    await producer.dispose();
    await history.dispose();
  });

  it('subscribeEventHistory tails a schedule owner, delivering definition events live and never a fire (AB-320)', async () => {
    const runtime = createManualRuntimeServices();
    const storage = await createMemoryStorage();
    const history = createDurableEventHistory(storage, runtime);
    const { bureau, dispatchSchedulePaused, dispatchScheduleResumed, dispatchScheduleCompleted } =
      createFakeBureauEventSurface();
    const producer = createDurableEventProducer(bureau, history, runtime);
    const collector = createCollector();

    const subscription = history.subscribeEventHistory(
      { kind: 'schedule', id: 'sched-1' },
      collector.push,
    );

    dispatchSchedulePaused(new SchedulePausedEvent('sched-1'));
    dispatchScheduleCompleted(new ScheduleCompletedEvent('sched-1', 'run-1'));
    dispatchScheduleResumed(new ScheduleResumedEvent('sched-1'));
    await runtime.deferred.drain();
    await collector.waitForCount(2);

    expect(collector.events.map((event) => event.kind)).toEqual([
      'schedule.paused',
      'schedule.resumed',
    ]);

    subscription.unsubscribe();
    await producer.dispose();
    await history.dispose();
  });

  it('diagnoses (never throws) when a record() write rejects', async () => {
    const runtime = createManualRuntimeServices();
    const { bureau, dispatchAction } = createFakeBureauEventSurface();
    const { history } = createRecordingHistory(async () => {
      throw new Error('storage boom');
    });
    const diagnostics: BureauDiagnostic[] = [];
    const producer = createDurableEventProducer(bureau, history, runtime, (diagnostic) =>
      diagnostics.push(diagnostic),
    );

    dispatchAction(createAction({ type: 'run.completed', runId: 'run-1' }));
    await runtime.deferred.drain();

    expect(
      diagnostics.some(
        (diagnostic) =>
          diagnostic.scope === 'durable-event-history' &&
          diagnostic.message.includes('Failed to record durable event'),
      ),
    ).toBe(true);

    await producer.dispose();
  });

  it('refuses to start a new record once the owner-issued signal aborts, but still awaits a write already in flight', async () => {
    const runtime = createManualRuntimeServices();
    const { bureau, dispatchAction, dispatchScheduleCreated } = createFakeBureauEventSurface();
    let releaseWrite: (() => void) | undefined;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const { history, calls } = createRecordingHistory(async () => {
      await writeGate;
    });
    const controller = new AbortController();
    const producer = createDurableEventProducer(bureau, history, runtime, undefined, {
      signal: controller.signal,
    });

    dispatchAction(createAction({ type: 'run.completed', runId: 'run-1' }));
    controller.abort();
    dispatchAction(createAction({ type: 'run.error', runId: 'run-2' }));
    dispatchScheduleCreated(
      new AgentScheduledEvent({ agentName: 'triage', scheduleId: 'sched-1', spec: { cron: '*' } }),
    );

    releaseWrite?.();
    await producer.dispose();

    expect(calls.map((call) => call.kind)).toEqual(['run.completed']);
  });

  it('dispose() removes every listener — a subsequent event on the same bureau records nothing', async () => {
    const runtime = createManualRuntimeServices();
    const {
      bureau,
      dispatchAction,
      dispatchScheduleCompleted,
      dispatchScheduleFailed,
      dispatchScheduleCreated,
      dispatchSchedulePaused,
      dispatchScheduleResumed,
      dispatchScheduleCancelled,
      dispatchReviewApproved,
      dispatchReviewDenied,
      dispatchReviewRejected,
      dispatchReviewExpired,
      dispatchReviewRevoked,
      dispatchReviewCanceled,
      dispatchReviewSuperseded,
    } = createFakeBureauEventSurface();
    const { history, calls } = createRecordingHistory();
    const producer = createDurableEventProducer(bureau, history, runtime);

    await producer.dispose();
    await producer.dispose(); // idempotent

    dispatchAction(createAction({ type: 'run.completed' }));
    dispatchScheduleCompleted(new ScheduleCompletedEvent('sched-1', 'run-1'));
    dispatchScheduleFailed(new ScheduleFailedEvent('sched-2', 'run-2'));
    dispatchScheduleCreated(
      new AgentScheduledEvent({ agentName: 'triage', scheduleId: 'sched-1', spec: { cron: '*' } }),
    );
    dispatchSchedulePaused(new SchedulePausedEvent('sched-1'));
    dispatchScheduleResumed(new ScheduleResumedEvent('sched-1'));
    dispatchScheduleCancelled(new ScheduleCancelledEvent('sched-1'));
    dispatchReviewApproved(
      new ReviewApprovedEvent('approval:run-1:call-1', 'run-1', 'operator-a', 'tool-approval'),
    );
    dispatchReviewDenied(
      new ReviewDeniedEvent('approval:run-1:call-2', 'run-1', 'operator-b', 'tool-approval'),
    );
    dispatchReviewRejected(
      new ReviewRejectedEvent('approval:run-1:call-3', 'run-1', 'operator-c', 'tool-approval'),
    );
    dispatchReviewExpired(
      new ReviewExpiredEvent(
        'approval:run-1:call-4',
        'run-1',
        'system:expiry-sweep',
        'tool-approval',
      ),
    );
    dispatchReviewRevoked(
      new ReviewRevokedEvent(
        'approval:run-1:call-5',
        'run-1',
        'system:run-deletion',
        'tool-approval',
      ),
    );
    dispatchReviewCanceled(
      new ReviewCanceledEvent('human-wait:run-1:sig', 'run-1', 'system:run-abort', 'human-wait'),
    );
    dispatchReviewSuperseded(
      new ReviewSupersededEvent(
        'approval:run-1:call-6',
        'run-1',
        'system:supersession',
        'tool-approval',
      ),
    );
    await runtime.deferred.drain();

    expect(calls).toEqual([]);
  });
});
