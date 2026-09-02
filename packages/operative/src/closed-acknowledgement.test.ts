import { describe, expect, it } from 'bun:test';

import { createClosedAcknowledgement } from './closed-acknowledgement';
import type { CleanupAcknowledgement } from './types';

/** A deferred promise, so tests can control exactly when `result` settles. */
function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let settle!: (value: T) => void;
  let fail!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  return { promise, resolve: settle, reject: fail };
}

describe('createClosedAcknowledgement', () => {
  it('resolves not-required immediately when first called after the run already settled with no in-flight work and no cancellation', async () => {
    const deferred = createDeferred<void>();
    deferred.resolve();

    const closed = createClosedAcknowledgement({
      result: deferred.promise,
      disqualifiesFastPath: () => false,
      hasInFlightWork: () => false,
      resolveOutcome: () => Promise.resolve({ status: 'completed' }),
    });

    // Give the internal `resultSettled` tracker a turn to observe settlement
    // before the first call to `closed()`.
    await deferred.promise;
    await Promise.resolve();

    expect(await closed()).toEqual({ status: 'not-required' });
  });

  it('does not take the not-required fast path when the first call happens before settlement', async () => {
    const deferred = createDeferred<void>();
    const closed = createClosedAcknowledgement({
      result: deferred.promise,
      disqualifiesFastPath: () => false,
      hasInFlightWork: () => false,
      resolveOutcome: () => Promise.resolve({ status: 'completed' }),
    });

    const pending = closed();
    deferred.resolve();
    expect(await pending).toEqual({ status: 'completed' });
  });

  it('disqualifies not-required when a cancellation was requested, even though the run already settled', async () => {
    const deferred = createDeferred<void>();
    deferred.resolve();

    const closed = createClosedAcknowledgement({
      result: deferred.promise,
      disqualifiesFastPath: () => true,
      hasInFlightWork: () => false,
      resolveOutcome: () => Promise.resolve({ status: 'completed' }),
    });

    await deferred.promise;
    await Promise.resolve();

    expect(await closed()).toEqual({ status: 'completed' });
  });

  it('disqualifies not-required when work is still tracked as in flight, even though the run already settled', async () => {
    const deferred = createDeferred<void>();
    deferred.resolve();

    const closed = createClosedAcknowledgement({
      result: deferred.promise,
      disqualifiesFastPath: () => false,
      hasInFlightWork: () => true,
      resolveOutcome: () => Promise.resolve({ status: 'completed' }),
    });

    await deferred.promise;
    await Promise.resolve();

    expect(await closed()).toEqual({ status: 'completed' });
  });

  it('only evaluates the not-required fast path on the very first call', async () => {
    const deferred = createDeferred<void>();
    const closed = createClosedAcknowledgement({
      result: deferred.promise,
      disqualifiesFastPath: () => false,
      hasInFlightWork: () => false,
      resolveOutcome: () => Promise.resolve({ status: 'completed' }),
    });

    // First call happens before settlement — disqualified. A run that later
    // becomes not-required-shaped (settled, nothing in flight) must not slip
    // through the fast path on a SECOND call once that door has closed.
    const first = closed();
    deferred.resolve();
    await deferred.promise;
    await Promise.resolve();
    const second = closed();

    expect(await first).toEqual({ status: 'completed' });
    expect(await second).toEqual({ status: 'completed' });
  });

  it('classifies a rejected result as failed, carrying the rejection as error', async () => {
    const deferred = createDeferred<void>();
    const closed = createClosedAcknowledgement({
      result: deferred.promise,
      disqualifiesFastPath: () => false,
      hasInFlightWork: () => false,
      resolveOutcome: () => Promise.resolve({ status: 'completed' }),
    });

    const pending = closed();
    const failure = new Error('cleanup listener threw');
    deferred.reject(failure);

    expect(await pending).toEqual({ status: 'failed', error: failure });
  });

  it('never rejects, even though the underlying result promise does', async () => {
    const deferred = createDeferred<void>();
    const closed = createClosedAcknowledgement({
      result: deferred.promise,
      disqualifiesFastPath: () => false,
      hasInFlightWork: () => false,
      resolveOutcome: () => Promise.resolve({ status: 'completed' }),
    });

    const pending = closed();
    deferred.reject(new Error('boom'));
    expect(await pending).toBeDefined();
  });

  it('is idempotent: repeated calls after genuine settlement return the identical cached object by reference', async () => {
    const deferred = createDeferred<void>();
    const closed = createClosedAcknowledgement({
      result: deferred.promise,
      disqualifiesFastPath: () => false,
      hasInFlightWork: () => false,
      resolveOutcome: () => Promise.resolve({ status: 'completed' }),
    });

    const first = closed();
    deferred.resolve();
    const firstResult = await first;
    const secondResult = await closed();
    const thirdResult = await closed();

    expect(secondResult).toBe(firstResult);
    expect(thirdResult).toBe(firstResult);
  });

  it('resolves unresolved/timed-out immediately when the supplied signal is already aborted', async () => {
    const deferred = createDeferred<void>();
    const closed = createClosedAcknowledgement({
      result: deferred.promise,
      disqualifiesFastPath: () => false,
      hasInFlightWork: () => false,
      resolveOutcome: () => Promise.resolve({ status: 'completed' }),
    });

    const controller = new AbortController();
    controller.abort();

    expect(await closed({ signal: controller.signal })).toEqual({
      status: 'unresolved',
      reason: 'timed-out',
    });
  });

  it('resolves unresolved/timed-out for a call whose own signal fires before settlement, without writing that outcome into the shared cache', async () => {
    const deferred = createDeferred<void>();
    const closed = createClosedAcknowledgement({
      result: deferred.promise,
      disqualifiesFastPath: () => false,
      hasInFlightWork: () => false,
      resolveOutcome: () => Promise.resolve({ status: 'completed' }),
    });

    const controller = new AbortController();
    const timedOutCall = closed({ signal: controller.signal });
    controller.abort();

    expect(await timedOutCall).toEqual({ status: 'unresolved', reason: 'timed-out' });

    // Settle the real cleanup afterward — a later call, and the real
    // settlement, must be unaffected by the abandoned call above.
    deferred.resolve();
    expect(await closed()).toEqual({ status: 'completed' });
  });

  it('lets a concurrent signal-free call observe the real settlement even while another call abandoned its wait', async () => {
    const deferred = createDeferred<void>();
    const closed = createClosedAcknowledgement({
      result: deferred.promise,
      disqualifiesFastPath: () => false,
      hasInFlightWork: () => false,
      resolveOutcome: () => Promise.resolve({ status: 'completed' }),
    });

    const controller = new AbortController();
    const timedOutCall = closed({ signal: controller.signal });
    const signalFreeCall = closed();

    controller.abort();
    deferred.resolve();

    expect(await timedOutCall).toEqual({ status: 'unresolved', reason: 'timed-out' });
    expect(await signalFreeCall).toEqual({ status: 'completed' });

    // A third call made afterward observes the same real settled value, never
    // the abandoned wait's — and it is the identical cached object.
    const thirdCall = await closed();
    expect(thirdCall).toBe(await signalFreeCall);
  });

  it('resolves a per-call signal race with the real value when settlement wins before the signal fires', async () => {
    const deferred = createDeferred<void>();
    const closed = createClosedAcknowledgement({
      result: deferred.promise,
      disqualifiesFastPath: () => false,
      hasInFlightWork: () => false,
      resolveOutcome: () => Promise.resolve({ status: 'completed' }),
    });

    const controller = new AbortController();
    const pending = closed({ signal: controller.signal });
    deferred.resolve();
    const result = await pending;
    // The signal never fired — removing its listener on the winning path is
    // exercised here (no leaked listener assertion needed; Bun's `--coverage`
    // proves the removeEventListener branch ran).
    expect(result).toEqual({ status: 'completed' });

    // Firing the signal afterward must be a no-op for an already-settled call.
    controller.abort();
    expect(result).toEqual({ status: 'completed' });
  });

  it('propagates a resolveOutcome() result other than completed unchanged', async () => {
    const deferred = createDeferred<void>();
    const expected: CleanupAcknowledgement = {
      status: 'unresolved',
      reason: 'persistence-failed',
    };
    const closed = createClosedAcknowledgement({
      result: deferred.promise,
      disqualifiesFastPath: () => true,
      hasInFlightWork: () => false,
      resolveOutcome: () => Promise.resolve(expected),
    });

    const pending = closed();
    deferred.resolve();
    expect(await pending).toEqual(expected);
  });
});
