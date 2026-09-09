/**
 * Tests for `createAuditTrail` and its `query` method.
 *
 * Uses a hand-crafted `TextValueStore` stub so tests are fully deterministic
 * without starting a live bureau or durable engine.
 */
import {
  AgentScheduledEvent,
  ScheduleCancelledEvent,
  SchedulePausedEvent,
  ScheduleResumedEvent,
  SessionDeletedEvent,
} from '@lostgradient/operative';
import type { Action } from '@lostgradient/operative/store';
import { MemoryStorage, textValueStore } from '@lostgradient/weft/storage';
import { yieldToPortableEventLoop } from '@lostgradient/weft/testing';
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { CompletableEventTarget } from 'lifecycle';

import { type AuditRecord, computeInitialAuditSequence, createAuditTrail } from './audit-trail';
import { ActionEvent, type BureauEventMap } from './events';
import type { Bureau } from './types';

// ── Minimal Bureau stub ──────────────────────────────────────────────

/**
 * A minimal bureau stub that only supports the event subscriptions the
 * audit trail requires (`'action'` plus, as of AB-228, the bureau-level
 * `schedule.*` and `session.deleted` lifecycle events, which never traverse `'action'` — see
 * `audit-trail.ts`'s own doc comment). Backed by a real, typed
 * `CompletableEventTarget<BureauEventMap>` (the same base class
 * `create-bureau.ts`'s own `emitter` uses) so `emit` routes by the
 * dispatched event's own `type`, exactly like a real bureau — a single
 * shared listener bag that ignored `type` would hand a `SchedulePausedEvent`
 * to the `'action'` listener too, which destructures `event.action` and
 * throws. No runs, no sessions, no persistence machinery.
 */
function createStubBureau(): { bureau: Bureau; emit: (event: Event) => void } {
  const target = new CompletableEventTarget<BureauEventMap>();

  const bureau = {
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
  } as unknown as Bureau;

  const emit = (event: Event) => {
    target.dispatchEvent(event);
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
  // `makeRecord`'s callers always pass a real `sequence`; `?? 0` only
  // satisfies the type (optional since AB-370, for a legacy record written
  // before the field existed) without changing any real call site's key.
  const seq = (record.sequence ?? 0).toString().padStart(12, '0');
  // Keep in sync with `encodeKey` in audit-trail.ts: audit:v1:<ts>:<seq>:<runId>
  await kv.set(`audit:v1:${ts}:${seq}:${record.runId}`, JSON.stringify(record));
}

/**
 * A `TextValueStore`-shaped stub whose `set` resolves only once the
 * returned `release` function is called — a controllable, deterministic
 * stand-in for a slow write, never a real timer. Shared by the AB-207
 * (awaited dispose) and AB-228 (read-your-writes) test groups below.
 */
function createControllableKv(): {
  kv: ReturnType<typeof textValueStore>;
  release: () => void;
  setCallCount: () => number;
} {
  const base = textValueStore(new MemoryStorage());
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let setCallCount = 0;
  const kv: ReturnType<typeof textValueStore> = {
    ...base,
    async set(key: string, value: string) {
      setCallCount += 1;
      await gate;
      await base.set(key, value);
    },
  };
  return { kv, release, setCallCount: () => setCallCount };
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
    await yieldToPortableEventLoop();

    const records = await trail.query({ runId: 'run-sink' });
    expect(records).toHaveLength(1);
    // AB-370: `record.sequence` is drawn from the trail's own shared,
    // per-bureau counter (starting at 0 on a fresh trail with no
    // `initialSequence`) — it is deliberately NOT a copy of the action's
    // own `action.sequence` (42) any more. `actionSequence` is where that
    // original value is preserved, for the gateway's live+durable dedup.
    expect(records[0]?.sequence).toBe(0);
    expect(records[0]?.actionSequence).toBe(42);
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
    await yieldToPortableEventLoop();

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
    await yieldToPortableEventLoop();

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
    await yieldToPortableEventLoop();

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
    await yieldToPortableEventLoop();

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
    // landing in the same millisecond, must both survive. AB-370: both draw
    // `sequence` from the SAME shared, monotonic per-bureau counter now
    // (never two disjoint ranges), so uniqueness holds by construction —
    // this proves that still holds through the real listener/`record()`
    // wiring, not just at the counter's own unit level.
    const now = 1_700_000_000_000;
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
      await yieldToPortableEventLoop();

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

      await yieldToPortableEventLoop();

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
      const fixedNow = 1_700_000_000_000;
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
      // Both come from this trail's own writes, so `sequence` is always
      // defined here — the assertions below prove that instead of casting.
      expect(records[0]!.sequence).toBeDefined();
      expect(records[1]!.sequence).toBeDefined();
      expect(records[0]!.sequence!).toBeLessThan(records[1]!.sequence!);
      expect((records[0]!.detail as { order: string }).order).toBe('first');
      expect((records[1]!.detail as { order: string }).order).toBe('second');

      trail.dispose();
    });
  });

  // AB-207: `dispose()` becomes an awaited drain of every write already in
  // flight, and accepts an owner-issued `signal` that refuses to START a
  // new write once aborted (a write already in flight still runs to
  // completion and `dispose()` still awaits it — see `AuditTrailOptions`).
  describe('AB-207 — awaited dispose and the owner-issued signal', () => {
    it('dispose() resolves only after a write already in flight settles', async () => {
      const { kv, release } = createControllableKv();
      const { bureau, emit } = createStubBureau();
      const trail = createAuditTrail(bureau, kv);

      emit(
        new ActionEvent({
          type: 'tool.started',
          timestamp: 6000,
          sequence: 1,
          runId: 'run-inflight-write',
          detail: null,
        }),
      );

      let disposed = false;
      const disposal = trail.dispose().then(() => {
        disposed = true;
      });

      // The write is deliberately still gated — dispose() must not have
      // resolved yet.
      await Promise.resolve();
      await Promise.resolve();
      expect(disposed).toBe(false);

      release();
      await disposal;
      expect(disposed).toBe(true);

      const records = await trail.query({ runId: 'run-inflight-write' });
      expect(records).toHaveLength(1);
    });

    it('dispose() resolves promptly when there is nothing in flight', async () => {
      const kv = textValueStore(new MemoryStorage());
      const { bureau } = createStubBureau();
      const trail = createAuditTrail(bureau, kv);
      await trail.dispose();
    });

    it("record()'s write is tracked so dispose() awaits it even when the caller never awaits record()", async () => {
      const { kv, release } = createControllableKv();
      const { bureau } = createStubBureau();
      const trail = createAuditTrail(bureau, kv);

      // Deliberately not awaited — the caller fires-and-forgets.
      void trail.record({
        runId: 'run-unawaited-record',
        type: 'review.tool-approval.approved',
        detail: null,
      });

      let disposed = false;
      const disposal = trail.dispose().then(() => {
        disposed = true;
      });

      await Promise.resolve();
      await Promise.resolve();
      expect(disposed).toBe(false);

      release();
      await disposal;
      expect(disposed).toBe(true);
    });

    it('refuses to start a new write, from the listener, once the owner-issued signal aborts', async () => {
      const kv = textValueStore(new MemoryStorage());
      const { bureau, emit } = createStubBureau();
      const controller = new AbortController();
      const trail = createAuditTrail(bureau, kv, undefined, { signal: controller.signal });

      controller.abort();
      emit(
        new ActionEvent({
          type: 'tool.started',
          timestamp: 7000,
          sequence: 1,
          runId: 'run-after-abort',
          detail: null,
        }),
      );

      await trail.dispose();
      const records = await trail.query({ runId: 'run-after-abort' });
      expect(records).toHaveLength(0);
    });

    it('refuses to start a new write from record() once the owner-issued signal aborts', async () => {
      const kv = textValueStore(new MemoryStorage());
      const { bureau } = createStubBureau();
      const controller = new AbortController();
      const trail = createAuditTrail(bureau, kv, undefined, { signal: controller.signal });

      controller.abort();
      await trail.record({
        runId: 'run-record-after-abort',
        type: 'review.tool-approval.approved',
        detail: null,
      });

      const records = await trail.query({ runId: 'run-record-after-abort' });
      expect(records).toHaveLength(0);
      await trail.dispose();
    });

    it('still starts a write when the owner-issued signal has not aborted', async () => {
      const kv = textValueStore(new MemoryStorage());
      const { bureau, emit } = createStubBureau();
      const controller = new AbortController();
      const trail = createAuditTrail(bureau, kv, undefined, { signal: controller.signal });

      emit(
        new ActionEvent({
          type: 'tool.started',
          timestamp: 8000,
          sequence: 1,
          runId: 'run-before-abort',
          detail: null,
        }),
      );
      await trail.dispose();

      const records = await trail.query({ runId: 'run-before-abort' });
      expect(records).toHaveLength(1);
    });
  });

  /**
   * AB-228 — closes `AUDIT_EVENT_TYPES` parity gaps AB-87's matrix named.
   * Each of these confirms the type reaches `AuditTrail`'s durable write
   * from its OWN emission point, not merely that the string sits in the
   * allowlist array.
   */
  describe('AB-228 parity gaps', () => {
    it('sinks session.deleted bureau-level events under a synthetic session:<id> owner, which never traverse the action stream (Codex P1 review finding, PR #566)', async () => {
      const kv = textValueStore(new MemoryStorage());
      const { bureau, emit } = createStubBureau();
      const trail = createAuditTrail(bureau, kv);

      emit(new SessionDeletedEvent('session-1'));
      await yieldToPortableEventLoop();

      const records = await trail.query({ runId: 'session:session-1' });
      expect(records).toHaveLength(1);
      expect(records[0]?.type).toBe('session.deleted');
      expect(records[0]?.detail).toEqual({ sessionId: 'session-1' });
      trail.dispose();
    });

    it('sinks budget.exceeded action events (no production emitter — AB-231, merged, chose a different terminal path — but the type stays harmlessly listed for allowlist completeness)', async () => {
      const kv = textValueStore(new MemoryStorage());
      const { bureau, emit } = createStubBureau();
      const trail = createAuditTrail(bureau, kv);

      const action: Action = {
        type: 'budget.exceeded',
        timestamp: 9100,
        sequence: 1,
        runId: 'run-budget-exceeded',
        detail: { currentCost: 6, budget: 5 },
      };
      emit(new ActionEvent(action));
      await yieldToPortableEventLoop();

      const records = await trail.query({ type: 'budget.exceeded' });
      expect(records).toHaveLength(1);
      trail.dispose();
    });

    it('sinks toolbox.loop-warning action events under the toolbox-forwarded wire string, not the bare armorer name', async () => {
      const kv = textValueStore(new MemoryStorage());
      const { bureau, emit } = createStubBureau();
      const trail = createAuditTrail(bureau, kv);

      // The armorer event's own `.type` is the bare `loop-warning`
      // (`ToolboxLoopWarningEvent.type`), but `forwardEvents` re-dispatches
      // every toolbox event onto the run's emitter as `toolbox.<type>`
      // before the operative store turns it into an `Action` — so this is
      // the string that actually reaches this trail's `'action'` listener.
      const action: Action = {
        type: 'toolbox.loop-warning',
        timestamp: 9200,
        sequence: 1,
        runId: 'run-loop-warning',
        detail: { detector: 'sliding-window', count: 3, message: 'repeated calls detected' },
      };
      emit(new ActionEvent(action));
      await yieldToPortableEventLoop();

      const records = await trail.query({ type: 'toolbox.loop-warning' });
      expect(records).toHaveLength(1);
      trail.dispose();
    });

    it('sinks toolbox.loop-blocked action events under the toolbox-forwarded wire string', async () => {
      const kv = textValueStore(new MemoryStorage());
      const { bureau, emit } = createStubBureau();
      const trail = createAuditTrail(bureau, kv);

      const action: Action = {
        type: 'toolbox.loop-blocked',
        timestamp: 9300,
        sequence: 1,
        runId: 'run-loop-blocked',
        detail: { detector: 'sliding-window', count: 5, message: 'blocked repeated calls' },
      };
      emit(new ActionEvent(action));
      await yieldToPortableEventLoop();

      const records = await trail.query({ type: 'toolbox.loop-blocked' });
      expect(records).toHaveLength(1);
      trail.dispose();
    });

    it('does not sink the bare, un-prefixed loop-warning/loop-blocked type strings', async () => {
      const kv = textValueStore(new MemoryStorage());
      const { bureau, emit } = createStubBureau();
      const trail = createAuditTrail(bureau, kv);

      emit(
        new ActionEvent({
          type: 'loop-warning',
          timestamp: 9400,
          sequence: 1,
          runId: 'run-bare-loop-warning',
          detail: null,
        }),
      );
      await yieldToPortableEventLoop();

      expect(await trail.query({ type: 'loop-warning' })).toHaveLength(0);
      trail.dispose();
    });

    it('sinks toolbox.budget-exceeded action events under the toolbox-forwarded wire string, distinct from the orphaned bare budget.exceeded (Codex P2 review finding, PR #566)', async () => {
      const kv = textValueStore(new MemoryStorage());
      const { bureau, emit } = createStubBureau();
      const trail = createAuditTrail(bureau, kv);

      // The armorer event's own `.type` is the bare `budget-exceeded`
      // (`ToolboxBudgetExceededEvent.type`), but `forwardEvents`
      // re-dispatches every toolbox event onto the run's emitter as
      // `toolbox.<type>` before the operative store turns it into an
      // `Action` — the SAME mechanism `toolbox.loop-warning`/`loop-blocked`
      // above go through, and distinct from the orphaned operative-level
      // `BudgetExceededEvent` class the bare `budget.exceeded` entry covers.
      const action: Action = {
        type: 'toolbox.budget-exceeded',
        timestamp: 9350,
        sequence: 1,
        runId: 'run-budget-exceeded-toolbox',
        detail: { reason: 'max-calls' },
      };
      emit(new ActionEvent(action));
      await yieldToPortableEventLoop();

      const records = await trail.query({ type: 'toolbox.budget-exceeded' });
      expect(records).toHaveLength(1);
      trail.dispose();
    });

    it('sinks schedule.created bureau-level events under a synthetic schedule:<id> owner, which never traverse the action stream', async () => {
      const kv = textValueStore(new MemoryStorage());
      const { bureau, emit } = createStubBureau();
      const trail = createAuditTrail(bureau, kv);

      emit(
        new AgentScheduledEvent({
          scheduleId: 'schedule-created-1',
          agentName: 'researcher',
          spec: { every: '1h' },
          sessionId: 'session-1',
        }),
      );
      await yieldToPortableEventLoop();

      const createdRecords = await trail.query({ runId: 'schedule:schedule-created-1' });
      expect(createdRecords).toHaveLength(1);
      expect(createdRecords[0]?.type).toBe('schedule.created');
      expect(createdRecords[0]?.detail).toEqual({
        scheduleId: 'schedule-created-1',
        agentName: 'researcher',
        spec: { every: '1h' },
        sessionId: 'session-1',
      });

      trail.dispose();
    });

    it('sinks schedule.paused/resumed/cancelled bureau-level events, which never traverse the action stream', async () => {
      const kv = textValueStore(new MemoryStorage());
      const { bureau, emit } = createStubBureau();
      const trail = createAuditTrail(bureau, kv);

      emit(new SchedulePausedEvent('schedule-1'));
      emit(new ScheduleResumedEvent('schedule-1'));
      emit(new ScheduleCancelledEvent('schedule-2'));
      await yieldToPortableEventLoop();

      const pausedRecords = await trail.query({ type: 'schedule.paused' });
      expect(pausedRecords).toHaveLength(1);
      expect(pausedRecords[0]?.detail).toEqual({ scheduleId: 'schedule-1' });

      const resumedRecords = await trail.query({ type: 'schedule.resumed' });
      expect(resumedRecords).toHaveLength(1);
      expect(resumedRecords[0]?.detail).toEqual({ scheduleId: 'schedule-1' });

      const cancelledRecords = await trail.query({ type: 'schedule.cancelled' });
      expect(cancelledRecords).toHaveLength(1);
      expect(cancelledRecords[0]?.detail).toEqual({ scheduleId: 'schedule-2' });

      trail.dispose();
    });

    it('query({ runId }) waits for that owner\'s still-in-flight write, giving read-your-writes even against a KV whose set() resolves asynchronously (Codex P2 review finding, PR #566, "Wait for schedule audit writes before returning success")', async () => {
      const { kv, release, setCallCount } = createControllableKv();
      const { bureau, emit } = createStubBureau();
      const trail = createAuditTrail(bureau, kv);

      emit(new SchedulePausedEvent('schedule-inflight'));
      // The listener dispatches synchronously, so `kv.set` has already been
      // called (and is gated) before `query()` below ever runs.
      expect(setCallCount()).toBe(1);

      // Filtered by the schedule's own synthetic owner id — the shape every
      // real caller chasing read-your-writes for its OWN just-issued write
      // actually uses (see `scheduleOwnerId`/`sessionOwnerId` in
      // `audit-trail.ts`).
      const queryPromise = trail.query({ runId: 'schedule:schedule-inflight' });

      let queryResolved = false;
      void queryPromise.then(() => {
        queryResolved = true;
      });
      // The write is deliberately still gated — query() must not resolve
      // (and thus must not report an empty result) while it's in flight.
      await Promise.resolve();
      await Promise.resolve();
      expect(queryResolved).toBe(false);

      release();
      const records = await queryPromise;
      expect(records).toHaveLength(1);
      expect(records[0]?.detail).toEqual({ scheduleId: 'schedule-inflight' });

      trail.dispose();
    });

    it('query({ runId }) does NOT wait on an unrelated owner\'s stalled write, so one hung write cannot hang every other query (Codex P2 review finding, PR #566, "Avoid blocking every audit query on unrelated writes")', async () => {
      const { kv, setCallCount } = createControllableKv();
      const { bureau, emit } = createStubBureau();
      const trail = createAuditTrail(bureau, kv);

      // This write is gated forever within this test — deliberately never
      // released, standing in for a genuinely stalled storage backend.
      emit(new SchedulePausedEvent('schedule-stuck'));
      expect(setCallCount()).toBe(1);

      // A query scoped to a DIFFERENT owner must resolve promptly — it has
      // nothing in `activeWritesByRunId` for its own runId to wait on, so
      // the unrelated stuck write for `schedule:schedule-stuck` never
      // enters its wait at all.
      const records = await trail.query({ runId: 'schedule:some-other-owner' });
      expect(records).toEqual([]);

      // A fully unscoped query (no runId filter) likewise does not hang —
      // it has no single owner to scope a wait to, by design.
      const allRecords = await trail.query();
      expect(allRecords).toEqual([]);

      trail.dispose();
    });

    it('does not write a schedule.* record when no kv store is configured', async () => {
      const { bureau, emit } = createStubBureau();
      const trail = createAuditTrail(bureau, undefined);

      emit(new SchedulePausedEvent('schedule-ephemeral'));
      await yieldToPortableEventLoop();

      expect(await trail.query()).toEqual([]);
      trail.dispose();
    });

    it('stops writing schedule.* records after dispose() removes its listeners', async () => {
      const kv = textValueStore(new MemoryStorage());
      const { bureau, emit } = createStubBureau();
      const trail = createAuditTrail(bureau, kv);
      await trail.dispose();

      emit(new SchedulePausedEvent('schedule-after-dispose'));
      await yieldToPortableEventLoop();

      expect(await trail.query({ type: 'schedule.paused' })).toEqual([]);
    });
  });

  // AB-370: one shared, monotonic `sequence` counter for every write path —
  // see `AuditRecord.sequence`'s own doc comment for what this replaced.
  describe('AB-370 — shared sequence counter', () => {
    it('assigns sequence from one shared counter across the action-stream listener and record()', async () => {
      const kv = textValueStore(new MemoryStorage());
      const { bureau, emit } = createStubBureau();
      const trail = createAuditTrail(bureau, kv);

      emit(
        new ActionEvent({
          type: 'tool.started',
          timestamp: 1000,
          sequence: 999, // deliberately far from the trail's own counter
          runId: 'run-shared-seq',
          detail: null,
        }),
      );
      await yieldToPortableEventLoop();
      await trail.record({
        runId: 'run-shared-seq',
        type: 'review.tool-approval.approved',
        detail: {},
      });

      const records = await trail.query({ runId: 'run-shared-seq' });
      expect(records).toHaveLength(2);
      // The action-stream record got sequence 0 (the counter's first value,
      // NOT the action's own sequence 999 — that is preserved separately as
      // `actionSequence`), and the out-of-band `record()` call — which
      // happened strictly after, in real call order — got sequence 1.
      const toolRecord = records.find((r) => r.type === 'tool.started');
      const reviewRecord = records.find((r) => r.type === 'review.tool-approval.approved');
      expect(toolRecord?.sequence).toBe(0);
      expect(toolRecord?.actionSequence).toBe(999);
      expect(reviewRecord?.sequence).toBe(1);
      expect(reviewRecord?.actionSequence).toBeUndefined();

      trail.dispose();
    });

    it('resumes the counter above the highest sequence a prior process lifetime persisted', async () => {
      const kv = textValueStore(new MemoryStorage());
      const { bureau } = createStubBureau();

      // Simulate records a PRIOR bureau process already persisted, at
      // sequences 5 and 12 — the highest of the two.
      await seedRecord(kv, makeRecord(5, { timestampMs: 1000, runId: 'run-prior' }));
      await seedRecord(kv, makeRecord(12, { timestampMs: 2000, runId: 'run-prior' }));

      const initialSequence = await computeInitialAuditSequence(kv);
      expect(initialSequence).toBe(13);

      const trail = createAuditTrail(bureau, kv, undefined, { initialSequence });
      await trail.record({ runId: 'run-boot', type: 'review.tool-approval.approved', detail: {} });

      const [record] = await trail.query({ runId: 'run-boot' });
      // The new process's first write must land ABOVE the prior lifetime's
      // highest persisted sequence, never re-issuing (or colliding with) 12.
      expect(record?.sequence).toBe(13);

      trail.dispose();
    });

    it('query() sorts a sequence-less legacy record before every real sequence sharing its millisecond, using a transitive comparator (Codex P2 review finding, PR #594)', async () => {
      const kv = textValueStore(new MemoryStorage());
      // Written in an order a `0`-for-either-side comparator would leave
      // UNCHANGED (seq 2, then the legacy record, then seq 1) — proving
      // this is a genuine sort, not an artifact of already-sorted input.
      await seedRecord(kv, makeRecord(2, { timestampMs: 5000, runId: 'run-X' }));
      await kv.set(
        'audit:v1:0000000000005000:legacy:run-X',
        JSON.stringify({
          timestamp: new Date(5000).toISOString(),
          timestampMs: 5000,
          runId: 'run-X',
          type: 'tool.started',
          detail: { marker: 'legacy' },
        }),
      );
      await seedRecord(kv, makeRecord(1, { timestampMs: 5000, runId: 'run-X' }));

      const { bureau } = createStubBureau();
      const trail = createAuditTrail(bureau, kv);
      const records = await trail.query({ runId: 'run-X' });

      expect(records).toHaveLength(3);
      // Legacy (mapped to -1) first, then ascending real sequence.
      expect(records[0]?.sequence).toBeUndefined();
      expect(records[1]?.sequence).toBe(1);
      expect(records[2]?.sequence).toBe(2);

      trail.dispose();
    });

    it('computeInitialAuditSequence returns 0 for a store with no persisted records', async () => {
      const kv = textValueStore(new MemoryStorage());
      expect(await computeInitialAuditSequence(kv)).toBe(0);
    });

    it('computeInitialAuditSequence returns 0 when no kv store is configured', async () => {
      expect(await computeInitialAuditSequence(undefined)).toBe(0);
    });

    it('computeInitialAuditSequence ignores a legacy record with no sequence field', async () => {
      const kv = textValueStore(new MemoryStorage());
      // A record written before `sequence` existed — `encodeKey` always
      // requires a numeric argument, so a genuinely pre-`sequence` key
      // could never have used TODAY's `<ts>:<seq>:<runId>` shape; this key
      // stands in for that by using a non-numeric placeholder segment
      // where `<seq>` would be, which `parseSequenceFromKey`'s fast path
      // must reject (falling back to reading the record itself) rather
      // than crash the scan or count as a real sequence to resume above.
      await kv.set(
        'audit:v1:0000000000001000:legacy:run-legacy',
        JSON.stringify({
          timestamp: new Date(1000).toISOString(),
          timestampMs: 1000,
          runId: 'run-legacy',
          type: 'tool.started',
          detail: null,
        }),
      );
      expect(await computeInitialAuditSequence(kv)).toBe(0);
    });

    it('computeInitialAuditSequence falls back to reading a record whose key it cannot fast-path parse, and still counts its real sequence', async () => {
      const kv = textValueStore(new MemoryStorage());
      // A key `parseSequenceFromKey` cannot fast-path (non-numeric segment
      // where `<seq>` would be) but whose stored JSON DOES carry a real,
      // valid `sequence` — the fallback read must still find and count it.
      await kv.set(
        'audit:v1:0000000000001000:unparseable:run-fallback',
        JSON.stringify(makeRecord(9, { timestampMs: 1000, runId: 'run-fallback' })),
      );
      expect(await computeInitialAuditSequence(kv)).toBe(10);
    });

    it('computeInitialAuditSequence skips a record whose stored JSON is malformed instead of throwing', async () => {
      const kv = textValueStore(new MemoryStorage());
      await seedRecord(kv, makeRecord(3, { timestampMs: 1000, runId: 'run-ok' }));
      // A non-numeric key segment forces `parseSequenceFromKey`'s fast path
      // to fall back to `kv.get` + `JSON.parse` for THIS key — which is
      // exactly the malformed-JSON case this test targets.
      await kv.set('audit:v1:0000000000002000:corrupt:run-corrupt', '{not valid json');

      // The malformed record must not crash the scan and must not count as
      // a real sequence — the valid record's sequence (3) still wins.
      expect(await computeInitialAuditSequence(kv)).toBe(4);
    });

    it('computeInitialAuditSequence falls back to 0 and diagnoses when the scan fails and no emergencyFloor is supplied', async () => {
      const failingKv: ReturnType<typeof textValueStore> = {
        ...textValueStore(new MemoryStorage()),
        list: async () => {
          throw new Error('storage unavailable');
        },
      };
      const received: unknown[] = [];
      const result = await computeInitialAuditSequence(failingKv, (diagnostic) =>
        received.push(diagnostic),
      );
      expect(result).toBe(0);
      expect(received).toHaveLength(1);
    });

    it('computeInitialAuditSequence uses the caller-supplied emergencyFloor instead of 0 when the scan fails against a store that already holds records (AB-370 Codex P1 finding)', async () => {
      // A bare `0` fallback here would silently reopen this issue's own
      // bug: a fresh process reusing a sequence value a prior lifetime
      // already persisted. `emergencyFloor` — `create-bureau.ts` always
      // passes `runtimeServices.clock.now()` — must win instead.
      const failingKv: ReturnType<typeof textValueStore> = {
        ...textValueStore(new MemoryStorage()),
        list: async () => {
          throw new Error('storage unavailable');
        },
      };
      const received: unknown[] = [];
      const result = await computeInitialAuditSequence(
        failingKv,
        (diagnostic) => received.push(diagnostic),
        () => 1_700_000_000_000,
      );
      expect(result).toBe(1_700_000_000_000);
      expect(received).toHaveLength(1);
    });
  });
});
