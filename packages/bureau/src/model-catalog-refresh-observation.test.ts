import type { BackendDescriptor } from '@lostgradient/operative';
import { describe, expect, it, spyOn } from 'bun:test';
import { createModelCatalogService } from './model-catalog-refresh';

import { createService, deferred, descriptor, request } from './model-catalog-refresh-test-helpers';

describe('createModelCatalogService', () => {
  it('subscribeSnapshot delivers the current state before registration returns, and terminal state to a late subscriber', async () => {
    const source = deferred<readonly BackendDescriptor[]>();
    const { service } = createService(() => source.promise);
    const handle = service.refresh(request());

    const deliveries: string[] = [];
    handle.subscribeSnapshot((snapshot) => {
      deliveries.push(snapshot.status);
    });
    // Delivered synchronously, before any await.
    expect(deliveries).toEqual(['pending']);

    source.resolve([]);
    await handle.result();
    expect(deliveries).toEqual(['pending', 'settled']);

    const lateDeliveries: string[] = [];
    handle.subscribeSnapshot((snapshot) => {
      lateDeliveries.push(snapshot.status);
    });
    expect(lateDeliveries).toEqual(['settled']);
  });

  it('subscribeSnapshot revision is monotonic across the pending-to-settled transition', async () => {
    const { service } = createService(() => Promise.resolve([]));
    const handle = service.refresh(request());
    const pendingRevision = handle.snapshot().revision;
    await handle.result();
    expect(handle.snapshot().revision).toBeGreaterThan(pendingRevision);
  });

  it('disposing one observation does not end the underlying refresh', async () => {
    const source = deferred<readonly BackendDescriptor[]>();
    const { service } = createService(() => source.promise);
    const handle = service.refresh(request());

    const deliveries: string[] = [];
    const unsubscribe = handle.subscribeSnapshot((snapshot) => deliveries.push(snapshot.status));
    unsubscribe();

    source.resolve([descriptor('anthropic', 'still-committed')]);
    const result = await handle.result();

    expect(result.outcome).toBe('completed');
    expect(deliveries).toEqual(['pending']); // no further delivery after unsubscribe
    expect(service.catalog().descriptors.some((d) => d.model === 'still-committed')).toBe(true);
  });

  it('one observer throwing does not stop delivery to another observer', async () => {
    const { service } = createService(() => Promise.resolve([]));
    const handle = service.refresh(request());

    const secondObserverDeliveries: string[] = [];
    handle.subscribeSnapshot(() => {
      throw new Error('observer bug');
    });
    handle.subscribeSnapshot((snapshot) => secondObserverDeliveries.push(snapshot.status));

    await handle.result();
    expect(secondObserverDeliveries).toEqual(['pending', 'settled']);
  });

  it('two subscriptions with the SAME observer function are independently disposable', async () => {
    const { service } = createService(() => Promise.resolve([]));
    const handle = service.refresh(request());

    const deliveries: string[] = [];
    const sharedObserver = (snapshot: { status: string }): void => {
      deliveries.push(snapshot.status);
    };
    const unsubscribeFirst = handle.subscribeSnapshot(sharedObserver);
    handle.subscribeSnapshot(sharedObserver);
    // Two registrations delivered the pending state independently.
    expect(deliveries).toEqual(['pending', 'pending']);

    unsubscribeFirst();
    await handle.result();
    // Only the SECOND registration is still active — one terminal delivery,
    // not zero (both collapsed) and not two (unsubscribe removed neither).
    expect(deliveries).toEqual(['pending', 'pending', 'settled']);
  });

  it('abort() on a coalesced second handle aborts the shared in-flight work', async () => {
    let observedSignal: AbortSignal | undefined;
    const source = deferred<readonly BackendDescriptor[]>();
    const { service } = createService((_req, signal) => {
      observedSignal = signal;
      return source.promise;
    });

    const first = service.refresh(request('req-1'));
    const second = service.refresh(request('req-2'));
    second.abort('second caller cancelled');

    const result = await first.result();
    expect(result.outcome).toBe('failed');
    expect(observedSignal?.aborted).toBe(true);
  });

  it('reports a synchronous, non-thenable handle from refresh()', () => {
    const { service } = createService(() => Promise.resolve([]));
    const handle = service.refresh(request());
    expect('then' in handle).toBe(false);
    expect(typeof handle.refreshId).toBe('string');
  });

  it('stringifies a non-Error rejection into the failureReason', async () => {
    // Deliberately a non-Error rejection: this test exists to cover
    // describeFailure()'s String(cause) branch for a scripted
    // descriptorSource that misbehaves by rejecting with a plain value.
    const { service } = createService(() => Promise.reject('a plain string rejection'));
    const handle = service.refresh(request());
    const result = await handle.result();
    expect(result.outcome).toBe('failed');
    expect(result.failureReason).toContain('a plain string rejection');
  });

  it('unsubscribe() removes its AbortSignal listener rather than leaking it', async () => {
    const { service } = createService(() => Promise.resolve([]));
    const handle = service.refresh(request());
    const controller = new AbortController();
    const removeEventListenerSpy = spyOn(controller.signal, 'removeEventListener');

    const unsubscribe = handle.subscribeSnapshot(() => {}, { signal: controller.signal });
    unsubscribe();

    expect(removeEventListenerSpy).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('subscribeSnapshot auto-unsubscribes when a live signal aborts later', async () => {
    const source = deferred<readonly BackendDescriptor[]>();
    const { service } = createService(() => source.promise);
    const handle = service.refresh(request());
    const controller = new AbortController();

    const deliveries: string[] = [];
    handle.subscribeSnapshot((snapshot) => deliveries.push(snapshot.status), {
      signal: controller.signal,
    });
    expect(deliveries).toEqual(['pending']);

    controller.abort();
    source.resolve([]);
    await handle.result();

    // Aborting the signal unsubscribed before settlement notified observers.
    expect(deliveries).toEqual(['pending']);
  });

  it('subscribeSnapshot with an already-aborted signal registers and immediately unsubscribes without delivering further updates', async () => {
    const controller = new AbortController();
    controller.abort();
    const { service } = createService(() => Promise.resolve([]));
    const handle = service.refresh(request());

    const deliveries: string[] = [];
    handle.subscribeSnapshot((snapshot) => deliveries.push(snapshot.status), {
      signal: controller.signal,
    });
    // The synchronous initial delivery still happens...
    expect(deliveries).toEqual(['pending']);
    await handle.result();
    // ...but the already-aborted signal meant no further delivery.
    expect(deliveries).toEqual(['pending']);
  });

  it('inFlightRefresh() reflects the current in-flight refresh and clears once it settles', async () => {
    const { service } = createService(() => Promise.resolve([]));
    expect(service.inFlightRefresh()).toBeUndefined();
    const handle = service.refresh(request());
    expect(service.inFlightRefresh()).toBe(handle);
    await handle.result();
    expect(service.inFlightRefresh()).toBeUndefined();
  });

  it('abort() never throws even when the injected clock fails', async () => {
    const source = deferred<readonly BackendDescriptor[]>();
    let calls = 0;
    const now = (): string => {
      calls += 1;
      // Succeeds for call #1 (startedAt at handle creation); throws for
      // every call after that, including abort()'s own completedAt read.
      if (calls > 1) throw new Error('clock unavailable');
      return '2026-09-02T00:00:00.000Z';
    };
    const service = createModelCatalogService({
      seed: Object.freeze({
        revision: 1,
        descriptors: Object.freeze([descriptor('anthropic', 'model-a')]),
        generatedAt: '2026-09-02T00:00:00.000Z',
        stale: false,
        projection: 'privileged',
      }),
      descriptorSource: () => source.promise,
      now,
      newRefreshId: () => 'abort-clock-failure-refresh',
    });

    const handle = service.refresh(request());
    expect(() => handle.abort('stop')).not.toThrow();

    const result = await handle.result();
    expect(result.outcome).toBe('failed');
    expect(await handle.closed()).toBe('unresolved');
  });

  it('a descriptorSource that throws SYNCHRONOUSLY does not strand the in-flight slot', async () => {
    let invocations = 0;
    const { service } = createService(() => {
      invocations += 1;
      throw new Error('synchronous misbehavior');
    });

    const handle = service.refresh(request());
    // `refresh()` must have reserved the in-flight slot before the
    // synchronous throw had any chance to run and clear it again.
    expect(service.inFlightRefresh()).toBe(handle);

    const result = await handle.result();
    expect(result.outcome).toBe('failed');
    expect(result.failureReason).toContain('synchronous misbehavior');
    // The slot cleared once this refresh settled...
    expect(service.inFlightRefresh()).toBeUndefined();

    // ...so a SECOND refresh() genuinely starts a new attempt rather than
    // returning the same permanently-failed handle forever.
    const second = service.refresh(request('request-2'));
    expect(second).not.toBe(handle);
    await second.result();
    expect(invocations).toBe(2);
  });

  it('abort() is a no-op once the refresh has already settled normally', async () => {
    const { service } = createService(() => Promise.resolve([]));
    const handle = service.refresh(request());
    await handle.result();
    const completedResult = await handle.result();
    expect(completedResult.outcome).toBe('completed');

    handle.abort('too late');
    const stillCompletedResult = await handle.result();
    expect(stillCompletedResult).toBe(completedResult);
    expect(await handle.closed()).toBe('completed'); // not 'unresolved'
  });

  it('clears the in-flight slot BEFORE terminal observers run, so an observer-triggered refresh() is a genuinely new attempt', async () => {
    let invocations = 0;
    const { service } = createService(() => {
      invocations += 1;
      return Promise.resolve([]);
    });

    const handle = service.refresh(request());
    let chainedHandle: ReturnType<typeof service.refresh> | undefined;
    handle.subscribeSnapshot((snapshot) => {
      if (snapshot.status === 'settled') {
        chainedHandle = service.refresh(request('chained'));
      }
    });

    await handle.result();
    expect(chainedHandle).toBeDefined();
    expect(chainedHandle).not.toBe(handle);
    await chainedHandle?.result();
    expect(invocations).toBe(2);
  });
});
