/**
 * Tests for `createAuditTrail` and its `query` method.
 *
 * Uses a hand-crafted `TextValueStore` stub so tests are fully deterministic
 * without starting a live bureau or durable engine.
 */
import { MemoryStorage, textValueStore } from '@lostgradient/weft/storage';
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import type { Action } from 'operative/store';

import { type AuditRecord, createAuditTrail } from './audit-trail';
import { ActionEvent } from './events';
import type { Bureau } from './types';

// ── Minimal Bureau stub ──────────────────────────────────────────────

type ActionListener = (event: ActionEvent) => void;

/**
 * A minimal bureau stub that only supports the action-event subscription the
 * audit trail requires. No runs, no sessions, no persistence machinery.
 */
function createStubBureau(): { bureau: Bureau; emit: (event: ActionEvent) => void } {
  const listeners = new Set<ActionListener>();

  const bureau = {
    addEventListener(_type: string, listener: ActionListener) {
      listeners.add(listener);
    },
    removeEventListener(_type: string, listener: ActionListener) {
      listeners.delete(listener);
    },
  } as unknown as Bureau;

  const emit = (event: ActionEvent) => {
    for (const listener of listeners) {
      listener(event);
    }
  };

  return { bureau, emit };
}

// ── Helpers ──────────────────────────────────────────────────────────

function makeRecord(
  sequence: number,
  options?: { timestampMs?: number; runId?: string; type?: string },
): AuditRecord {
  const timestampMs = options?.timestampMs ?? 1_000_000;
  return {
    timestamp: new Date(timestampMs).toISOString(),
    timestampMs,
    sequence,
    runId: options?.runId ?? 'run-default',
    type: options?.type ?? 'tool.started',
    detail: null,
  };
}

/**
 * Write an `AuditRecord` directly into the store under the canonical key
 * schema so `query()` can find it without going through the event pipeline.
 */
async function seedRecord(
  kv: ReturnType<typeof textValueStore>,
  record: AuditRecord,
): Promise<void> {
  const ts = record.timestampMs.toString().padStart(16, '0');
  const seq = record.sequence.toString().padStart(12, '0');
  // Keep in sync with `encodeKey` in audit-trail.ts: audit:v1:<ts>:<seq>:<runId>
  await kv.set(`audit:v1:${ts}:${seq}:${record.runId}`, JSON.stringify(record));
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('createAuditTrail', () => {
  it('returns an empty array when no kv store is provided', async () => {
    const { bureau } = createStubBureau();
    const trail = createAuditTrail(bureau, undefined);
    expect(await trail.query()).toEqual([]);
    trail.dispose();
  });

  it('returns an empty array when the kv store has no audit keys', async () => {
    const kv = textValueStore(new MemoryStorage());
    const { bureau } = createStubBureau();
    const trail = createAuditTrail(bureau, kv);
    expect(await trail.query()).toEqual([]);
    trail.dispose();
  });

  it('returns all records in chronological order when no filters are supplied', async () => {
    const kv = textValueStore(new MemoryStorage());
    const { bureau } = createStubBureau();

    await seedRecord(
      kv,
      makeRecord(1, { timestampMs: 1000, runId: 'run-1', type: 'tool.started' }),
    );
    await seedRecord(
      kv,
      makeRecord(2, { timestampMs: 2000, runId: 'run-1', type: 'tool.settled' }),
    );
    await seedRecord(
      kv,
      makeRecord(3, { timestampMs: 3000, runId: 'run-2', type: 'run.completed' }),
    );

    const trail = createAuditTrail(bureau, kv);
    const result = await trail.query();

    expect(result).toHaveLength(3);
    // The key schema `audit:v1:<zero-padded-timestamp>:<zero-padded-sequence>` is
    // lexicographically chronological, so storage scan order === chronological order.
    expect(result.map((r) => r.timestampMs)).toEqual([1000, 2000, 3000]);
    trail.dispose();
  });

  it('filters by runId', async () => {
    const kv = textValueStore(new MemoryStorage());
    const { bureau } = createStubBureau();

    await seedRecord(
      kv,
      makeRecord(1, { timestampMs: 1000, runId: 'run-A', type: 'tool.started' }),
    );
    await seedRecord(
      kv,
      makeRecord(2, { timestampMs: 2000, runId: 'run-B', type: 'tool.started' }),
    );
    await seedRecord(
      kv,
      makeRecord(3, { timestampMs: 3000, runId: 'run-A', type: 'tool.settled' }),
    );

    const trail = createAuditTrail(bureau, kv);
    const result = await trail.query({ runId: 'run-B' });

    expect(result).toHaveLength(1);
    expect(result[0]?.runId).toBe('run-B');
    trail.dispose();
  });

  it('filters by type', async () => {
    const kv = textValueStore(new MemoryStorage());
    const { bureau } = createStubBureau();

    await seedRecord(kv, makeRecord(1, { timestampMs: 1000, type: 'tool.started' }));
    await seedRecord(kv, makeRecord(2, { timestampMs: 2000, type: 'run.completed' }));
    await seedRecord(kv, makeRecord(3, { timestampMs: 3000, type: 'tool.started' }));

    const trail = createAuditTrail(bureau, kv);
    const result = await trail.query({ type: 'run.completed' });

    expect(result).toHaveLength(1);
    expect(result[0]?.type).toBe('run.completed');
    trail.dispose();
  });

  it('filters by since (inclusive lower bound)', async () => {
    const kv = textValueStore(new MemoryStorage());
    const { bureau } = createStubBureau();

    await seedRecord(kv, makeRecord(1, { timestampMs: 1000 }));
    await seedRecord(kv, makeRecord(2, { timestampMs: 2000 }));
    await seedRecord(kv, makeRecord(3, { timestampMs: 3000 }));

    const trail = createAuditTrail(bureau, kv);
    const result = await trail.query({ since: 2000 });

    expect(result).toHaveLength(2);
    expect(result.map((r) => r.timestampMs)).toEqual([2000, 3000]);
    trail.dispose();
  });

  /**
   * Regression for PRRT_kwDORvupsc6MT46u — the `limit` guard must be applied to
   * records that PASS all filters, not to records examined in the scan order.
   *
   * With the old code, `if (records.length >= limit) break` was placed at the TOP
   * of the loop body, before `kv.get`. Since `records.length` only grows on matched
   * (post-filter) records, the two placements are semantically equivalent for the
   * common case. However the post-filter placement is the correct expression of
   * intent: "collect at most `limit` matching records," and makes the code robust
   * should the scan-break logic ever be restructured.
   *
   * This test also verifies that combining `runId` + `limit` still correctly finds
   * matching records that appear later in the scan order.
   */
  it('counts limit against matched records only, not scan position', async () => {
    const kv = textValueStore(new MemoryStorage());
    const { bureau } = createStubBureau();

    // 5 run-A records at timestamps 1000–1004 (first in lexicographic scan order)
    for (let i = 0; i < 5; i++) {
      await seedRecord(
        kv,
        makeRecord(i + 1, { timestampMs: 1000 + i, runId: 'run-A', type: 'tool.started' }),
      );
    }
    // 1 run-B record at timestamp 9000 (scanned AFTER all run-A records)
    await seedRecord(
      kv,
      makeRecord(100, { timestampMs: 9000, runId: 'run-B', type: 'run.completed' }),
    );

    const trail = createAuditTrail(bureau, kv);

    // Querying for run-B with limit=3 must find the run-B record.
    // It appears after 5 non-matching run-A records in the scan.
    const result = await trail.query({ runId: 'run-B', limit: 3 });

    expect(result).toHaveLength(1);
    expect(result[0]?.runId).toBe('run-B');
    expect(result[0]?.type).toBe('run.completed');
    trail.dispose();
  });

  it('stops collecting once limit matched records are accumulated', async () => {
    const kv = textValueStore(new MemoryStorage());
    const { bureau } = createStubBureau();

    for (let i = 0; i < 10; i++) {
      await seedRecord(
        kv,
        makeRecord(i + 1, { timestampMs: 1000 + i, runId: 'run-X', type: 'tool.started' }),
      );
    }

    const trail = createAuditTrail(bureau, kv);
    const result = await trail.query({ runId: 'run-X', limit: 4 });

    expect(result).toHaveLength(4);
    // Returns the first 4 (oldest) matching records
    expect(result.map((r) => r.timestampMs)).toEqual([1000, 1001, 1002, 1003]);
    trail.dispose();
  });

  it('sinks qualifying action events into the kv store', async () => {
    const kv = textValueStore(new MemoryStorage());
    const { bureau, emit } = createStubBureau();
    const trail = createAuditTrail(bureau, kv);

    const action: Action = {
      type: 'tool.started',
      timestamp: 5000,
      sequence: 42,
      runId: 'run-sink',
      detail: null,
    };

    emit(new ActionEvent(action));

    // Write is fire-and-forget; yield to let the microtask queue settle.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const records = await trail.query({ runId: 'run-sink' });
    expect(records).toHaveLength(1);
    expect(records[0]?.sequence).toBe(42);
    expect(records[0]?.runId).toBe('run-sink');
    trail.dispose();
  });

  it('sinks run.tripwire action events into the kv store (regression PRRT_kwDORvupsc6PxCXU)', async () => {
    // Before the fix, AUDIT_EVENT_TYPES only had 'run.completed' / 'run.error'
    // / 'run.aborted' for run-lifecycle events, so a guardrail tripwire halt
    // — the only terminal event carrying guardrailName/category/phase as
    // first-class fields — was dropped from the durable audit trail entirely.
    const kv = textValueStore(new MemoryStorage());
    const { bureau, emit } = createStubBureau();
    const trail = createAuditTrail(bureau, kv);

    const action: Action = {
      type: 'run.tripwire',
      timestamp: 6000,
      sequence: 7,
      runId: 'run-tripwire',
      detail: { guardrailName: 'output-pii', category: 'pii', phase: 'output', confidence: 1 },
    };

    emit(new ActionEvent(action));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const records = await trail.query({ runId: 'run-tripwire' });
    expect(records).toHaveLength(1);
    expect(records[0]?.type).toBe('run.tripwire');
    trail.dispose();
  });

  it('does not sink non-audit event types into the kv store', async () => {
    const kv = textValueStore(new MemoryStorage());
    const { bureau, emit } = createStubBureau();
    const trail = createAuditTrail(bureau, kv);

    // 'generate.started' is not in AUDIT_EVENT_TYPES
    const action: Action = {
      type: 'generate.started',
      timestamp: 1000,
      sequence: 1,
      runId: 'run-ignored',
      detail: null,
    };

    emit(new ActionEvent(action));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(await trail.query()).toHaveLength(0);
    trail.dispose();
  });

  /**
   * Regression for PRRT_kwDORvupsc6MXoT8 — audit keys must be globally unique
   * across process lifetimes.
   *
   * `sequence` is a per-store-lifetime counter that resets to 0 on every process
   * restart. A clock rewind (NTP step-back, VM snapshot restore) after restart means
   * a new event can share both `timestamp` and `sequence` with an existing record.
   * Without `runId` in the key, the newer event silently overwrites the older one,
   * violating the append-only invariant.
   *
   * This test emits two events with identical timestamp and sequence but different
   * runIds — exactly what happens when two store lifetimes emit seq=0 at the same
   * wall-clock millisecond. Both records must survive.
   */
  it('preserves both records when two events share the same timestamp and sequence but different runIds', async () => {
    const kv = textValueStore(new MemoryStorage());
    const { bureau, emit } = createStubBureau();
    const trail = createAuditTrail(bureau, kv);

    // Same timestamp and sequence — simulates sequence-counter reset after restart
    // with a clock that did not advance (NTP step-back / VM snapshot restore).
    const sharedTimestamp = 5000;
    const sharedSequence = 0;

    const firstLifetimeAction: Action = {
      type: 'tool.started',
      timestamp: sharedTimestamp,
      sequence: sharedSequence,
      runId: 'session-1:0',
      detail: null,
    };
    const secondLifetimeAction: Action = {
      type: 'tool.started',
      timestamp: sharedTimestamp,
      sequence: sharedSequence,
      runId: 'session-2:0',
      detail: null,
    };

    emit(new ActionEvent(firstLifetimeAction));
    emit(new ActionEvent(secondLifetimeAction));

    // Both writes are fire-and-forget; yield to let the microtask queue settle.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const records = await trail.query();
    // Both records must be stored — no silent overwrite.
    expect(records).toHaveLength(2);
    const runIds = records.map((r) => r.runId).sort();
    expect(runIds).toEqual(['session-1:0', 'session-2:0']);
    trail.dispose();
  });

  it('dispose unsubscribes from bureau action events', async () => {
    const kv = textValueStore(new MemoryStorage());
    const { bureau, emit } = createStubBureau();
    const trail = createAuditTrail(bureau, kv);

    trail.dispose();

    const action: Action = {
      type: 'tool.started',
      timestamp: 1000,
      sequence: 1,
      runId: 'run-after-dispose',
      detail: null,
    };

    emit(new ActionEvent(action));
    await new Promise((resolve) => setTimeout(resolve, 0));

    // No records should have been written after dispose
    expect(await trail.query()).toHaveLength(0);
  });

  // ── record() — out-of-band records (AB-20 review queue) ─────────────

  it('record() persists an out-of-band record with the given principal', async () => {
    const kv = textValueStore(new MemoryStorage());
    const { bureau } = createStubBureau();
    const trail = createAuditTrail(bureau, kv);

    await trail.record({
      runId: 'run-review-1',
      type: 'review.tool-approval.approved',
      detail: { decision: 'approve' },
      principal: 'api-key:reviewer-1',
    });

    const records = await trail.query({ runId: 'run-review-1' });
    expect(records).toHaveLength(1);
    expect(records[0]!.type).toBe('review.tool-approval.approved');
    expect(records[0]!.principal).toBe('api-key:reviewer-1');
    expect(records[0]!.detail).toEqual({ decision: 'approve' });
    trail.dispose();
  });

  it('record() omits `principal` when not supplied', async () => {
    const kv = textValueStore(new MemoryStorage());
    const { bureau } = createStubBureau();
    const trail = createAuditTrail(bureau, kv);

    await trail.record({
      runId: 'run-review-2',
      type: 'review.human-wait.denied',
      detail: {},
    });

    const [record] = await trail.query({ runId: 'run-review-2' });
    expect(record!.principal).toBeUndefined();
    trail.dispose();
  });

  it('record() is a no-op when no kv store is configured', async () => {
    const { bureau } = createStubBureau();
    const trail = createAuditTrail(bureau, undefined);

    // Must not throw even though there is nowhere to persist to.
    await trail.record({ runId: 'run-review-3', type: 'review.tool-approval.denied', detail: {} });
    expect(await trail.query({ runId: 'run-review-3' })).toEqual([]);
    trail.dispose();
  });

  it('record() and the live action-event listener never collide on key/sequence', async () => {
    const kv = textValueStore(new MemoryStorage());
    const { bureau, emit } = createStubBureau();
    const trail = createAuditTrail(bureau, kv);

    // A live action-stream record and an out-of-band record for the SAME run,
    // landing in the same millisecond, must both survive — proving the
    // manual-record sequence counter (AB-20) never collides with a real
    // action's sequence.
    const now = Date.now();
    emit(
      new ActionEvent({
        type: 'run.completed',
        timestamp: now,
        sequence: 0,
        runId: 'run-collision-check',
        detail: null,
      }),
    );
    await trail.record({
      runId: 'run-collision-check',
      type: 'review.tool-approval.approved',
      detail: {},
      principal: 'api-key:reviewer-4',
    });

    const records = await trail.query({ runId: 'run-collision-check' });
    expect(records).toHaveLength(2);
    expect(records.map((r) => r.type).sort()).toEqual([
      'review.tool-approval.approved',
      'run.completed',
    ]);
    trail.dispose();
  });

  describe('onDiagnostic', () => {
    // A fresh spy is created before EVERY test and fully restored after —
    // Bun's spyOn() returns the SAME mock (with its accumulated call
    // history) when called again on an already-spied function, so relying
    // on each test to spy-and-restore itself is fragile: a restore that's
    // skipped (or reordered) leaks one test's call count into the next
    // test's `not.toHaveBeenCalled()` assertion. beforeEach/afterEach here
    // makes the fresh-spy-per-test guarantee explicit and order-independent
    // rather than an artifact of each test remembering to spy correctly.
    let errorSpy: ReturnType<typeof spyOn<Console, 'error'>>;

    beforeEach(() => {
      errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
      errorSpy.mockRestore();
    });

    /** A `TextValueStore`-shaped stub whose `set` always rejects. */
    function createFailingKv(): ReturnType<typeof textValueStore> {
      const kv = textValueStore(new MemoryStorage());
      return {
        ...kv,
        set: async () => {
          throw new Error('disk full');
        },
      };
    }

    it('routes a persistence failure to the diagnostic sink instead of the console', async () => {
      const kv = createFailingKv();
      const { bureau, emit } = createStubBureau();
      const received: unknown[] = [];
      const trail = createAuditTrail(bureau, kv, (diagnostic) => received.push(diagnostic));

      emit(
        new ActionEvent({
          type: 'tool.started',
          timestamp: 5000,
          sequence: 1,
          runId: 'run-persist-fail',
          detail: null,
        }),
      );

      // The failing write is fire-and-forget; yield for the rejection to settle.
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({ level: 'error', scope: 'audit-trail' });
      expect(errorSpy).not.toHaveBeenCalled();
      trail.dispose();
    });

    it('with no sink configured, a persistence failure still logs to the console', async () => {
      const kv = createFailingKv();
      const { bureau, emit } = createStubBureau();
      const trail = createAuditTrail(bureau, kv);

      emit(
        new ActionEvent({
          type: 'tool.started',
          timestamp: 5000,
          sequence: 1,
          runId: 'run-persist-fail-default',
          detail: null,
        }),
      );

      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(errorSpy).toHaveBeenCalled();
      trail.dispose();
    });

    it('routes an out-of-band record() persistence failure to the diagnostic sink (the review-decision write path, distinct from the passive action listener above)', async () => {
      const kv = createFailingKv();
      const { bureau } = createStubBureau();
      const received: unknown[] = [];
      const trail = createAuditTrail(bureau, kv, (diagnostic) => received.push(diagnostic));

      // Must not throw even though the underlying kv.set rejects — a review
      // decision that fails to persist must never fail the caller's
      // approve/deny call.
      await trail.record({
        runId: 'run-review-persist-fail',
        type: 'review.tool-approval.approved',
        detail: { decision: 'approve' },
      });

      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({ level: 'error', scope: 'audit-trail' });
      expect(errorSpy).not.toHaveBeenCalled();
      trail.dispose();
    });

    it('with no sink configured, an out-of-band record() persistence failure still logs to the console', async () => {
      const kv = createFailingKv();
      const { bureau } = createStubBureau();
      const trail = createAuditTrail(bureau, kv);

      await trail.record({
        runId: 'run-review-persist-fail-default',
        type: 'review.tool-approval.denied',
        detail: {},
      });

      expect(errorSpy).toHaveBeenCalled();
      trail.dispose();
    });
  });

  describe('query() with a corrupted stored record', () => {
    it('skips a record whose stored JSON is malformed instead of throwing', async () => {
      const kv = textValueStore(new MemoryStorage());
      const { bureau } = createStubBureau();

      // Seed one valid record and one whose stored value is not parseable
      // JSON — simulates a corrupted/partial write reaching the store.
      await seedRecord(kv, makeRecord(1, { timestampMs: 1000, runId: 'run-ok' }));
      await kv.set('audit:v1:0000000000002000:000000000002:run-corrupt', '{not valid json');

      const trail = createAuditTrail(bureau, kv);
      const records = await trail.query();

      expect(records).toHaveLength(1);
      expect(records[0]?.runId).toBe('run-ok');
      trail.dispose();
    });
  });

  describe('same-millisecond manual-record ordering', () => {
    const originalDateNow = Date.now;

    afterEach(() => {
      Date.now = originalDateNow;
    });

    it('preserves insertion order for two out-of-band records in the same millisecond', async () => {
      const kv = textValueStore(new MemoryStorage());
      const { bureau } = createStubBureau();
      const trail = createAuditTrail(bureau, kv);

      // Pin the clock so both `record()` calls land in the exact same
      // millisecond — the only condition under which the manual-sequence
      // counter's direction (up vs down) actually matters for ordering.
      const fixedNow = Date.now();
      spyOn(Date, 'now').mockReturnValue(fixedNow);

      await trail.record({
        runId: 'run-same-ms',
        type: 'review.tool-approval.approved',
        detail: { order: 'first' },
      });
      await trail.record({
        runId: 'run-same-ms',
        type: 'review.tool-approval.denied',
        detail: { order: 'second' },
      });

      Date.now = originalDateNow;

      const records = await trail.query({ runId: 'run-same-ms' });
      expect(records).toHaveLength(2);
      // Both records genuinely share a timestamp — otherwise this test
      // isn't exercising the same-millisecond tiebreak at all.
      expect(records[0]!.timestampMs).toBe(records[1]!.timestampMs);
      // Ascending sequence (the tiebreak `query()`/`/api/v1/audit` sort by)
      // must put the FIRST call before the SECOND — chronological order.
      expect(records[0]!.sequence).toBeLessThan(records[1]!.sequence);
      expect((records[0]!.detail as { order: string }).order).toBe('first');
      expect((records[1]!.detail as { order: string }).order).toBe('second');

      trail.dispose();
    });
  });
});
