import { createTestToolbox } from 'armorer/test';
import { file } from 'bun';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';
import { createManualRuntimeServices, eventObservable } from 'lifecycle';

import { createChildRunRegistry } from '../child-run';
import { noToolCalls } from '../conditions/predicates';
import { createActiveRun } from '../create-run';
import { createMockGenerate } from './index';
import type { ClosableRun } from './resource-scope';
import { createResourceScope, QuiescenceError } from './resource-scope';

function textResponse(content: string) {
  return { content, toolCalls: [] };
}

/** A stub `ClosableRun` whose `closed()` never settles as terminal — used to leak a "run" without a real agent loop. */
function stuckRun(): ClosableRun & { abortCalls: number } {
  const stub = {
    abortCalls: 0,
    abort() {
      stub.abortCalls++;
    },
    async closed() {
      return { status: 'unresolved', reason: 'timed-out' } as const;
    },
  };
  return stub;
}

describe('createResourceScope', () => {
  it('reports quiescent with nothing leaked when nothing was registered', async () => {
    const runtime = createManualRuntimeServices();
    const scope = createResourceScope('empty', runtime);

    const report = await scope.close();

    expect(report).toEqual({ scope: 'empty', quiescent: true, leaked: [], detached: [] });
  });

  it('closes quiescent when a registered run drives to completion', async () => {
    const runtime = createManualRuntimeServices();
    const generate = createMockGenerate([textResponse('done')]);
    const toolbox = createTestToolbox([]);
    const activeRun = createActiveRun({
      generate,
      toolbox,
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      runtime,
    });

    const scope = createResourceScope('positive-path', runtime);
    scope.register({ kind: 'run', identifier: 'run-1', run: activeRun });

    await activeRun.result;

    const report = await scope.close();

    expect(report.quiescent).toBe(true);
    expect(report.leaked).toEqual([]);
  });

  it('names an uncleared timer handle, discovered via runtime-services-timers', async () => {
    const runtime = createManualRuntimeServices();
    const scope = createResourceScope('timer-leak', runtime);

    const handle = runtime.timers.setTimeout(() => {}, 1000);
    scope.register({ kind: 'timer', identifier: 'timer-1', handle });

    const report = await scope.assertQuiescent();

    expect(report.quiescent).toBe(false);
    expect(report.leaked).toEqual([
      {
        kind: 'timer',
        identifier: 'timer-1',
        owner: 'timer-leak',
        parentId: undefined,
        discoveredVia: 'runtime-services-timers',
      },
    ]);
  });

  it('names an outstanding deferred entry, discovered via runtime-services-deferred', async () => {
    const runtime = createManualRuntimeServices();
    const scope = createResourceScope('deferred-leak', runtime);

    let releaseNever: (() => void) | undefined;
    const neverSettles = new Promise<void>((resolve) => {
      releaseNever = resolve;
    });
    runtime.deferred.track(neverSettles, 'my-deferred-label');
    scope.register({ kind: 'queue-item', identifier: 'queue-1', label: 'my-deferred-label' });

    const report = await scope.assertQuiescent();

    expect(report.quiescent).toBe(false);
    expect(report.leaked).toEqual([
      {
        kind: 'queue-item',
        identifier: 'queue-1',
        owner: 'deferred-leak',
        parentId: undefined,
        discoveredVia: 'runtime-services-deferred',
      },
    ]);

    // Never leave a dangling unresolved promise behind for the test process.
    releaseNever?.();
  });

  it('names an undisposed event subscription', async () => {
    const runtime = createManualRuntimeServices();
    const scope = createResourceScope('listener-leak', runtime);

    const target = new EventTarget();
    const subscription = eventObservable(target, 'ping').subscribe(() => {});
    scope.register({ kind: 'listener', identifier: 'listener-1', subscription });

    const report = await scope.assertQuiescent();

    expect(report.quiescent).toBe(false);
    expect(report.leaked).toEqual([
      {
        kind: 'listener',
        identifier: 'listener-1',
        owner: 'listener-leak',
        parentId: undefined,
        discoveredVia: 'public-child-discovery',
      },
    ]);

    subscription.unsubscribe();
  });

  it('names a non-terminal child run still listed by ChildRunRegistry, discovered via public-child-discovery', async () => {
    const runtime = createManualRuntimeServices();
    const scope = createResourceScope('child-leak', runtime);

    const registry = createChildRunRegistry();
    registry.register({
      id: 'child-run-1',
      parentId: 'parent-run-1',
      agentName: 'sub-agent',
      durable: false,
      abort: () => {},
    });
    scope.register({ kind: 'child', identifier: 'registry-1', registry });

    const report = await scope.assertQuiescent();

    expect(report.quiescent).toBe(false);
    expect(report.leaked).toEqual([
      {
        kind: 'child',
        identifier: 'child-run-1',
        owner: 'child-leak',
        parentId: 'parent-run-1',
        discoveredVia: 'public-child-discovery',
      },
    ]);
  });

  it('names a registered run whose closed() reports unresolved, as a durable-owner leak', async () => {
    const runtime = createManualRuntimeServices();
    const scope = createResourceScope('run-leak', runtime);

    const run = stuckRun();
    scope.register({ kind: 'run', identifier: 'run-1', run });

    const report = await scope.assertQuiescent();

    expect(report.quiescent).toBe(false);
    expect(report.leaked).toEqual([
      {
        kind: 'durable-owner',
        identifier: 'run-1',
        owner: 'run-leak',
        parentId: undefined,
        discoveredVia: 'public-child-discovery',
      },
    ]);
    // assertQuiescent() must never abort anything.
    expect(run.abortCalls).toBe(0);
  });

  it('reports a leak in a nested child scope at the parent boundary, with the child scope as owner', async () => {
    const runtime = createManualRuntimeServices();
    const parent = createResourceScope('parent', runtime);
    const child = parent.child('child-scope');

    const handle = runtime.timers.setTimeout(() => {}, 5000);
    child.register({ kind: 'timer', identifier: 'nested-timer', handle });

    let caught: unknown;
    try {
      await parent.close();
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(QuiescenceError);
    const report = (caught as QuiescenceError).report;
    expect(report.scope).toBe('parent');
    expect(report.leaked).toEqual([
      {
        kind: 'timer',
        identifier: 'nested-timer',
        owner: 'child-scope',
        parentId: undefined,
        discoveredVia: 'runtime-services-timers',
      },
    ]);
  });

  it('rejects close() with a QuiescenceError whose message renders every leaked resource', async () => {
    const runtime = createManualRuntimeServices();
    const scope = createResourceScope('rendered', runtime);
    const handle = runtime.timers.setTimeout(() => {}, 5000);
    scope.register({ kind: 'timer', identifier: 'render-timer', handle, owner: 'test-owner' });

    expect(scope.close()).rejects.toThrow(QuiescenceError);
    expect(scope.close()).rejects.toThrow(/render-timer/);
    expect(scope.close()).rejects.toThrow(/test-owner/);
    expect(scope.close()).rejects.toThrow(/runtime-services-timers/);
  });

  it('marks a deliberately detached resource as detached, never as a leak', async () => {
    const runtime = createManualRuntimeServices();
    const scope = createResourceScope('detached', runtime);
    const handle = runtime.timers.setTimeout(() => {}, 5000);
    scope.register({ kind: 'timer', identifier: 'detached-timer', handle, detached: true });

    const report = await scope.assertQuiescent();

    expect(report.quiescent).toBe(true);
    expect(report.leaked).toEqual([]);
    expect(report.detached).toEqual([{ kind: 'timer', id: 'detached-timer' }]);
  });

  it('renders both leaked and detached resources in the rejection message when a scope has both', async () => {
    const runtime = createManualRuntimeServices();
    const scope = createResourceScope('mixed', runtime);
    const leakedHandle = runtime.timers.setTimeout(() => {}, 5000);
    const detachedHandle = runtime.timers.setTimeout(() => {}, 5000);
    scope.register({ kind: 'timer', identifier: 'still-leaked', handle: leakedHandle });
    scope.register({
      kind: 'timer',
      identifier: 'intentionally-detached',
      handle: detachedHandle,
      detached: true,
    });

    expect(scope.close()).rejects.toThrow(/still-leaked/);
    expect(scope.close()).rejects.toThrow(/intentionally-detached/);
    expect(scope.close()).rejects.toThrow(/Detached \(not counted as leaks\)/);
  });

  it('close() is idempotent: a second call returns the identical report and aborts nothing again', async () => {
    const runtime = createManualRuntimeServices();
    const scope = createResourceScope('idempotent-quiescent', runtime);
    const run = stuckRun();
    // Mark it detached so the scope is quiescent despite the run never settling terminal.
    scope.register({ kind: 'run', identifier: 'run-1', run, detached: true });

    const first = await scope.close();
    const second = await scope.close();

    expect(first).toBe(second);
    expect(run.abortCalls).toBe(0);
  });

  it('close() is idempotent on the non-quiescent path: a second call rejects with the identical error', async () => {
    const runtime = createManualRuntimeServices();
    const scope = createResourceScope('idempotent-non-quiescent', runtime);
    const run = stuckRun();
    scope.register({ kind: 'run', identifier: 'run-1', run });

    let firstError: unknown;
    try {
      await scope.close();
    } catch (error) {
      firstError = error;
    }

    let secondError: unknown;
    try {
      await scope.close();
    } catch (error) {
      secondError = error;
    }

    expect(firstError).toBeInstanceOf(QuiescenceError);
    expect(firstError).toBe(secondError);
    // abort() is called once per close() invocation's underlying settle work,
    // which only ever runs once thanks to the cached promise.
    expect(run.abortCalls).toBe(1);
  });

  it('assertQuiescent() may be called before close() without aborting anything', async () => {
    const runtime = createManualRuntimeServices();
    const scope = createResourceScope('probe-then-close', runtime);
    const run = stuckRun();
    scope.register({ kind: 'run', identifier: 'run-1', run });

    const probe = await scope.assertQuiescent();
    expect(probe.quiescent).toBe(false);
    expect(run.abortCalls).toBe(0);

    expect(scope.close()).rejects.toThrow(QuiescenceError);
    expect(run.abortCalls).toBe(1);
  });

  it('never produces a LeakedResource with discoveredVia "public-snapshot" — snapshot() does not exist on the baseline (AB-214 makes this branch reachable)', async () => {
    const runtime = createManualRuntimeServices();
    const scope = createResourceScope('no-public-snapshot', runtime);

    const timerHandle = runtime.timers.setTimeout(() => {}, 5000);
    scope.register({ kind: 'timer', identifier: 'timer-1', handle: timerHandle });

    let releaseNever: (() => void) | undefined;
    const neverSettles = new Promise<void>((resolve) => {
      releaseNever = resolve;
    });
    runtime.deferred.track(neverSettles, 'label-1');
    scope.register({ kind: 'queue-item', identifier: 'queue-1', label: 'label-1' });

    const target = new EventTarget();
    const subscription = eventObservable(target, 'ping').subscribe(() => {});
    scope.register({ kind: 'listener', identifier: 'listener-1', subscription });

    const registry = createChildRunRegistry();
    registry.register({
      id: 'child-1',
      parentId: 'parent-1',
      agentName: 'sub',
      durable: false,
      abort: () => {},
    });
    scope.register({ kind: 'child', identifier: 'registry-1', registry });

    scope.register({ kind: 'run', identifier: 'run-1', run: stuckRun() });

    const report = await scope.assertQuiescent();

    expect(report.leaked.length).toBeGreaterThan(0);
    for (const leak of report.leaked) {
      expect(leak.discoveredVia).not.toBe('public-snapshot');
      expect(leak.kind).not.toBe('connection');
    }

    releaseNever?.();
    subscription.unsubscribe();
  });

  it("imports nothing outside operative/src's own exports-reachable surface plus lifecycle", async () => {
    const source = await file(new URL('./resource-scope.ts', import.meta.url)).text();
    const specifiers = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1] ?? '');

    expect(specifiers.length).toBeGreaterThan(0);
    for (const specifier of specifiers) {
      const allowed = specifier === 'lifecycle' || specifier.startsWith('.');
      expect(allowed).toBe(true);
    }
  });
});
