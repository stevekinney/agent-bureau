import { beforeEach, describe, expect, it } from 'bun:test';
import { createManualRuntimeServices } from 'lifecycle';
import { z } from 'zod';

import { createTool } from '../../src/create-tool';
import { createToolResultCache } from '../../src/idempotency/create-tool-result-cache';
import { fullInputKey } from '../../src/idempotency/key-generators';
import type { ToolResultCache } from '../../src/idempotency/types';
import { withIdempotency } from '../../src/idempotency/with-idempotency';

const requestContext = {
  runId: 'run-a',
  agentId: 'agent-a',
  authority: {
    tenantId: 'tenant-a',
    principalId: 'principal-a',
    ownerId: 'owner-a',
    capabilities: ['tools:execute'],
    authorizationRevision: 'authorization:1',
  },
} as const;

function createTestStore() {
  const map = new Map<string, string>();
  return {
    get: async (key: string) => map.get(key) ?? null,
    set: async (key: string, value: string) => {
      map.set(key, value);
    },
    delete: async (key: string) => {
      map.delete(key);
    },
    list: async (prefix: string) => [...map.keys()].filter((key) => key.startsWith(prefix)).sort(),
  };
}

function createDeferred<T>() {
  let deferredResolve!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    deferredResolve = resolve;
  });
  return { promise, resolve: deferredResolve };
}

/**
 * Polls a microtask-only predicate to completion, capped so a regression
 * that never satisfies it fails the test fast instead of hanging CI in an
 * unbounded busy-wait loop.
 */
async function waitUntil(predicate: () => boolean, description: string): Promise<void> {
  const maximumAttempts = 1_000;
  for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error(`waitUntil timed out after ${maximumAttempts} microtask ticks: ${description}`);
}

/**
 * AB-328: brought under the determinism gate. The deadline-cancel timer
 * (scheduleBoundedTimeout's `stopRenewal` callback in with-idempotency.ts)
 * only stops lease renewal — it does not abort the in-flight
 * `tool.executeWith(...)` call, so the outer `execute()` promise settles
 * only once the tool's own promise settles. Driving this deterministically
 * means releasing a manually-controlled deferred (standing in for the
 * tool's slow work) only *after* `ManualRuntimeServices.advance` has fired
 * the renewal and deadline timers, matching the production ordering: the
 * deadline elapses while the tool is still running, then the tool finishes,
 * then completion is fenced against the deadline that already passed.
 */
describe('withIdempotency: deadline-fenced completion (manual runtime)', () => {
  let cache: ToolResultCache;

  beforeEach(() => {
    // A constant `now` — not tied to any single test's manual runtime, since
    // this cache is shared across tests that each construct their own
    // runtime — keeps the cache's own TTL bookkeeping (`isExpired`,
    // `expiresAt`) off the real clock too. None of these tests exercises
    // TTL expiration, so the exact value is never asserted on.
    cache = createToolResultCache({
      store: createTestStore(),
      defaultTTL: 60_000,
      now: () => 0,
    });
  });

  it('stops renewing at the absolute deadline and fences completion after it', async () => {
    const runtime = createManualRuntimeServices();
    const deferred = createDeferred<number>();
    const slowTool = createTool({
      name: 'deadline-fence-manual',
      description: 'Slow direct idempotency execution driven by a manual runtime',
      version: '1.0.0',
      input: z.object({ value: z.number() }),
      idempotencyKey: (input: unknown) => fullInputKey(input),
      async execute({ value }) {
        await deferred.promise;
        return value;
      },
    });

    const deadlineTool = withIdempotency(slowTool, {
      cache,
      tenantId: 'tenant-a',
      leaseDurationMs: 4,
      maximumExecutionDurationMs: 5,
      runtime,
    });

    const deadlineExecution = deadlineTool.execute({ value: 9 }, { requestContext });

    // Let admission and the initial lease renewal settle, then wait for the
    // renewal and deadline-cancel timers to register on the manual runtime's
    // own bookkeeping — never a real timer, never a wall-clock sleep.
    await waitUntil(
      () => runtime.pendingTimers().length > 0,
      'lease-renewal and deadline-cancel timers armed on the manual runtime',
    );

    // Advance past both the renewal interval (2ms) and the absolute
    // deadline (5ms) while the tool's promise is still unresolved — this is
    // the ordering the deadline-cancel timer cannot itself enforce: it only
    // stops renewal, it never aborts the in-flight execute.
    await runtime.advance(5);

    // Only now does the tool's own work "complete" — after the deadline has
    // already elapsed on the manual clock, so completion fencing rejects it.
    deferred.resolve(9);

    await expect(deadlineExecution).rejects.toThrow('lost its execution fence');

    let renewalCalls = 0;
    const rejectingRenewalCache: ToolResultCache = {
      ...cache,
      async renewStarted() {
        renewalCalls += 1;
        if (renewalCalls === 1) return true;
        throw new Error('renewal store unavailable');
      },
    };
    const renewalRuntime = createManualRuntimeServices();
    const renewalDeferred = createDeferred<number>();
    const renewalFailureTool = withIdempotency(
      createTool({
        name: 'renewal-failure-manual',
        description: 'Slow direct idempotency execution driven by a manual runtime',
        version: '1.0.0',
        input: z.object({ value: z.number() }),
        idempotencyKey: (input: unknown) => fullInputKey(input),
        async execute({ value }) {
          await renewalDeferred.promise;
          return value;
        },
      }),
      {
        cache: rejectingRenewalCache,
        tenantId: 'tenant-a',
        leaseDurationMs: 4,
        maximumExecutionDurationMs: 100,
        runtime: renewalRuntime,
      },
    );

    const renewalFailureExecution = renewalFailureTool.execute({ value: 10 }, { requestContext });

    await waitUntil(
      () => renewalRuntime.pendingTimers().length > 0,
      'lease-renewal timer armed on the manual runtime',
    );

    // Advance past the renewal interval so the mock's second call — the one
    // that throws — actually runs before the tool's work "completes".
    await renewalRuntime.advance(2);
    await waitUntil(() => renewalCalls >= 2, 'second renewStarted call to have run and thrown');

    renewalDeferred.resolve(10);

    await expect(renewalFailureExecution).rejects.toThrow('lost its execution fence');
  });

  it('stops a scheduled renewal that observes the deadline through its own clock read', async () => {
    // The deadline-CANCEL timer (above) and the scheduled renewal's own
    // inline deadline check are two separate code paths that both call
    // stopRenewal(). A single unified manual clock driving both the timers
    // and every now() read can only ever exercise the cancel timer first —
    // the renewal timer fires at a strictly earlier virtual instant, so its
    // own now() read is always still before the deadline. Reaching the
    // renewal's own check requires a `now` deliberately decoupled from the
    // runtime clock driving the timers (exactly the scenario the deadline
    // has already elapsed by wall time the caller tracks separately from
    // this wrapper's timer clock), which is why this composes a manual
    // runtime (for deterministic timer scheduling) with an independently
    // crafted `now` sequence, rather than reusing `runtime.clock.now`.
    const runtime = createManualRuntimeServices();
    const deferred = createDeferred<number>();
    const slowTool = createTool({
      name: 'deadline-fence-inline-check',
      description: 'Slow direct idempotency execution driven by a manual runtime',
      version: '1.0.0',
      input: z.object({ value: z.number() }),
      idempotencyKey: (input: unknown) => fullInputKey(input),
      async execute({ value }) {
        await deferred.promise;
        return value;
      },
    });

    let clockReads = 0;
    const wrapped = withIdempotency(slowTool, {
      cache,
      tenantId: 'tenant-a',
      leaseDurationMs: 4,
      // A generous deadline on the runtime's own timer clock keeps the
      // deadline-cancel timer from firing before the scheduled renewal
      // does — the renewal's own now() read, not the cancel timer, is what
      // this test exercises.
      maximumExecutionDurationMs: 100,
      runtime,
      now: () => [0, 0, 1_000][clockReads++] ?? 1_000,
    });

    const execution = wrapped.execute({ value: 9 }, { requestContext });

    await waitUntil(
      () => runtime.pendingTimers().length > 0,
      'lease-renewal timer armed on the manual runtime',
    );
    // Fires only the scheduled renewal (2ms) — the deadline-cancel timer
    // (100ms) stays armed, so cancellation never runs.
    await runtime.advance(2);

    deferred.resolve(9);

    await expect(execution).rejects.toThrow('lost its execution fence');
  });
});
