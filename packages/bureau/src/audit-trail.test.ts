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
import { CompletableEventTarget, createManualRuntimeServices } from 'lifecycle';

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

  describe('record() dedupeKey (AB-391, Codex review finding, PR #601, "Make attachment replay deduplication atomic")', () => {
    it('a second record() call with the SAME dedupeKey is a no-op — no second record is written', async () => {
      const kv = textValueStore(new MemoryStorage());
      const { bureau } = createStubBureau();
      const trail = createAuditTrail(bureau, kv);

      const entry = {
        runId: 'run-dedupe-1',
        type: 'review.tool-approval.approved',
        detail: { decision: 'approve' },
        principal: 'api-key:reviewer-1',
        dedupeKey: 'session.attachment:session-1:3',
      };
      await trail.record(entry);
      await trail.record(entry);

      const records = await trail.query({ runId: 'run-dedupe-1' });
      expect(records).toHaveLength(1);
      trail.dispose();
    });

    it('two CONCURRENT record() calls with the SAME dedupeKey — simulating two Bureau processes racing after a lease renewal failure — still produce exactly one record', async () => {
      // The exact race Codex's finding described: a read-before-write
      // existence check has a window between the read and the write that
      // two concurrent callers can both pass through before either writes.
      // `dedupeKey`'s atomic compare-and-swap has no such window — both
      // calls START before either COMPLETES, and only one can win the
      // underlying `conditionalBatch`.
      const kv = textValueStore(new MemoryStorage());
      const { bureau } = createStubBureau();
      const trail = createAuditTrail(bureau, kv);

      const entry = {
        runId: 'run-dedupe-race',
        type: 'review.tool-approval.approved',
        detail: { decision: 'approve' },
        principal: 'api-key:reviewer-1',
        dedupeKey: 'session.attachment:session-race:7',
      };
      await Promise.all([trail.record(entry), trail.record(entry)]);

      const records = await trail.query({ runId: 'run-dedupe-race' });
      expect(records).toHaveLength(1);
      trail.dispose();
    });

    it('two DIFFERENT dedupeKeys for the same runId/type both persist their own record', async () => {
      const kv = textValueStore(new MemoryStorage());
      const { bureau } = createStubBureau();
      const trail = createAuditTrail(bureau, kv);

      await trail.record({
        runId: 'run-dedupe-2',
        type: 'review.tool-approval.approved',
        detail: { call: 1 },
        dedupeKey: 'session.attachment:session-2:1',
      });
      await trail.record({
        runId: 'run-dedupe-2',
        type: 'review.tool-approval.approved',
        detail: { call: 2 },
        dedupeKey: 'session.attachment:session-2:2',
      });

      const records = await trail.query({ runId: 'run-dedupe-2' });
      expect(records).toHaveLength(2);
      trail.dispose();
    });

    it('propagates a genuine storage failure from a dedupeKey write, unlike the default best-effort record() path', async () => {
      const backing = textValueStore(new MemoryStorage());
      const failingKv: typeof backing = {
        ...backing,
        conditionalBatch: () => Promise.reject(new Error('storage unavailable')),
      };
      const { bureau } = createStubBureau();
      const trail = createAuditTrail(bureau, failingKv);

      await expect(
        trail.record({
          runId: 'run-dedupe-failure',
          type: 'review.tool-approval.approved',
          detail: {},
          dedupeKey: 'session.attachment:session-failure:1',
        }),
      ).rejects.toThrow('storage unavailable');
      trail.dispose();
    });
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

    it('a dedupeKey-guarded record() REJECTS (rather than silently no-op resolving) once the owner-issued signal aborts', async () => {
      // AB-391: unlike the default best-effort path above, a caller that
      // supplied `dedupeKey` opted into knowing whether its write actually
      // happened — a silent resolve here would be indistinguishable from
      // "already recorded" to `create-bureau.ts`'s `drainOutboxAttachmentEntry`,
      // which would then acknowledge (permanently remove) an outbox entry
      // whose fact was never durably written, reintroducing the exact
      // record loss this issue exists to close (via a shutdown race
      // instead of a crash, since a late `SessionOutboxAppendedEvent`
      // trigger has no admission check of its own).
      const kv = textValueStore(new MemoryStorage());
      const { bureau } = createStubBureau();
      const controller = new AbortController();
      const trail = createAuditTrail(bureau, kv, undefined, { signal: controller.signal });

      controller.abort();
      await expect(
        trail.record({
          runId: 'run-dedupe-after-abort',
          type: 'review.tool-approval.approved',
          detail: null,
          dedupeKey: 'session.attachment:session-after-abort:1',
        }),
      ).rejects.toThrow(/shutdown signal is already aborted/);

      const records = await trail.query({ runId: 'run-dedupe-after-abort' });
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

      emit(new SessionDeletedEvent('session-1', 'incarnation-1', 1, 0));
      await yieldToPortableEventLoop();

      const records = await trail.query({ runId: 'session:session-1' });
      expect(records).toHaveLength(1);
      expect(records[0]?.type).toBe('session.deleted');
      expect(records[0]?.detail).toEqual({ sessionId: 'session-1', incarnation: 'incarnation-1' });
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
      // Written out of final order; `query()`'s own `keys.sort()` (a
      // separate, lexicographic KEY sort used only for bounding the scan
      // — see its own doc comment) reorders the raw scan to
      // [seq 1, seq 2, legacy] first (digits sort before the letter 'l'),
      // which is STILL not the desired [legacy, seq 1, seq 2] final
      // order — so the explicit `sequence`-tiebreak comparator below is
      // what a `0`-for-either-side comparator would have left unchanged
      // from that intermediate order, proving this is a genuine sort.
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

    it('computeInitialAuditSequence retries a transient scan failure and succeeds on the second attempt', async () => {
      // AB-370 (Codex review, PR #594, two rounds — see this function's own
      // doc comment for why NEITHER a bare `0` NOR a clock-based
      // "emergency floor" is a safe first-failure fallback): a genuinely
      // transient blip should recover on retry rather than falling back
      // to anything at all.
      const base = textValueStore(new MemoryStorage());
      await seedRecord(base, makeRecord(7, { timestampMs: 1000, runId: 'run-retry' }));
      let attempts = 0;
      const flakyKv: ReturnType<typeof textValueStore> = {
        ...base,
        list: async (prefix: string) => {
          attempts += 1;
          if (attempts === 1) throw new Error('storage temporarily unavailable');
          return base.list(prefix);
        },
      };
      const received: unknown[] = [];
      const result = await computeInitialAuditSequence(flakyKv, (diagnostic) =>
        received.push(diagnostic),
      );
      expect(result).toBe(8);
      expect(attempts).toBe(2);
      // One diagnostic for the failed first attempt; no "exhausted" diagnostic.
      expect(received).toHaveLength(1);
    });

    it('computeInitialAuditSequence falls back to 0 and diagnoses loudly after exhausting every retry', async () => {
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
      // Three per-attempt diagnostics plus one final "starting from 0" one.
      expect(received).toHaveLength(4);
    });

    it('computeInitialAuditSequence rejects an unsafe stored sequence during the fallback scan instead of adopting it as the floor', async () => {
      // Codex P2 review finding, PR #594: a corrupted record whose stored
      // `sequence` is astronomically large (e.g. `1e308`) must not poison
      // `highest` — incrementing a value that large no longer even changes
      // it, which would collapse every subsequent same-millisecond write
      // for the same run onto the exact same key.
      const kv = textValueStore(new MemoryStorage());
      await seedRecord(kv, makeRecord(3, { timestampMs: 1000, runId: 'run-ok' }));
      await kv.set(
        // A non-numeric key segment forces the slow fallback path.
        'audit:v1:0000000000002000:unsafe:run-unsafe',
        JSON.stringify({
          timestamp: new Date(2000).toISOString(),
          timestampMs: 2000,
          runId: 'run-unsafe',
          type: 'tool.started',
          sequence: 1e308,
          detail: null,
        }),
      );
      // The unsafe value must be rejected — the valid record's sequence
      // (3) still wins, not `1e308 + 1` (a no-op on a float that large).
      expect(await computeInitialAuditSequence(kv)).toBe(4);
    });
  });

  describe('AB-388 — prune()', () => {
    it('returns undefined and prunes nothing when no kv store is configured', async () => {
      const { bureau } = createStubBureau();
      const trail = createAuditTrail(bureau, undefined);
      expect(await trail.prune(5000)).toBeUndefined();
      trail.dispose();
    });

    it('deletes every record strictly before the cutoff, leaves records at or after it untouched, and writes one audit.pruned record naming the count and cutoff', async () => {
      const kv = textValueStore(new MemoryStorage());
      await seedRecord(kv, makeRecord(0, { timestampMs: 1000, runId: 'run-old-1' }));
      await seedRecord(kv, makeRecord(1, { timestampMs: 2000, runId: 'run-old-2' }));
      // Exactly at the cutoff — NOT pruned; the boundary is exclusive on
      // the cutoff side (only strictly-older records are removed).
      await seedRecord(kv, makeRecord(2, { timestampMs: 5000, runId: 'run-at-cutoff' }));
      await seedRecord(kv, makeRecord(3, { timestampMs: 9000, runId: 'run-new' }));

      const { bureau } = createStubBureau();
      const trail = createAuditTrail(bureau, kv, undefined, { initialSequence: 4 });

      const result = await trail.prune(5000);
      expect(result).toEqual({ prunedCount: 2, cutoffMs: 5000 });

      const remaining = await trail.query();
      // Includes the pass's own `audit.pruned` summary record, written at
      // "now" (the real clock, since this test supplies no manual
      // runtime) — strictly after every seeded fixture timestamp, so it
      // is never itself a candidate for this same pass's cutoff. Its
      // `runId` is `bureau:audit-retention:<leaseToken>` (Codex review,
      // PR #597, "Give prune summaries cross-instance-unique keys") — the
      // token itself is a fresh, unpredictable identifier from the
      // (real, non-manual) runtime here, so this checks the fixed prefix
      // rather than an exact match.
      const summaryRunIds = remaining
        .map((r) => r.runId)
        .filter((runId) => runId.startsWith('bureau:audit-retention'));
      expect(summaryRunIds).toHaveLength(1);
      expect(
        remaining
          .map((r) => r.runId)
          .filter((runId) => !runId.startsWith('bureau:audit-retention'))
          .sort(),
      ).toEqual(['run-at-cutoff', 'run-new']);

      const auditPrunedRecords = await trail.query({ type: 'audit.pruned' });
      expect(auditPrunedRecords).toHaveLength(1);
      expect(auditPrunedRecords[0]?.detail).toEqual({ count: 2, cutoffMs: 5000 });

      trail.dispose();
    });

    it('writes no audit.pruned record and touches nothing when no record qualifies', async () => {
      const kv = textValueStore(new MemoryStorage());
      await seedRecord(kv, makeRecord(0, { timestampMs: 9000, runId: 'run-new' }));

      const { bureau } = createStubBureau();
      const trail = createAuditTrail(bureau, kv, undefined, { initialSequence: 1 });

      const result = await trail.prune(1000);
      expect(result).toEqual({ prunedCount: 0, cutoffMs: 1000 });

      const records = await trail.query();
      expect(records).toHaveLength(1);
      expect(records[0]?.runId).toBe('run-new');

      trail.dispose();
    });

    it('persists the highest pruned sequence so computeInitialAuditSequence resumes above it even when every remaining record is gone', async () => {
      const kv = textValueStore(new MemoryStorage());
      await seedRecord(kv, makeRecord(40, { timestampMs: 1000, runId: 'run-old-1' }));
      await seedRecord(kv, makeRecord(41, { timestampMs: 2000, runId: 'run-old-2' }));

      const { bureau } = createStubBureau();
      const trail = createAuditTrail(bureau, kv, undefined, { initialSequence: 42 });

      // Prune EVERYTHING — the pass's own summary record (sequence 42)
      // survives the cutoff since it is written after the cutoff is
      // computed, at "now", which the test's cutoff is set safely past.
      const result = await trail.prune(Number.MAX_SAFE_INTEGER);
      expect(result?.prunedCount).toBe(2);

      // Without the persisted floor, a naive re-scan of what remains (only
      // the just-written `audit.pruned` record, sequence 42) would still
      // recover 43 here by coincidence — so assert the floor mechanism
      // directly: delete that survivor too, leaving NOTHING for a fresh
      // scan to learn from, and prove the persisted floor alone recovers
      // the correct watermark.
      const survivors = await trail.query();
      for (const record of survivors) {
        const ts = record.timestampMs.toString().padStart(16, '0');
        const seq = (record.sequence ?? 0).toString().padStart(12, '0');
        await kv.delete(`audit:v1:${ts}:${seq}:${record.runId}`);
      }
      expect(await trail.query()).toHaveLength(0);

      const nextInitialSequence = await computeInitialAuditSequence(kv);
      expect(nextInitialSequence).toBe(42);

      trail.dispose();
    });

    it("a later pass pruning a LOWER sequence than an earlier pass's persisted floor never regresses that floor", async () => {
      const kv = textValueStore(new MemoryStorage());
      await seedRecord(kv, makeRecord(10, { timestampMs: 1000, runId: 'run-a' }));

      const { bureau } = createStubBureau();
      const trail = createAuditTrail(bureau, kv, undefined, { initialSequence: 21 });

      // First pass prunes run-a (sequence 10) — persists floor 10.
      await trail.prune(1500);

      // A record with a LOWER sequence than the persisted floor shows up
      // later (e.g. a legacy write straggling in) and a second pass prunes
      // it too — the floor must stay at 10, the highest ever pruned, not
      // regress to this pass's own lower highest (3).
      await seedRecord(kv, makeRecord(3, { timestampMs: 500, runId: 'run-legacy' }));
      await trail.prune(1500);

      const survivors = await trail.query();
      for (const record of survivors) {
        const ts = record.timestampMs.toString().padStart(16, '0');
        const seq = (record.sequence ?? 0).toString().padStart(12, '0');
        await kv.delete(`audit:v1:${ts}:${seq}:${record.runId}`);
      }

      expect(await computeInitialAuditSequence(kv)).toBe(11);

      trail.dispose();
    });

    it('prunes a well-formed key past the cutoff without ever reading its stored value (key-only fast path)', async () => {
      // A `TextValueStore` stub whose `get()` throws on ANY call proves
      // this key — well-formed by `encodeKey`'s own shape — is pruned
      // through `parsePruneCandidateFromKey` alone: `kv.get` is never
      // reached for it, only `kv.delete`.
      const base = textValueStore(new MemoryStorage());
      await base.set(
        'audit:v1:0000000000001000:000000000000:run-old',
        JSON.stringify(makeRecord(0, { timestampMs: 1000, runId: 'run-old' })),
      );
      const kv: ReturnType<typeof textValueStore> = {
        ...base,
        get(key: string) {
          if (key === 'audit:v1:0000000000001000:000000000000:run-old') {
            throw new Error('kv.get should never be called for a well-formed key');
          }
          return base.get(key);
        },
      };

      const { bureau } = createStubBureau();
      const trail = createAuditTrail(bureau, kv, undefined, { initialSequence: 1 });

      const result = await trail.prune(5000);
      expect(result?.prunedCount).toBe(1);
      expect(await base.get('audit:v1:0000000000001000:000000000000:run-old')).toBeNull();

      trail.dispose();
    });

    it('falls back to reading and decoding a key the fast path cannot parse, and skips it when the stored JSON is corrupted', async () => {
      // A non-numeric sequence segment forces the fallback
      // (`computeInitialAuditSequence`'s tests use the identical trick for
      // its own fast path) — the stored value at that key is then
      // corrupted JSON, so the fallback's own decode failure is what
      // leaves it untouched, not the key shape by itself.
      const kv = textValueStore(new MemoryStorage());
      await seedRecord(kv, makeRecord(0, { timestampMs: 1000, runId: 'run-old' }));
      await kv.set('audit:v1:0000000000001500:not-a-number:run-corrupt', '{not json');

      const { bureau } = createStubBureau();
      const trail = createAuditTrail(bureau, kv, undefined, { initialSequence: 2 });

      const result = await trail.prune(5000);
      expect(result).toEqual({ prunedCount: 1, cutoffMs: 5000 });

      // Never decoded well enough to judge, so never deleted either.
      expect(await kv.get('audit:v1:0000000000001500:not-a-number:run-corrupt')).toBe('{not json');

      trail.dispose();
    });

    it('falls back to reading and decoding a key the fast path cannot parse, and still prunes it when the decoded record is past the cutoff', async () => {
      // Same non-numeric-sequence-segment trick as the sibling test, but
      // this time the stored VALUE decodes fine and is genuinely past the
      // cutoff — proving the fallback path prunes a record it can
      // successfully decode, not just tolerates one it can't.
      const kv = textValueStore(new MemoryStorage());
      const legacyKey = 'audit:v1:0000000000001500:not-a-number:run-legacy';
      await kv.set(
        legacyKey,
        JSON.stringify(makeRecord(7, { timestampMs: 1500, runId: 'run-legacy' })),
      );

      const { bureau } = createStubBureau();
      const trail = createAuditTrail(bureau, kv, undefined, { initialSequence: 8 });

      const result = await trail.prune(5000);
      expect(result).toEqual({ prunedCount: 1, cutoffMs: 5000 });
      expect(await kv.get(legacyKey)).toBeNull();

      trail.dispose();
    });

    it('refuses to prune once the owner-issued signal has aborted', async () => {
      const kv = textValueStore(new MemoryStorage());
      await seedRecord(kv, makeRecord(0, { timestampMs: 1000, runId: 'run-old' }));

      const controller = new AbortController();
      const { bureau } = createStubBureau();
      const trail = createAuditTrail(bureau, kv, undefined, {
        initialSequence: 1,
        signal: controller.signal,
      });

      controller.abort();
      const result = await trail.prune(Number.MAX_SAFE_INTEGER);
      expect(result).toBeUndefined();

      const records = await trail.query();
      expect(records).toHaveLength(1);

      trail.dispose();
    });

    it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
      'refuses to prune anything for a non-finite cutoffMs (%p), rather than deleting the entire trail (Codex review, PR #597, "Reject non-finite and negative retention durations")',
      async (nonFiniteCutoff) => {
        const kv = textValueStore(new MemoryStorage());
        await seedRecord(kv, makeRecord(0, { timestampMs: 1000, runId: 'run-old' }));

        const { bureau } = createStubBureau();
        const trail = createAuditTrail(bureau, kv, undefined, { initialSequence: 1 });

        const result = await trail.prune(nonFiniteCutoff);
        expect(result).toBeUndefined();

        const records = await trail.query();
        expect(records).toHaveLength(1);

        trail.dispose();
      },
    );

    it('persists the highest-pruned-sequence watermark BEFORE deleting any qualifying record (Codex review, PR #597, "Persist the sequence watermark before deleting records")', async () => {
      const base = textValueStore(new MemoryStorage());
      await base.set(
        'audit:v1:0000000000001000:000000000005:run-old',
        JSON.stringify(makeRecord(5, { timestampMs: 1000, runId: 'run-old' })),
      );
      const operationLog: string[] = [];
      const trackedKv: ReturnType<typeof textValueStore> = {
        ...base,
        async set(key: string, value: string) {
          operationLog.push(`set:${key}`);
          await base.set(key, value);
        },
        async delete(key: string) {
          operationLog.push(`delete:${key}`);
          await base.delete(key);
        },
      };

      const { bureau } = createStubBureau();
      const trail = createAuditTrail(bureau, trackedKv, undefined, { initialSequence: 6 });

      await trail.prune(5000);

      const floorSetIndex = operationLog.findIndex((entry) =>
        entry.startsWith('set:audit-retention:v1:highest-pruned-sequence'),
      );
      const recordDeleteIndex = operationLog.findIndex(
        (entry) => entry === 'delete:audit:v1:0000000000001000:000000000005:run-old',
      );
      expect(floorSetIndex).toBeGreaterThanOrEqual(0);
      expect(recordDeleteIndex).toBeGreaterThanOrEqual(0);
      expect(floorSetIndex).toBeLessThan(recordDeleteIndex);

      trail.dispose();
    });

    it('skips a decoded value that is not a valid AuditRecord shape (e.g. null) rather than throwing, and still prunes a subsequent qualifying key (Codex review, PR #597, "Validate decoded records before pruning")', async () => {
      const kv = textValueStore(new MemoryStorage());
      // Non-numeric sequence segment forces the slow-path decode for both
      // keys (same trick the sibling fallback tests above use).
      await kv.set('audit:v1:0000000000001000:not-a-number:run-corrupt', JSON.stringify(null));
      // A decoded value that HAS every required field except a wrongly-typed
      // `sequence` (a string, not a number) — a different corruption shape
      // than outright `null`, exercising the guard's own `sequence`-type
      // branch specifically.
      await kv.set(
        'audit:v1:0000000000001200:bad-sequence-type:run-bad-sequence',
        JSON.stringify({ ...makeRecord(0, { timestampMs: 1200 }), sequence: 'not-a-number' }),
      );
      await seedRecord(kv, makeRecord(0, { timestampMs: 1500, runId: 'run-legacy' }));
      await kv.set(
        'audit:v1:0000000000002000:also-not-a-number:run-legacy-2',
        JSON.stringify(makeRecord(1, { timestampMs: 2000, runId: 'run-legacy-2' })),
      );

      const { bureau } = createStubBureau();
      const trail = createAuditTrail(bureau, kv, undefined, { initialSequence: 2 });

      const result = await trail.prune(5000);

      // Neither corrupt key throws or crashes the pass — the two genuinely
      // valid, qualifying keys are still pruned despite sorting after them
      // in `kv.list()`'s order.
      expect(result?.prunedCount).toBe(2);
      expect(await kv.get('audit:v1:0000000000001000:not-a-number:run-corrupt')).toBe(
        JSON.stringify(null),
      );
      expect(
        await kv.get('audit:v1:0000000000001200:bad-sequence-type:run-bad-sequence'),
      ).not.toBeNull();
      expect(await kv.get('audit:v1:0000000000002000:also-not-a-number:run-legacy-2')).toBeNull();

      const remaining = await trail.query({ runId: 'run-legacy' });
      expect(remaining).toHaveLength(0);

      trail.dispose();
    });

    it('serializes two concurrent prune() calls on the same instance so they never double-count a deletion (Codex review, PR #597, "Serialize concurrent audit-pruning passes")', async () => {
      const kv = textValueStore(new MemoryStorage());
      await seedRecord(kv, makeRecord(0, { timestampMs: 1000, runId: 'run-old' }));

      const { bureau } = createStubBureau();
      const trail = createAuditTrail(bureau, kv, undefined, { initialSequence: 1 });

      // Two overlapping calls, neither awaited before the other starts —
      // without serialization both could observe the same qualifying key
      // via `kv.list()` before either `kv.delete()` resolves, each
      // reporting `prunedCount: 1` for the SAME record.
      const [first, second] = await Promise.all([trail.prune(5000), trail.prune(5000)]);

      const totalPruned = (first?.prunedCount ?? 0) + (second?.prunedCount ?? 0);
      expect(totalPruned).toBe(1);

      trail.dispose();
    });

    it('still writes the pass\'s audit.pruned summary after the owner-issued signal aborts mid-pass, rather than silently swallowing it (Codex review, PR #597, "Finish the prune summary after shutdown begins")', async () => {
      const base = textValueStore(new MemoryStorage());
      await base.set(
        'audit:v1:0000000000001000:000000000000:run-old',
        JSON.stringify(makeRecord(0, { timestampMs: 1000, runId: 'run-old' })),
      );

      const controller = new AbortController();
      // Aborts the signal the instant the first delete happens — simulating
      // `shutdown()` beginning while this ALREADY-ADMITTED pass is still
      // running.
      const trackedKv: ReturnType<typeof textValueStore> = {
        ...base,
        async delete(key: string) {
          await base.delete(key);
          controller.abort();
        },
      };

      const { bureau } = createStubBureau();
      const trail = createAuditTrail(bureau, trackedKv, undefined, {
        initialSequence: 1,
        signal: controller.signal,
      });

      const result = await trail.prune(5000);
      expect(result?.prunedCount).toBe(1);

      // `query()` doesn't consult `signal`, so the summary record — written
      // through the abort-bypassing path — is still visible.
      const prunedRecords = await trail.query({ type: 'audit.pruned' });
      expect(prunedRecords).toHaveLength(1);

      trail.dispose();
    });

    it('propagates a failure to persist the audit.pruned summary rather than reporting success after permanently deleting records (Codex review, PR #597, "Propagate failures to persist the prune summary")', async () => {
      const base = textValueStore(new MemoryStorage());
      await base.set(
        'audit:v1:0000000000001000:000000000000:run-old',
        JSON.stringify(makeRecord(0, { timestampMs: 1000, runId: 'run-old' })),
      );
      const trackedKv: ReturnType<typeof textValueStore> = {
        ...base,
        async set(key: string, value: string) {
          // Only the pass's own out-of-band summary write targets the
          // synthetic `bureau:audit-retention` owner — the watermark key
          // and the seeded record's own key are unaffected, so this
          // isolates the summary write specifically.
          if (key.includes('bureau:audit-retention')) {
            throw new Error('backend rejected the summary write');
          }
          await base.set(key, value);
        },
      };

      const { bureau } = createStubBureau();
      const trail = createAuditTrail(bureau, trackedKv, undefined, { initialSequence: 1 });

      await expect(trail.prune(5000)).rejects.toThrow('backend rejected the summary write');

      // The deletion itself still happened — this is exactly why the
      // failure must propagate rather than be swallowed: the caller needs
      // to know evidence is missing for a mutation that already occurred.
      expect(await base.get('audit:v1:0000000000001000:000000000000:run-old')).toBeNull();

      trail.dispose();
    });
  });

  describe('AB-388 — eventTimestamp resolver (Codex review, PR #597, "Reuse event timestamps for dedicated lifecycle listeners")', () => {
    it('stamps a schedule.paused out-of-band record with the supplied eventTimestamp resolver reading for that event instance, not an independent clock read', async () => {
      const kv = textValueStore(new MemoryStorage());
      const { bureau, emit } = createStubBureau();
      const event = new SchedulePausedEvent('sched-1');
      const eventTimestamp = () => 424242;
      const trail = createAuditTrail(bureau, kv, undefined, { initialSequence: 0, eventTimestamp });

      emit(event);
      await yieldToPortableEventLoop();

      const records = await trail.query({ runId: 'schedule:sched-1' });
      expect(records).toHaveLength(1);
      expect(records[0]?.timestampMs).toBe(424242);

      trail.dispose();
    });

    it("stamps a session.deleted out-of-band record with the event's own committedAtMs (AB-389: the session outbox entry's authoritative commit time), not the eventTimestamp resolver", async () => {
      const kv = textValueStore(new MemoryStorage());
      const { bureau, emit } = createStubBureau();
      // `committedAtMs` (4th constructor arg) is the outbox entry's own
      // commit time — this event may be dispatched by a REPLAYED drain
      // long after that commit, so this listener reads `committedAtMs`
      // directly rather than the shared `eventTimestamp` resolver (which
      // would misdate it with a fresh clock read at dispatch time).
      const event = new SessionDeletedEvent('sess-1', 'incarnation-a', 1, 999_000);
      // A resolver that would return a DIFFERENT value proves it is never
      // consulted for this event.
      const eventTimestamp = () => 111_111;
      const trail = createAuditTrail(bureau, kv, undefined, { initialSequence: 0, eventTimestamp });

      emit(event);
      await yieldToPortableEventLoop();

      const records = await trail.query({ runId: 'session:sess-1' });
      expect(records).toHaveLength(1);
      expect(records[0]?.timestampMs).toBe(999_000);

      trail.dispose();
    });

    it('falls back to runtime.clock.now() when no eventTimestamp resolver is supplied, matching pre-AB-388 behavior', async () => {
      const kv = textValueStore(new MemoryStorage());
      const { bureau, emit } = createStubBureau();
      const runtime = createManualRuntimeServices();
      runtime.setTime(424_242);

      const trail = createAuditTrail(bureau, kv, undefined, { initialSequence: 0 }, runtime);
      emit(
        new AgentScheduledEvent({
          agentName: 'triage',
          scheduleId: 'sched-2',
          spec: { every: '5m' },
        }),
      );
      await yieldToPortableEventLoop();

      const records = await trail.query({ runId: 'schedule:sched-2' });
      expect(records).toHaveLength(1);
      expect(records[0]?.timestampMs).toBe(424_242);

      trail.dispose();
    });
  });

  describe('AB-388 — prune() protectRunId (Codex review, PR #597, "Protect earlier audit records for retained owners")', () => {
    it('never prunes a record whose runId protectRunId approves, even though its timestampMs is strictly before cutoffMs (key-only fast path)', async () => {
      const kv = textValueStore(new MemoryStorage());
      await seedRecord(kv, makeRecord(0, { timestampMs: 1000, runId: 'run-protected' }));
      await seedRecord(kv, makeRecord(1, { timestampMs: 1000, runId: 'run-unprotected' }));

      const { bureau } = createStubBureau();
      const trail = createAuditTrail(bureau, kv, undefined, { initialSequence: 2 });

      const result = await trail.prune(5000, {
        protectRunId: (runId) => runId === 'run-protected',
      });
      expect(result?.prunedCount).toBe(1);

      const protectedRecords = await trail.query({ runId: 'run-protected' });
      expect(protectedRecords).toHaveLength(1);
      const unprotectedRecords = await trail.query({ runId: 'run-unprotected' });
      expect(unprotectedRecords).toHaveLength(0);

      trail.dispose();
    });

    it('never prunes a protected runId on the slow decode-fallback path either (non-numeric sequence segment)', async () => {
      const kv = textValueStore(new MemoryStorage());
      const legacyKey = 'audit:v1:0000000000001000:not-a-number:run-protected';
      await kv.set(
        legacyKey,
        JSON.stringify(makeRecord(0, { timestampMs: 1000, runId: 'run-protected' })),
      );

      const { bureau } = createStubBureau();
      const trail = createAuditTrail(bureau, kv, undefined, { initialSequence: 1 });

      const result = await trail.prune(5000, {
        protectRunId: (runId) => runId === 'run-protected',
      });
      expect(result?.prunedCount).toBe(0);
      expect(await kv.get(legacyKey)).not.toBeNull();

      trail.dispose();
    });

    it('aborts the pass (rather than silently continuing) when the lease is overwritten with malformed JSON while this pass was running (Codex review, PR #597, "Abort pruning when lease renewal loses its CAS")', async () => {
      const base = textValueStore(new MemoryStorage());
      await seedRecord(base, makeRecord(0, { timestampMs: 1000, runId: 'run-old' }));
      let listCalls = 0;
      const trackedKv: ReturnType<typeof textValueStore> = {
        ...base,
        async list(prefix: string) {
          listCalls += 1;
          // Corrupts the lease this SAME pass already acquired, right as
          // the pass starts listing candidates — simulating a concurrent,
          // unrelated write (or storage corruption) to that key mid-pass.
          // `renewPruneLease` can no longer verify this pass still holds
          // the lease once this happens, so the renewal immediately
          // before the delete loop must report the lease lost and abort
          // the pass — never silently proceed as if nothing happened.
          if (listCalls === 1) {
            await base.set('audit-retention:v1:prune-lease', '{not json');
          }
          return base.list(prefix);
        },
      };

      const { bureau } = createStubBureau();
      const trail = createAuditTrail(bureau, trackedKv, undefined, { initialSequence: 1 });

      await expect(trail.prune(5000)).rejects.toThrow(
        'lost the prune lease before the delete phase',
      );

      // The abort happened before the delete loop started — nothing was
      // removed, and no summary was written.
      const records = await trail.query();
      expect(records).toHaveLength(1);
      const prunedRecords = await trail.query({ type: 'audit.pruned' });
      expect(prunedRecords).toHaveLength(0);

      trail.dispose();
    });
  });

  describe('AB-388 — record successful deletions when a later delete fails (Codex review, PR #597)', () => {
    it('writes a partial audit.pruned summary naming only the deletions that committed, then rethrows the delete failure', async () => {
      const base = textValueStore(new MemoryStorage());
      await seedRecord(base, makeRecord(0, { timestampMs: 1000, runId: 'run-a' }));
      await seedRecord(base, makeRecord(1, { timestampMs: 1000, runId: 'run-b' }));

      let deleteCount = 0;
      const trackedKv: ReturnType<typeof textValueStore> = {
        ...base,
        async delete(key: string) {
          deleteCount += 1;
          if (deleteCount === 2) {
            throw new Error('backend rejected the second delete');
          }
          await base.delete(key);
        },
      };

      const { bureau } = createStubBureau();
      const trail = createAuditTrail(bureau, trackedKv, undefined, { initialSequence: 2 });

      await expect(trail.prune(5000)).rejects.toThrow('backend rejected the second delete');

      const prunedRecords = await trail.query({ type: 'audit.pruned' });
      expect(prunedRecords).toHaveLength(1);
      expect(prunedRecords[0]?.detail).toEqual({ count: 1, cutoffMs: 5000, partial: true });

      trail.dispose();
    });
  });

  describe('AB-388 — coordinate pruning across shared-store instances (Codex review, PR #597)', () => {
    it('skips this pass entirely when another instance already holds a live prune lease on the shared kv', async () => {
      const kv = textValueStore(new MemoryStorage());
      await seedRecord(kv, makeRecord(0, { timestampMs: 1000, runId: 'run-old' }));
      // Simulates another Bureau process's instance currently holding the
      // lease — acquired "now", well inside the TTL.
      await kv.set(
        'audit-retention:v1:prune-lease',
        JSON.stringify({ acquiredAtMs: 1_700_000_000_000, token: 'other-instance-token' }),
      );

      const { bureau } = createStubBureau();
      const runtime = createManualRuntimeServices();
      runtime.setTime(1_700_000_100_000); // just inside the lease's TTL
      const trail = createAuditTrail(bureau, kv, undefined, { initialSequence: 1 }, runtime);

      const result = await trail.prune(5000);
      expect(result).toBeUndefined();

      // Nothing was touched — this pass never even started.
      const records = await trail.query();
      expect(records).toHaveLength(1);

      trail.dispose();
    });

    it('takes over a stale lease (older than the TTL) left behind by a crashed instance, rather than blocking forever', async () => {
      const kv = textValueStore(new MemoryStorage());
      await seedRecord(kv, makeRecord(0, { timestampMs: 1000, runId: 'run-old' }));
      // A lease acquired long enough ago to be past PRUNE_LEASE_TTL_MS —
      // simulating a holder that crashed before releasing it.
      await kv.set(
        'audit-retention:v1:prune-lease',
        JSON.stringify({ acquiredAtMs: 1, token: 'crashed-instance-token' }),
      );

      const { bureau } = createStubBureau();
      const runtime = createManualRuntimeServices();
      runtime.setTime(1_700_000_000_000); // well past PRUNE_LEASE_TTL_MS after acquiredAtMs: 1
      const trail = createAuditTrail(bureau, kv, undefined, { initialSequence: 1 }, runtime);

      const result = await trail.prune(5000);
      expect(result?.prunedCount).toBe(1);

      trail.dispose();
    });

    it('treats a malformed (corrupt JSON) lease value as absent rather than blocking forever', async () => {
      const kv = textValueStore(new MemoryStorage());
      await seedRecord(kv, makeRecord(0, { timestampMs: 1000, runId: 'run-old' }));
      await kv.set('audit-retention:v1:prune-lease', '{not json');

      const { bureau } = createStubBureau();
      const trail = createAuditTrail(bureau, kv, undefined, { initialSequence: 1 });

      const result = await trail.prune(5000);
      expect(result?.prunedCount).toBe(1);

      trail.dispose();
    });

    it('releases its own lease after a pass completes, so an immediately following pass is not blocked', async () => {
      const kv = textValueStore(new MemoryStorage());
      await seedRecord(kv, makeRecord(0, { timestampMs: 1000, runId: 'run-old-1' }));

      const { bureau } = createStubBureau();
      const trail = createAuditTrail(bureau, kv, undefined, { initialSequence: 1 });

      const first = await trail.prune(5000);
      expect(first?.prunedCount).toBe(1);
      expect(await kv.get('audit-retention:v1:prune-lease')).toBeNull();

      await seedRecord(kv, makeRecord(1, { timestampMs: 1000, runId: 'run-old-2' }));
      const second = await trail.prune(5000);
      expect(second?.prunedCount).toBe(1);

      trail.dispose();
    });

    it('renews its own lease periodically during a large delete loop (every 200 deletions), rather than letting it age toward the TTL untouched', async () => {
      const kv = textValueStore(new MemoryStorage());
      const seedCount = 401; // crosses the 200-deletion renewal boundary twice
      for (let i = 0; i < seedCount; i += 1) {
        await seedRecord(kv, makeRecord(i, { timestampMs: 1000, runId: `run-old-${i}` }));
      }

      let renewCount = 0;
      const trackedKv: ReturnType<typeof textValueStore> = {
        ...kv,
        async conditionalBatch(conditions, operations) {
          const isLeaseRenewal = operations.some(
            (op) => op.type === 'set' && op.key === 'audit-retention:v1:prune-lease',
          );
          if (isLeaseRenewal) renewCount += 1;
          return kv.conditionalBatch(conditions, operations);
        },
      };

      const { bureau } = createStubBureau();
      const trail = createAuditTrail(bureau, trackedKv, undefined, { initialSequence: seedCount });

      const result = await trail.prune(5000);
      expect(result?.prunedCount).toBe(seedCount);
      // One `conditionalBatch` set for the initial acquisition, one for
      // the renewal right before the delete loop starts, and two periodic
      // renewals (after the 200th and 400th deletions) — the release at
      // the end is a `delete` operation, not counted here.
      expect(renewCount).toBe(4);

      trail.dispose();
    });

    it('aborts before deleting anything when lease renewal loses its CAS right before the delete loop starts (Codex review, PR #597, "Abort pruning when lease renewal loses its CAS")', async () => {
      const kv = textValueStore(new MemoryStorage());
      await seedRecord(kv, makeRecord(0, { timestampMs: 1000, runId: 'run-old-1' }));
      await seedRecord(kv, makeRecord(1, { timestampMs: 1000, runId: 'run-old-2' }));

      let callIndex = 0;
      const trackedKv: ReturnType<typeof textValueStore> = {
        ...kv,
        async conditionalBatch(conditions, operations) {
          callIndex += 1;
          const isLeaseSet = operations.some(
            (op) => op.type === 'set' && op.key === 'audit-retention:v1:prune-lease',
          );
          // Call 1 is this pass's own acquisition (must succeed for the
          // pass to reach the delete loop at all); call 2 is the renewal
          // immediately before the delete loop, simulated here as having
          // lost its CAS to a concurrent takeover.
          if (isLeaseSet && callIndex === 2) return false;
          return kv.conditionalBatch(conditions, operations);
        },
      };

      const { bureau } = createStubBureau();
      const trail = createAuditTrail(bureau, trackedKv, undefined, { initialSequence: 1 });

      await expect(trail.prune(5000)).rejects.toThrow(
        'lost the prune lease before the delete phase',
      );

      // Nothing was deleted — the abort happened before the delete loop
      // ever started.
      const records = await trail.query();
      expect(records).toHaveLength(2);

      // No `audit.pruned` summary either — this pass never removed
      // anything to account for.
      const prunedRecords = await trail.query({ type: 'audit.pruned' });
      expect(prunedRecords).toHaveLength(0);

      trail.dispose();
    });

    it('stops deleting mid-pass when a periodic lease renewal loses its CAS, but still writes a partial summary for what it already deleted (Codex review, PR #597, "Abort pruning when lease renewal loses its CAS")', async () => {
      const kv = textValueStore(new MemoryStorage());
      const seedCount = 200; // exactly one periodic renewal boundary
      for (let i = 0; i < seedCount; i += 1) {
        await seedRecord(kv, makeRecord(i, { timestampMs: 1000, runId: `run-old-${i}` }));
      }

      let callIndex = 0;
      const trackedKv: ReturnType<typeof textValueStore> = {
        ...kv,
        async conditionalBatch(conditions, operations) {
          callIndex += 1;
          const isLeaseSet = operations.some(
            (op) => op.type === 'set' && op.key === 'audit-retention:v1:prune-lease',
          );
          // Call 1: acquisition. Call 2: renewal before the delete loop.
          // Call 3: the first periodic renewal, after the 200th deletion —
          // simulated here as having lost its CAS.
          if (isLeaseSet && callIndex === 3) return false;
          return kv.conditionalBatch(conditions, operations);
        },
      };

      const { bureau } = createStubBureau();
      const trail = createAuditTrail(bureau, trackedKv, undefined, { initialSequence: seedCount });

      await expect(trail.prune(5000)).rejects.toThrow('lost the prune lease mid-delete');

      // All 200 candidates that were deleted BEFORE the failed renewal
      // check stay deleted — the abort only stops FURTHER deletes. The
      // only record left is the pass's own `audit.pruned` summary.
      const records = await trail.query();
      expect(records.filter((record) => record.type !== 'audit.pruned')).toHaveLength(0);

      const prunedRecords = await trail.query({ type: 'audit.pruned' });
      expect(prunedRecords).toHaveLength(1);
      expect(prunedRecords[0]?.detail).toEqual({ count: seedCount, cutoffMs: 5000, partial: true });

      trail.dispose();
    });
  });

  describe('AB-388 — commit deletion summaries atomically with deletions (Codex review, PR #597)', () => {
    it('writes the prune-intent record before deleting, and clears it only after the summary lands', async () => {
      const base = textValueStore(new MemoryStorage());
      await seedRecord(base, makeRecord(0, { timestampMs: 1000, runId: 'run-old' }));

      const operationLog: string[] = [];
      const trackedKv: ReturnType<typeof textValueStore> = {
        ...base,
        async set(key: string, value: string) {
          operationLog.push(`set:${key}`);
          await base.set(key, value);
        },
        async delete(key: string) {
          operationLog.push(`delete:${key}`);
          await base.delete(key);
        },
      };

      const { bureau } = createStubBureau();
      const trail = createAuditTrail(bureau, trackedKv, undefined, { initialSequence: 1 });

      await trail.prune(5000);

      const intentSetIndex = operationLog.findIndex(
        (entry) => entry === 'set:audit-retention:v1:prune-intent',
      );
      const recordDeleteIndex = operationLog.findIndex(
        (entry) => entry === 'delete:audit:v1:0000000000001000:000000000000:run-old',
      );
      const intentClearIndex = operationLog.findIndex(
        (entry) => entry === 'delete:audit-retention:v1:prune-intent',
      );
      expect(intentSetIndex).toBeGreaterThanOrEqual(0);
      expect(recordDeleteIndex).toBeGreaterThan(intentSetIndex);
      expect(intentClearIndex).toBeGreaterThan(recordDeleteIndex);

      // The intent is gone once the pass completes normally.
      expect(await base.get('audit-retention:v1:prune-intent')).toBeNull();

      trail.dispose();
    });

    it('recovers a missed audit.pruned summary from a leftover intent record on the NEXT pass (Codex review, PR #597, "Commit deletion summaries atomically with deletions")', async () => {
      const kv = textValueStore(new MemoryStorage());
      // Simulates a PRIOR pass that deleted 3 records under cutoff 4000
      // and then crashed before its own summary write ever ran — the
      // records are already gone (nothing here re-seeds them), but the
      // intent it wrote right before deleting survived.
      await kv.set('audit-retention:v1:prune-intent', JSON.stringify({ count: 3, cutoffMs: 4000 }));

      // A fresh record for THIS pass to prune normally, proving recovery
      // does not interfere with the pass's own ordinary work.
      await seedRecord(kv, makeRecord(0, { timestampMs: 1000, runId: 'run-new' }));

      const { bureau } = createStubBureau();
      const trail = createAuditTrail(bureau, kv, undefined, { initialSequence: 1 });

      const result = await trail.prune(9000);
      expect(result?.prunedCount).toBe(1);

      const prunedRecords = await trail.query({ type: 'audit.pruned' });
      expect(prunedRecords).toHaveLength(2);
      expect(prunedRecords.map((record) => record.detail)).toEqual([
        { count: 3, cutoffMs: 4000, recovered: true },
        { count: 1, cutoffMs: 9000 },
      ]);

      // The leftover intent is gone — it was reconciled by this pass.
      expect(await kv.get('audit-retention:v1:prune-intent')).toBeNull();

      trail.dispose();
    });

    it('never emits a duplicate recovered summary when the intent changes between being read and the atomic write that reconciles it (Codex review, PR #597, "Make prune-summary recovery idempotent")', async () => {
      const base = textValueStore(new MemoryStorage());
      await base.set(
        'audit-retention:v1:prune-intent',
        JSON.stringify({ count: 3, cutoffMs: 4000 }),
      );
      await seedRecord(base, makeRecord(0, { timestampMs: 1000, runId: 'run-new' }));

      let racedOnce = false;
      const trackedKv: ReturnType<typeof textValueStore> = {
        ...base,
        async conditionalBatch(conditions, operations) {
          const targetsIntent = conditions.some(
            (condition) => condition.key === 'audit-retention:v1:prune-intent',
          );
          if (targetsIntent && !racedOnce) {
            racedOnce = true;
            // Simulates a concurrent writer changing the intent's stored
            // value between THIS call's own earlier `kv.get` and its
            // `conditionalBatch` here — the CAS precondition below no
            // longer matches the current value, so the real
            // `conditionalBatch` call must fail and reconcile nothing.
            await base.set(
              'audit-retention:v1:prune-intent',
              JSON.stringify({ count: 3, cutoffMs: 4000, racedBy: 'someone-else' }),
            );
          }
          return base.conditionalBatch(conditions, operations);
        },
      };

      const { bureau } = createStubBureau();
      const trail = createAuditTrail(bureau, trackedKv, undefined, { initialSequence: 1 });

      const result = await trail.prune(9000);
      expect(result?.prunedCount).toBe(1);

      // The reconciliation's own CAS lost the race, so it emitted NOTHING
      // for the stale intent — only this pass's own normal summary exists.
      const prunedRecords = await trail.query({ type: 'audit.pruned' });
      expect(prunedRecords).toHaveLength(1);
      expect(prunedRecords[0]?.detail).toEqual({ count: 1, cutoffMs: 9000 });

      trail.dispose();
    });

    it('discards a leftover intent record that is valid JSON but the wrong shape, rather than blocking every future pass forever', async () => {
      const kv = textValueStore(new MemoryStorage());
      // Valid JSON, but missing `count`/`cutoffMs` — not a
      // `PruneIntentValue`, distinct from the "invalid JSON" case below.
      await kv.set('audit-retention:v1:prune-intent', JSON.stringify({ unrelated: true }));
      await seedRecord(kv, makeRecord(0, { timestampMs: 1000, runId: 'run-new' }));

      const { bureau } = createStubBureau();
      const trail = createAuditTrail(bureau, kv, undefined, { initialSequence: 1 });

      const result = await trail.prune(5000);
      expect(result?.prunedCount).toBe(1);

      const prunedRecords = await trail.query({ type: 'audit.pruned' });
      expect(prunedRecords).toHaveLength(1);
      expect(prunedRecords[0]?.detail).toEqual({ count: 1, cutoffMs: 5000 });
      expect(await kv.get('audit-retention:v1:prune-intent')).toBeNull();

      trail.dispose();
    });

    it('discards a malformed leftover intent record rather than blocking every future pass forever', async () => {
      const kv = textValueStore(new MemoryStorage());
      await kv.set('audit-retention:v1:prune-intent', '{not json');
      await seedRecord(kv, makeRecord(0, { timestampMs: 1000, runId: 'run-new' }));

      const { bureau } = createStubBureau();
      const trail = createAuditTrail(bureau, kv, undefined, { initialSequence: 1 });

      const result = await trail.prune(5000);
      expect(result?.prunedCount).toBe(1);

      // No recovered summary — the malformed intent carried nothing
      // recoverable, so only the normal pass's own summary exists.
      const prunedRecords = await trail.query({ type: 'audit.pruned' });
      expect(prunedRecords).toHaveLength(1);
      expect(prunedRecords[0]?.detail).toEqual({ count: 1, cutoffMs: 5000 });
      expect(await kv.get('audit-retention:v1:prune-intent')).toBeNull();

      trail.dispose();
    });
  });
});
