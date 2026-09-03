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
import { createFleetEventFeed, type FleetEventFeed } from '@lostgradient/weft/server/handler';
import { resolveStorage, type Storage } from '@lostgradient/weft/storage';
import { describe, expect, it } from 'bun:test';
import { createManualRuntimeServices } from 'lifecycle';

import {
  createDurableEventHistory,
  DEFAULT_PAGE_LIMIT,
  type DurableEventHistory,
} from './durable-event-history';
import { createLmdbStorageFixture, createSqliteStorageFixture } from './test/storage-fixtures';

async function createMemoryStorage(): Promise<Storage> {
  return resolveStorage({ type: 'memory' });
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

    it('throws when a fleet event payload is not the stored-wrapper shape', async () => {
      const storage = await createMemoryStorage();
      const runtime = createManualRuntimeServices();
      const history = createDurableEventHistory(storage, runtime);

      const rawFeed: FleetEventFeed = createFleetEventFeed(storage);
      await rawFeed.append({
        kind: 'legacy.kind',
        workflowId: 'run:run-1',
        emittedAtMs: 0,
        payload: 'not-a-wrapper',
      });
      rawFeed.dispose();

      expect(history.page({ kind: 'run', id: 'run-1' })).rejects.toThrow(
        /does not carry a recognized stored payload/,
      );

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
});
