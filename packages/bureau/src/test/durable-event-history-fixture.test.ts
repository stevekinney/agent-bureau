/**
 * Tests for `createDurableEventHistoryFixture` and
 * `seedSchemaVersionMismatchRecord` (AB-91's `ab91-05` child, AB-314) —
 * fixtures and documentation only, no production behavior. Proves the
 * fixture builder actually produces what it claims across BOTH persistent
 * backends (`durable-event-history.test.ts`'s own restart-durability
 * suite already covers the underlying `createDurableEventHistory` module
 * directly; this file covers the fixture wrapper itself), and that the
 * event-schema compatibility fixture round-trips a current-schema record
 * while rejecting a deliberately mismatched one exactly as
 * `UnsupportedDurableEventSchemaVersionError` specifies.
 */
import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import type { DurableEventEnvelope } from '@lostgradient/operative';
import { resolveStorage, type Storage } from '@lostgradient/weft';
import { describe, expect, it } from 'bun:test';

import { createDurableEventHistory } from '../durable-event-history';
import { throwingRejectionOf } from '../testing/promise-outcome.test-support.ts';
import {
  createDurableEventHistoryFixture,
  DURABLE_EVENT_HISTORY_FIXTURE_SEQUENCE,
  seedSchemaVersionMismatchRecord,
} from './durable-event-history-fixture';

describe('createDurableEventHistoryFixture', () => {
  it.each(['sqlite', 'lmdb'] as const)(
    'seeds the fixture sequence into a fresh %s backend with deterministic sequence numbers',
    async (backend) => {
      const fixture = await createDurableEventHistoryFixture({ backend });
      try {
        expect(fixture.envelopes).toHaveLength(DURABLE_EVENT_HISTORY_FIXTURE_SEQUENCE.length);
        expect(fixture.envelopes.map((event) => event.sequence)).toEqual([0, 1, 2, 3, 4, 5, 6]);
        expect(fixture.envelopes.map((event) => event.kind)).toEqual(
          DURABLE_EVENT_HISTORY_FIXTURE_SEQUENCE.map((record) => record.kind),
        );
        expect(fixture.envelopes.map((event) => event.owner)).toEqual(
          DURABLE_EVENT_HISTORY_FIXTURE_SEQUENCE.map((record) => record.owner),
        );
        for (const event of fixture.envelopes) {
          expect(event.schemaVersion).toBe(1);
        }
        expect(fixture.storage.owned).toBe(true);
      } finally {
        await fixture.dispose();
      }
    },
  );

  it.each(['sqlite', 'lmdb'] as const)(
    'survives reopening the seeded %s backend across an independently constructed instance (restart durability)',
    async (backend) => {
      const fixture = await createDurableEventHistoryFixture({ backend });
      try {
        const runOwner = { kind: 'run' as const, id: 'fixture-run-1' };

        const storage: Storage = await resolveStorage(fixture.storage.configuration);
        const history = createDurableEventHistory(storage, fixture.runtime);
        try {
          const page = await history.page(runOwner);
          if ('outcome' in page) throw new Error('expected a page, got a gap');
          expect(page.events.map((event) => event.kind)).toEqual([
            'run.started',
            'step.completed',
            'run.completed',
          ]);
        } finally {
          await history.dispose();
          storage[Symbol.dispose]();
        }
      } finally {
        await fixture.dispose();
      }
    },
  );

  it('honors a caller-supplied path by leaving it on disk after dispose', async () => {
    const runtime = createManualRuntimeServices();
    const { createSqliteStorageFixture } = await import('./storage-fixtures');
    const pathFixture = createSqliteStorageFixture({ runtime });

    const fixture = await createDurableEventHistoryFixture({
      backend: 'sqlite',
      runtime,
      path: pathFixture.path,
    });
    expect(fixture.storage.owned).toBe(false);

    await fixture.dispose(); // a no-op for an unowned path
    await pathFixture.dispose(); // the caller's own cleanup
  });

  it('accepts a caller-supplied sequence override', async () => {
    const override = [
      { owner: { kind: 'run' as const, id: 'custom-run' }, kind: 'run.started', payload: {} },
    ];
    const fixture = await createDurableEventHistoryFixture({
      backend: 'sqlite',
      sequence: override,
    });
    try {
      expect(fixture.envelopes).toHaveLength(1);
      expect(fixture.envelopes[0]?.owner).toEqual({ kind: 'run', id: 'custom-run' });
    } finally {
      await fixture.dispose();
    }
  });

  it('disposes the storage fixture and rethrows when seeding fails partway through', async () => {
    const runtime = createManualRuntimeServices();
    const badSequence = [
      { owner: { kind: 'run' as const, id: 'run-1' }, kind: 'run.started', payload: {} },
    ];
    expect(
      await throwingRejectionOf(
        createDurableEventHistoryFixture({
          backend: 'sqlite',
          runtime,
          // An invalid path (a directory that cannot be created as a sqlite
          // file — a null byte is rejected by every OS filesystem) forces
          // `resolveStorage` itself to reject, exercising the catch branch's
          // fixture cleanup without needing a second seam.
          path: '/nonexistent-fixture-dir-\u0000/fixture.sqlite',
          sequence: badSequence,
        }),
      ),
    ).toThrow();
  });
});

describe('seedSchemaVersionMismatchRecord', () => {
  it('round-trips a current-schema-version record and rejects a deliberately mismatched one (event-schema compatibility fixture)', async () => {
    const runtime = createManualRuntimeServices();
    const storage = await resolveStorage({ type: 'memory' });
    const owner = { kind: 'run' as const, id: 'compat-run-1' };
    const history = createDurableEventHistory(storage, runtime);

    try {
      // The trivial case: a record written by the CURRENT schemaVersion is
      // readable by the current reader.
      const current = await history.record(owner, 'run.started', { attempt: 1 });
      expect(current.schemaVersion).toBe(1);

      const goodPage = await history.page(owner);
      if ('outcome' in goodPage) throw new Error('expected a page, got a gap');
      expect(goodPage.events).toEqual([current]);

      // A deliberately older/malformed-shaped record — schemaVersion 0,
      // simulating a pre-this-version stored shape — is rejected exactly
      // as `UnsupportedDurableEventSchemaVersionError` specifies, not
      // silently coerced: the raw record is skipped from the page (with a
      // diagnostic), never returned or upgraded in place.
      await seedSchemaVersionMismatchRecord(storage, owner, 'run.completed', 0, {
        finishReason: 'success',
      });

      const diagnostics: unknown[] = [];
      const historyWithDiagnostics = createDurableEventHistory(storage, runtime, (diagnostic) => {
        diagnostics.push(diagnostic);
      });
      const pageAfterMismatch = await historyWithDiagnostics.page(owner);
      if ('outcome' in pageAfterMismatch) throw new Error('expected a page, got a gap');

      // The mismatched record is skipped, not coerced — only the original
      // current-schema record comes back.
      expect(pageAfterMismatch.events).toEqual([current]);
      expect(diagnostics).toHaveLength(1);
      await historyWithDiagnostics.dispose();
    } finally {
      await history.dispose();
      storage[Symbol.dispose]();
    }
  });

  it('throws UnsupportedDurableEventSchemaVersionError when a single mismatched envelope is decoded directly', async () => {
    const runtime = createManualRuntimeServices();
    const storage = await resolveStorage({ type: 'memory' });
    const owner = { kind: 'session' as const, id: 'compat-session-1' };

    await seedSchemaVersionMismatchRecord(storage, owner, 'session.created', 999, {
      sessionId: 'compat-session-1',
    });

    const errors: unknown[] = [];
    const observingHistory = createDurableEventHistory(storage, runtime, (diagnostic) => {
      errors.push(diagnostic);
    });
    try {
      const page = await observingHistory.page(owner);
      if ('outcome' in page) throw new Error('expected a page, got a gap');
      // Rejected, not coerced: the mismatched record is skipped entirely,
      // never returned upgraded or downgraded in place.
      expect(page.events).toEqual<readonly DurableEventEnvelope[]>([]);
      expect(errors).toHaveLength(1);
    } finally {
      await observingHistory.dispose();
      storage[Symbol.dispose]();
    }
  });
});
