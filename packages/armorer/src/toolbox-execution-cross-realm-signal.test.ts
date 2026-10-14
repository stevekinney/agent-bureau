import { describe, expect, it } from 'bun:test';
import vm from 'node:vm';
import { z } from 'zod';

import { createTool } from './create-tool';
import { isAbortSignalLike } from './create-tool/execution-options';
import { createToolbox } from './create-toolbox';

type CrossRealmAbortSource = {
  readonly signal: AbortSignal;
  readonly abort: (reason: unknown) => void;
};

/**
 * Builds a minimal abort signal entirely inside a separate `node:vm` realm.
 * The realm has no `AbortController`, so the signal is a structural one whose
 * prototype and listener functions all belong to that realm: it satisfies the
 * `AbortSignal` contract the execution lifecycle relies on while failing
 * `instanceof AbortSignal` against this realm's constructor.
 */
function createCrossRealmAbortSource(): CrossRealmAbortSource {
  const context = vm.createContext({});
  return vm.runInContext(
    `(() => {
      const listeners = new Set();
      const signal = {
        aborted: false,
        reason: undefined,
        addEventListener(type, listener) {
          if (type === 'abort') listeners.add(listener);
        },
        removeEventListener(type, listener) {
          if (type === 'abort') listeners.delete(listener);
        },
      };
      const abort = (reason) => {
        if (signal.aborted) return;
        signal.aborted = true;
        signal.reason = reason;
        for (const listener of [...listeners]) listener({ type: 'abort', target: signal });
        listeners.clear();
      };
      return { signal, abort };
    })()`,
    context,
  ) as CrossRealmAbortSource;
}

const requestContext = {
  authority: {
    principalId: 'principal-a',
    tenantId: 'tenant-a',
    ownerId: 'owner-a',
    capabilities: ['tools:execute'],
    authorizationRevision: 'authorization:1',
  },
  audience: 'tenant' as const,
  agentId: 'agent-a',
  runId: 'run-a',
};

function createGatedTool(name: string) {
  const observedSignals: Array<AbortSignal | undefined> = [];
  let releaseGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  let startedCount = 0;
  const startWaiters: Array<{ count: number; resolve: () => void }> = [];
  const tool = createTool({
    name,
    description: 'waits on a manual gate so abort state can be observed mid-flight',
    input: z.object({}),
    async execute(_input, context) {
      observedSignals.push(context.signal);
      startedCount += 1;
      for (const waiter of startWaiters) if (startedCount >= waiter.count) waiter.resolve();
      await gate;
      return 'released';
    },
  });
  const started = (count: number) =>
    new Promise<void>((resolve) => {
      if (startedCount >= count) resolve();
      else startWaiters.push({ count, resolve });
    });
  return { tool, observedSignals, releaseGate, started };
}

describe('toolbox execution with a cross-realm AbortSignal', () => {
  it('builds a signal that is structurally valid but fails instanceof in this realm', () => {
    const { signal } = createCrossRealmAbortSource();

    expect(signal instanceof AbortSignal).toBe(false);
    expect(isAbortSignalLike(signal)).toBe(true);
  });

  it('rejects signal-like values that lack removeEventListener', () => {
    expect(isAbortSignalLike({ aborted: false, addEventListener: () => {} })).toBe(false);
    expect(isAbortSignalLike(null)).toBe(false);
    expect(isAbortSignalLike(undefined)).toBe(false);
    expect(isAbortSignalLike(new AbortController().signal)).toBe(true);
  });

  it('links a cross-realm signal into the per-execution controller of a single call', async () => {
    const source = createCrossRealmAbortSource();
    const { tool, observedSignals, releaseGate, started } = createGatedTool('cross-realm-single');
    const toolbox = createToolbox([tool]);

    const execution = toolbox.execute(
      { id: 'cross-realm-single-call', name: tool.name, arguments: {} },
      { requestContext, signal: source.signal },
    );
    await started(1);

    const [active] = toolbox.executions.inspectPrivileged({ toolName: tool.name });
    expect(active?.snapshot.state).toBe('active');
    expect(observedSignals[0]?.aborted).toBe(false);

    source.abort('caller stop');

    const [aborting] = toolbox.executions.inspectPrivileged({ toolName: tool.name });
    expect(aborting?.snapshot.state).toBe('abort-requested');
    expect(observedSignals[0]?.aborted).toBe(true);
    expect(observedSignals[0]?.reason).toBe('caller stop');

    releaseGate();
    await execution;
  });

  it('links a cross-realm signal into each per-child execution controller of a batch', async () => {
    const source = createCrossRealmAbortSource();
    const { tool, observedSignals, releaseGate, started } = createGatedTool('cross-realm-batch');
    const toolbox = createToolbox([tool]);

    const execution = toolbox.execute(
      [
        { id: 'cross-realm-batch-one', name: tool.name, arguments: {} },
        { id: 'cross-realm-batch-two', name: tool.name, arguments: {} },
      ],
      { requestContext, signal: source.signal },
    );
    await started(2);

    const [batch] = toolbox.executions.inspectPrivileged({ toolName: 'toolbox.batch' });
    const childStates = () =>
      toolbox.executions
        .inspectPrivileged()
        .filter(({ snapshot }) => snapshot.parentExecutionId === batch?.snapshot.executionId)
        .map(({ snapshot }) => snapshot.state);
    expect(childStates()).toEqual(['active', 'active']);

    source.abort('caller stop');

    expect(childStates()).toEqual(['abort-requested', 'abort-requested']);
    expect(observedSignals.map((signal) => signal?.aborted)).toEqual([true, true]);

    releaseGate();
    await execution;
  });
});
