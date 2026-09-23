import type { BackendDescriptor } from '@lostgradient/operative';
import { describe, expect, it } from 'bun:test';

import { createService, deferred, descriptor, request } from './model-catalog-refresh-test-helpers';

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
});
