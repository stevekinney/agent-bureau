import type { BackendDescriptor } from '@lostgradient/operative/providers';
import { describe, expect, it } from 'bun:test';
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
    expect(after.descriptors).toContain(newRow);
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

  it('subscribeSnapshot delivers the current state before registration returns, and terminal state to a late subscriber', async () => {
    const source = deferred<readonly BackendDescriptor[]>();
    const { service } = createService(() => source.promise);
    const handle = service.refresh(request());

    const deliveries: string[] = [];
    handle.subscribeSnapshot((snapshot) => {
      deliveries.push(snapshot.state);
    });
    // Delivered synchronously, before any await.
    expect(deliveries).toEqual(['pending']);

    source.resolve([]);
    await handle.result();
    expect(deliveries).toEqual(['pending', 'settled']);

    const lateDeliveries: string[] = [];
    handle.subscribeSnapshot((snapshot) => {
      lateDeliveries.push(snapshot.state);
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
    const unsubscribe = handle.subscribeSnapshot((snapshot) => deliveries.push(snapshot.state));
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
    handle.subscribeSnapshot((snapshot) => secondObserverDeliveries.push(snapshot.state));

    await handle.result();
    expect(secondObserverDeliveries).toEqual(['pending', 'settled']);
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
    expect(typeof (handle as unknown as { then?: unknown }).then).not.toBe('function');
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

  it('subscribeSnapshot auto-unsubscribes when a live signal aborts later', async () => {
    const source = deferred<readonly BackendDescriptor[]>();
    const { service } = createService(() => source.promise);
    const handle = service.refresh(request());
    const controller = new AbortController();

    const deliveries: string[] = [];
    handle.subscribeSnapshot((snapshot) => deliveries.push(snapshot.state), {
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
    handle.subscribeSnapshot((snapshot) => deliveries.push(snapshot.state), {
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
});
