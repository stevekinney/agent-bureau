/**
 * COR-772 — the catalog dispatcher's child-start guards. The child path is
 * otherwise exercised end to end through `bureau.children` in
 * `bureau-children.test.ts`; these are the refusals the topology never
 * reaches in normal operation, because it plans the child first and refuses
 * an identifier another run already holds before it starts anything.
 */
import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import { createAgent, stopWhen } from '@lostgradient/operative';
import { describe, expect, it } from 'bun:test';

import { createCatalogDispatcher } from './bureau-catalog-dispatch';
import type { RuntimeComposition } from './runtime-composition';
import type { RunAttribution } from './serialization';

function createDispatcher(
  shuttingDown: boolean,
  options: {
    readonly runtime?: RuntimeComposition;
    readonly runAttribution?: Map<string, RunAttribution>;
  } = {},
) {
  const worker = createAgent({
    name: 'worker',
    generate: async () => ({ content: 'done', toolCalls: [] }),
    stopWhen: stopWhen.noToolCalls(),
  });
  return createCatalogDispatcher({
    agentCatalog: { find: (name: string) => (name === 'worker' ? worker : undefined) },
    // The first two refusals never reach the runtime composition.
    runtime: options.runtime ?? ({} as RuntimeComposition),
    runtimeServices: createManualRuntimeServices(),
    getShutdownPromise: () => (shuttingDown ? Promise.resolve() : undefined),
    catalogRuns: new Set(),
    runAttribution: options.runAttribution ?? new Map(),
    detachBestEffortPromise: () => {},
    createBureauError: (message, code) => Object.assign(new Error(message), { code }),
    validateAgentRunInput: () => {},
    validateBureauRunOptions: () => {},
    onDurableRunAborted: () => {},
  });
}

/** Just enough of a durable composition to reach the recovery-record write. */
function durableRuntime(claimed: boolean): RuntimeComposition {
  return {
    durable: { engine: {}, checkpointStore: {} },
    createBureauInvariantHooks: () => undefined,
    claimCatalogRunRecoveryRecord: async () => claimed,
    persistCatalogRunRecoveryRecord: () => {
      throw new Error('a child never overwrites a recovery record');
    },
  } as unknown as RuntimeComposition;
}

const start = {
  input: 'work',
  childRunId: 'child-1',
  context: {
    childCorrelation: {
      parentAgentName: 'planner',
      parentRunId: 'parent-1',
      childAgentName: 'worker',
      childRunId: 'child-1',
    },
  },
};

describe('createCatalogDispatcher — startChildRun', () => {
  it('refuses to start a child once the bureau is shutting down', () => {
    expect(() => createDispatcher(true).startChildRun({ ...start, agentName: 'worker' })).toThrow(
      expect.objectContaining({ code: 'CONFLICT' }),
    );
  });

  it('refuses a run identifier another run is already attributed under, and leaves it attributed', () => {
    const runAttribution = new Map([['child-1', { agentName: 'worker', principal: 'alice' }]]);
    const dispatcher = createDispatcher(false, { runtime: durableRuntime(true), runAttribution });

    expect(() =>
      dispatcher.startChildRun({ ...start, agentName: 'worker', principal: 'mallory' }),
    ).toThrow(expect.objectContaining({ code: 'CONFLICT' }));
    expect(runAttribution.get('child-1')).toEqual({ agentName: 'worker', principal: 'alice' });
  });

  it('fails a child whose recovery record another run already holds, and drops its own attribution', async () => {
    const runAttribution = new Map<string, RunAttribution>();
    const dispatcher = createDispatcher(false, { runtime: durableRuntime(false), runAttribution });

    const run = dispatcher.startChildRun({ ...start, agentName: 'worker', principal: 'mallory' });
    const result = await run.result();

    expect(result.finishReason).toBe('error');
    expect(String(result.error)).toContain('Run "child-1" already exists');
    expect(runAttribution.has('child-1')).toBe(false);
  });

  it('refuses to start a child for an agent the catalog does not have', () => {
    const dispatcher = createDispatcher(false);

    expect(dispatcher.planChildRun('nobody')).toBeUndefined();
    expect(() => dispatcher.startChildRun({ ...start, agentName: 'nobody' })).toThrow(
      expect.objectContaining({ code: 'NOT_FOUND' }),
    );
  });
});
