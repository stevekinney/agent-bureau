import type { BackendDescriptor } from '@lostgradient/operative';
import { describe, expect, it } from 'bun:test';
import { createModelCatalogService } from './model-catalog-refresh';

import {
  createClock,
  createIdMinter,
  createService,
  deferred,
  descriptor,
  request,
} from './model-catalog-refresh-test-helpers';

const commitThrowRefreshId = (): string => 'commit-throw-refresh';

describe('createModelCatalogService', () => {
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
      newRefreshId: commitThrowRefreshId,
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
