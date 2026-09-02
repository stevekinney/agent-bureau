import type { BackendDescriptor } from '@lostgradient/operative/providers';
import { describe, expect, it, spyOn } from 'bun:test';
import type { MimeFamily, ModalityMatrix } from 'conversationalist';

import {
  type CatalogDescriptorSource,
  type CatalogRefreshRequest,
  createModelCatalogService,
  type ModelCatalogService,
} from './model-catalog-refresh';

const UNSUPPORTED: ModalityMatrix[keyof ModalityMatrix] = {
  input: false,
  output: false,
  sourceForms: [],
};

const FULL_MODALITIES: ModalityMatrix = Object.freeze({
  text: { input: true, output: true, sourceForms: ['inline'] },
  image: UNSUPPORTED,
  document: UNSUPPORTED,
  audio: UNSUPPORTED,
  video: UNSUPPORTED,
  file: UNSUPPORTED,
});

function descriptor(
  provider: BackendDescriptor['provider'],
  model: string,
  overrides: Partial<BackendDescriptor> = {},
): BackendDescriptor {
  return Object.freeze({
    descriptorVersion: 1,
    provider,
    endpoint: 'messages',
    model,
    aliases: [],
    lifecycle: 'stable',
    modalities: FULL_MODALITIES,
    mimeFamilies: ['text'] as readonly MimeFamily[],
    mediaLimits: [],
    contextWindowTokens: 100_000,
    maxOutputTokens: 8_000,
    streaming: true,
    tools: true,
    parallelTools: true,
    structuredOutput: true,
    parameterCompatibility: [],
    caching: false,
    batchInference: false,
    explicitThinkingRequest: false,
    serverSideTokenCounting: false,
    effort: { portable: [], nativeMapping: 'unsupported' as const, degradesTo: {} },
    availability: 'available',
    health: 'unknown',
    source: 'static',
    freshness: '2026-09-02T00:00:00.000Z',
    ...overrides,
  });
}

function createClock(startIso = '2026-09-02T00:00:00.000Z'): () => string {
  let counter = 0;
  return () => {
    const base = new Date(startIso).getTime();
    return new Date(base + counter++).toISOString();
  };
}

function createIdMinter(prefix: string): () => string {
  let counter = 0;
  return () => `${prefix}-${counter++}`;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((_resolve) => {
    resolve = _resolve;
  });
  return { promise, resolve };
}

function createService(
  descriptorSource: CatalogDescriptorSource,
  overrides: { readonly initialDescriptors?: readonly BackendDescriptor[] } = {},
): { service: ModelCatalogService; now: () => string; newRefreshId: () => string } {
  const now = createClock();
  const newRefreshId = createIdMinter('refresh');
  const service = createModelCatalogService({
    seed: Object.freeze({
      revision: 1,
      descriptors: Object.freeze(
        overrides.initialDescriptors ?? [descriptor('anthropic', 'model-a')],
      ),
      generatedAt: now(),
      stale: false,
      projection: 'privileged',
    }),
    descriptorSource,
    now,
    newRefreshId,
  });
  return { service, now, newRefreshId };
}

function request(id = 'request-1'): CatalogRefreshRequest {
  return { id, requestedAt: '2026-09-02T00:00:00.000Z' };
}

describe('createModelCatalogService', () => {
  it('catalog() is synchronous, cached, and never triggers a refresh', () => {
    let calls = 0;
    const { service } = createService(() => {
      calls += 1;
      return Promise.resolve([]);
    });
    const first = service.catalog();
    const second = service.catalog();
    expect(first).toBe(second);
    expect(calls).toBe(0);
  });

  it('commits a successful refresh with newRevision exactly one greater and completedAt from the injected clock', async () => {
    const newRow = descriptor('anthropic', 'model-b');
    const { service } = createService(() => Promise.resolve([newRow]));
    const before = service.catalog();
    const handle = service.refresh(request());
    const result = await handle.result();

    expect(result.outcome).toBe('completed');
    expect(result.previousRevision).toBe(before.revision);
    expect(result.newRevision).toBe(before.revision + 1);
    expect(typeof result.completedAt).toBe('string');

    const after = service.catalog();
    expect(after.revision).toBe(before.revision + 1);
    expect(after.stale).toBe(false);
    // Committed rows are cloned and deep-frozen rather than reused by
    // reference (a defensive copy, since descriptorSource's own row might
    // not be frozen at all), so check by value rather than identity.
    expect(after.descriptors.some((d) => d.model === newRow.model)).toBe(true);
  });

  it('a failed refresh leaves the prior catalog active with stale: true, returned by reference identity', async () => {
    const { service } = createService(() => Promise.reject(new Error('boom')));
    const before = service.catalog();
    const handle = service.refresh(request());
    const result = await handle.result();

    expect(result.outcome).toBe('failed');
    expect(result.failureReason).toContain('boom');
    expect(result.newRevision).toBeUndefined();

    const after = service.catalog();
    expect(after.stale).toBe(true);
    expect(after.revision).toBe(before.revision);
    // The substantive identity guarantee: the descriptor array a caller was
    // already holding is still the array in play — nothing was cleared or
    // replaced by the failure.
    expect(after.descriptors).toBe(before.descriptors);
  });

  it('an aborted refresh resolves with outcome failed, never rejects, and commits nothing; descriptorSource observes the abort', async () => {
    let observedSignal: AbortSignal | undefined;
    const source = deferred<readonly BackendDescriptor[]>();
    const { service } = createService((_req, signal) => {
      observedSignal = signal;
      return source.promise;
    });
    const before = service.catalog();
    const handle = service.refresh(request());

    handle.abort('caller cancelled');
    const result = await handle.result();

    expect(result.outcome).toBe('failed');
    expect(result.failureReason).toContain('caller cancelled');
    expect(observedSignal?.aborted).toBe(true);
    expect(service.catalog().revision).toBe(before.revision);
  });

  it('abort() is idempotent and never throws', async () => {
    const { service } = createService(() => Promise.reject(new Error('nope')));
    const handle = service.refresh(request());
    expect(() => handle.abort('first')).not.toThrow();
    expect(() => handle.abort('second')).not.toThrow();
    const result = await handle.result();
    expect(result.outcome).toBe('failed');
  });

  it('a late descriptorSource settlement after abort never re-resolves result() or commits', async () => {
    const source = deferred<readonly BackendDescriptor[]>();
    const { service } = createService(() => source.promise);
    const before = service.catalog();
    const handle = service.refresh(request());

    handle.abort('cancelled');
    const abortedResult = await handle.result();
    expect(abortedResult.failureReason).toContain('cancelled');

    // The scripted source resolves AFTER the abort already settled result().
    source.resolve([descriptor('anthropic', 'model-late')]);
    await Promise.resolve();
    await Promise.resolve();

    const stillAbortedResult = await handle.result();
    expect(stillAbortedResult).toBe(abortedResult);
    expect(service.catalog().revision).toBe(before.revision);
    expect(service.catalog().descriptors).not.toContain(
      service.catalog().descriptors.find((d) => d.model === 'model-late'),
    );
  });

  it('concurrent refreshes coalesce onto the in-flight handle with one refreshId and one descriptorSource invocation', async () => {
    let invocations = 0;
    const source = deferred<readonly BackendDescriptor[]>();
    const { service } = createService(() => {
      invocations += 1;
      return source.promise;
    });

    const first = service.refresh(request('req-1'));
    const second = service.refresh(request('req-2'));

    expect(second.refreshId).toBe(first.refreshId);
    expect(second).toBe(first);

    // descriptorSource is invoked from a deferred microtask (so a
    // synchronously-throwing source can never strand the in-flight slot —
    // see the sibling "does not strand the in-flight slot" test), so give
    // it one tick before asserting the single invocation.
    await Promise.resolve();
    expect(invocations).toBe(1);

    source.resolve([descriptor('anthropic', 'model-coalesced')]);
    const result = await first.result();
    expect(result.outcome).toBe('completed');
    expect(invocations).toBe(1);
  });

  it('replaceCatalog synchronously bumps the revision and stamps operator-override rows', () => {
    const { service } = createService(() => Promise.resolve([]));
    const before = service.catalog();
    const override = descriptor('openai', 'override-model', { source: 'static' });

    const after = service.replaceCatalog([override]);

    expect(after.revision).toBe(before.revision + 1);
    expect(after.descriptors).toHaveLength(1);
    expect(after.descriptors[0]?.source).toBe('operator-override');
    expect(after.descriptors[0]?.model).toBe('override-model');
    expect(service.catalog()).toBe(after);
  });

  it('a stale result whose previousRevision no longer matches fails with a revision-conflict reason and commits nothing', async () => {
    const source = deferred<readonly BackendDescriptor[]>();
    const { service } = createService(() => source.promise);
    const before = service.catalog();

    const handle = service.refresh(request());
    // Commit a DIFFERENT change (via replaceCatalog, since coalescing means
    // only one refresh is ever in flight) while the refresh is in flight.
    const overrideCatalog = service.replaceCatalog([descriptor('openai', 'operator-row')]);

    source.resolve([descriptor('anthropic', 'stale-row')]);
    const result = await handle.result();

    expect(result.outcome).toBe('failed');
    expect(result.failureReason).toContain('conflict');
    expect(result.newRevision).toBeUndefined();
    // The operator-override commit must survive untouched — the stale
    // refresh must not overwrite it, and must not mark it stale (it is not
    // stale; something newer just landed).
    expect(service.catalog()).toBe(overrideCatalog);
    expect(service.catalog().stale).toBe(false);
    expect(service.catalog().revision).toBe(before.revision + 1);
  });

  it('a partial provider failure commits returned rows and marks omitted providers prior rows availability unknown', async () => {
    const anthropicRow = descriptor('anthropic', 'model-a');
    const openaiRow = descriptor('openai', 'model-o');
    const { service } = createService(
      () => Promise.resolve([descriptor('anthropic', 'model-a-2')]),
      {
        initialDescriptors: [anthropicRow, openaiRow],
      },
    );

    const handle = service.refresh(request());
    const result = await handle.result();
    expect(result.outcome).toBe('completed');

    const after = service.catalog();
    expect(after.descriptors).toHaveLength(2);
    const returnedRow = after.descriptors.find((d) => d.model === 'model-a-2');
    expect(returnedRow).toBeDefined();
    const omittedRow = after.descriptors.find((d) => d.provider === 'openai');
    expect(omittedRow).toBeDefined();
    expect(omittedRow?.availability).toBe('unknown');
    // No row silently disappeared.
    expect(after.descriptors.some((d) => d.model === 'model-o')).toBe(true);
  });

  it('an empty descriptorSource result marks every prior row unknown rather than dropping it', async () => {
    const anthropicRow = descriptor('anthropic', 'model-a');
    const openaiRow = descriptor('openai', 'model-o');
    const { service } = createService(() => Promise.resolve([]), {
      initialDescriptors: [anthropicRow, openaiRow],
    });

    const handle = service.refresh(request());
    const result = await handle.result();
    expect(result.outcome).toBe('completed');

    const after = service.catalog();
    expect(after.descriptors).toHaveLength(2);
    expect(after.descriptors.every((d) => d.availability === 'unknown')).toBe(true);
  });

  it('freezes a committed row even when descriptorSource returns a mutable object', async () => {
    // Deliberately NOT frozen: a well-behaved descriptorSource freezes its
    // own rows (like this file's `descriptor()` helper), but this module
    // must not assume that (review finding, PR #432).
    const mutableRow = { ...descriptor('anthropic', 'mutable-row') };
    expect(Object.isFrozen(mutableRow)).toBe(false);
    const { service } = createService(() => Promise.resolve([mutableRow]));

    const handle = service.refresh(request());
    await handle.result();

    const committedRow = service.catalog().descriptors.find((d) => d.model === 'mutable-row');
    expect(committedRow).toBeDefined();
    expect(Object.isFrozen(committedRow)).toBe(true);
  });

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

  describe('closed() cleanup acknowledgement', () => {
    it('resolves "completed" for a normal successful refresh', async () => {
      const { service } = createService(() => Promise.resolve([]));
      const handle = service.refresh(request());
      await handle.result();
      expect(await handle.closed()).toBe('completed');
    });

    it('resolves "completed" for a normal descriptorSource rejection', async () => {
      const { service } = createService(() => Promise.reject(new Error('provider down')));
      const handle = service.refresh(request());
      await handle.result();
      expect(await handle.closed()).toBe('completed');
    });

    it('resolves "unresolved" for an aborted refresh', async () => {
      const source = deferred<readonly BackendDescriptor[]>();
      const { service } = createService(() => source.promise);
      const handle = service.refresh(request());
      handle.abort('stop');
      await handle.result();
      expect(await handle.closed()).toBe('unresolved');
    });

    it('resolves "not-required" for a stale-revision-conflict refresh', async () => {
      const source = deferred<readonly BackendDescriptor[]>();
      const { service } = createService(() => source.promise);
      const handle = service.refresh(request());
      service.replaceCatalog([descriptor('openai', 'operator-row')]);
      source.resolve([descriptor('anthropic', 'stale')]);
      await handle.result();
      expect(await handle.closed()).toBe('not-required');
    });

    it('resolves "failed" when a subscribed observer throws', async () => {
      const { service } = createService(() => Promise.resolve([]));
      const handle = service.refresh(request());
      handle.subscribeSnapshot(() => {
        throw new Error('observer bug');
      });
      await handle.result();
      expect(await handle.closed()).toBe('failed');
    });

    it('never rejects', async () => {
      const { service } = createService(() => Promise.reject(new Error('boom')));
      const handle = service.refresh(request());
      const outcome = await handle.closed();
      expect(outcome).toBeDefined();
    });

    it('resolves "completed" — an observer throwing only on the initial (non-terminal) delivery does not count', async () => {
      const { service } = createService(() => Promise.resolve([]));
      const handle = service.refresh(request());
      // Throws on registration (the pending-state delivery) but not again —
      // that initial delivery is the read-then-subscribe gap closer, not
      // terminal teardown, so it must not affect closed().
      let calls = 0;
      handle.subscribeSnapshot(() => {
        calls += 1;
        if (calls === 1) throw new Error('only on first delivery');
      });
      await handle.result();
      expect(calls).toBe(2); // pending delivery + terminal delivery
      expect(await handle.closed()).toBe('completed');
    });

    it('is fixed at settlement — a throwing observer subscribed AFTER settlement does not flip it', async () => {
      const { service } = createService(() => Promise.resolve([]));
      const handle = service.refresh(request());
      await handle.result();
      const before = await handle.closed();
      expect(before).toBe('completed');

      handle.subscribeSnapshot(() => {
        throw new Error('late observer bug');
      });

      expect(await handle.closed()).toBe('completed');
    });
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
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
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

  it('freezes the terminal result object before publishing and resolving it', async () => {
    const { service } = createService(() => Promise.resolve([]));
    const handle = service.refresh(request());
    const result = await handle.result();
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(handle.snapshot().result)).toBe(true);
    // Not just independently frozen — the SAME object, so a caller can't
    // observe result() and the snapshot's result field diverging.
    expect(handle.snapshot().result).toBe(result);
  });

  it('clones and freezes a caller-supplied seed rather than exposing it directly', () => {
    const mutableSeedDescriptors = [{ ...descriptor('anthropic', 'seed-row') }];
    expect(Object.isFrozen(mutableSeedDescriptors[0])).toBe(false);
    const unfrozenSeed = {
      revision: 1,
      descriptors: mutableSeedDescriptors,
      generatedAt: '2026-09-02T00:00:00.000Z',
      stale: false,
      projection: 'privileged' as const,
    };

    const service = createModelCatalogService({
      seed: unfrozenSeed,
      descriptorSource: () => Promise.resolve([]),
      now: createClock(),
      newRefreshId: createIdMinter('seed-freeze-refresh'),
    });

    const catalog = service.catalog();
    expect(catalog).not.toBe(unfrozenSeed);
    expect(Object.isFrozen(catalog)).toBe(true);
    expect(Object.isFrozen(catalog.descriptors)).toBe(true);
    expect(Object.isFrozen(catalog.descriptors[0])).toBe(true);
    // The caller's own array/row objects are untouched — this module
    // cloned rather than mutating them in place.
    expect(Object.isFrozen(mutableSeedDescriptors[0])).toBe(false);
  });

  it('does not mutate a live descriptorSource-owned nested object graph when committing', async () => {
    // Simulates a live source that retains and reuses the SAME nested
    // `aliases` array reference across calls (a cached lookup table, say).
    const sharedAliases = [{ alias: 'shared-alias', resolvesTo: 'model-a' }];
    const row = descriptor('anthropic', 'model-a', { aliases: sharedAliases });
    const { service } = createService(() => Promise.resolve([row]));

    const handle = service.refresh(request());
    await handle.result();

    // The committed copy is frozen...
    const committedRow = service.catalog().descriptors.find((d) => d.model === 'model-a');
    expect(Object.isFrozen(committedRow?.aliases)).toBe(true);
    // ...but the SOURCE's own array is untouched and still mutable, so a
    // live source can keep updating its own cache across future refreshes.
    expect(Object.isFrozen(sharedAliases)).toBe(false);
    sharedAliases.push({ alias: 'added-later', resolvesTo: 'model-a' });
    expect(sharedAliases).toHaveLength(2);
  });

  it('settles as failed, rather than hanging, when the commit path itself throws', async () => {
    // Succeeds for call #1 (startedAt, at handle creation) and #3+ (the
    // completedAt the failure path itself needs), but throws specifically
    // on call #2 — commit()'s generatedAt — to isolate a commit-path
    // failure from every other now() call site.
    let calls = 0;
    const now = (): string => {
      calls += 1;
      if (calls === 2) throw new Error('clock unavailable');
      return `2026-09-02T00:00:0${calls}.000Z`;
    };
    const newRefreshId = (): string => 'commit-throw-refresh';
    const service = createModelCatalogService({
      seed: Object.freeze({
        revision: 1,
        descriptors: Object.freeze([descriptor('anthropic', 'model-a')]),
        generatedAt: '2026-09-02T00:00:00.000Z',
        stale: false,
        projection: 'privileged',
      }),
      descriptorSource: () => Promise.resolve([descriptor('anthropic', 'model-b')]),
      now,
      newRefreshId,
    });

    const handle = service.refresh(request());
    const result = await handle.result();
    expect(result.outcome).toBe('failed');
    expect(result.failureReason).toContain('clock unavailable');
    expect(await handle.closed()).toBe('completed');
  });

  it('snapshot structurally satisfies the StartedWorkSnapshot floor', async () => {
    const { service } = createService(() => Promise.resolve([]));
    const handle = service.refresh(request());
    const pending = handle.snapshot();

    expect(pending.id).toBe(handle.refreshId);
    expect(pending.kind).toBe('model-catalog-refresh');
    expect(typeof pending.startedAt).toBe('string');
    expect(typeof pending.revision).toBe('number');
    expect(pending.status).toBe('pending');
    expect(typeof pending.lastTransitionAt).toBe('string');
    expect(pending.projection).toBe('privileged');
    expect(pending.ownership).toBe('independent');
    expect(pending.detached).toBe(false);
    expect(pending.durability).toBe('process-local');
    expect(pending.cancellable).toBe(true);
    expect(pending.result).toBeUndefined();

    await handle.result();
    const settled = handle.snapshot();
    expect(settled.status).toBe('settled');
    expect(settled.cancellable).toBe(false);
    expect(settled.result).toBeDefined();
    expect(settled.revision).toBeGreaterThan(pending.revision);
    expect(settled.lastTransitionAt >= settled.startedAt).toBe(true);
  });
});
