/**
 * The black-box lifecycle contract matrix (AB-268, extended by AB-269).
 * Registers the shared scenario list from `runner.ts` against every adapter
 * this project ships — direct `ActiveRun`, the thin `AgentRun` wrapper, a
 * session-owned run, a Bureau-owned in-memory run, a Bureau-owned durable
 * (sqlite) run, and a Bureau-owned recovered-durable run — through public
 * APIs only. See each adapter's own module doc for what it supports and
 * why.
 *
 * The AB-29 negative below is NOT part of the shared scenario list (its
 * `WorkflowState`-shaped assertion has no counterpart the other adapters
 * could meaningfully share) — it is this issue's own dedicated proof that a
 * broken durable reconstruction (a catalog agent missing from the second
 * Bureau's catalog) reports AB-29's observable recovery failure rather than
 * a bare `null`, using the identical two-Bureau-over-one-sqlite-path
 * technique `bureau-recovered.ts` uses (see that adapter's module doc for
 * why bureau A is left open rather than gracefully shut down first).
 */
import { createAgent } from '@lostgradient/operative';
import { createManualRuntimeServices, waitForCondition } from '@lostgradient/operative/test';
import { createTool, createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { createBureauTestHarness, createSqliteStorageFixture } from 'bureau/test';
import { z } from 'zod';

import { createAgentRunAdapter } from './adapters/agent-run';
import { createBureauDurableAdapter } from './adapters/bureau-durable';
import { createBureauMemoryAdapter } from './adapters/bureau-memory';
import { createBureauRecoveredAdapter } from './adapters/bureau-recovered';
import { createDirectRunAdapter } from './adapters/direct-run';
import { createSessionRunAdapter } from './adapters/session-run';
import { runLifecycleContractSuite } from './runner';
import { stableRunId } from './support';

runLifecycleContractSuite(createDirectRunAdapter());
runLifecycleContractSuite(createAgentRunAdapter());
runLifecycleContractSuite(createSessionRunAdapter());
runLifecycleContractSuite(createBureauMemoryAdapter());
runLifecycleContractSuite(createBureauDurableAdapter());
runLifecycleContractSuite(createBureauRecoveredAdapter());

function nextTool() {
  return createTool({
    name: 'next',
    description: 'Advances the run to its next step.',
    input: z.object({}),
    execute: async () => ({ result: 'ok' }),
  });
}

describe('lifecycle contract: bureau-recovered — AB-29 negative', () => {
  it('reports a missing catalog agent as an observable failed reconstruction, never a bare null', async () => {
    const runtimeA = createManualRuntimeServices();
    const ownedStorage = createSqliteStorageFixture({ runtime: runtimeA });
    const path = ownedStorage.path;
    if (path === undefined) {
      throw new Error('createSqliteStorageFixture did not allocate a path');
    }

    const steps: number[] = [];
    const generate = async (context: { step: number; signal?: AbortSignal }) => {
      steps.push(context.step);
      if (context.step === 0) {
        return { content: 'step 0', toolCalls: [{ name: 'next', arguments: {} }] };
      }
      return new Promise<{ content: string; toolCalls: never[] }>((resolve) => {
        context.signal?.addEventListener(
          'abort',
          () => resolve({ content: 'aborted', toolCalls: [] }),
          { once: true },
        );
      });
    };

    const harnessA = await createBureauTestHarness({
      agents: {
        p: createAgent({
          generate,
          name: 'p',
          toolbox: createToolbox([nextTool()]),
          runtime: runtimeA,
        }),
      },
      runtime: runtimeA,
      storage: createSqliteStorageFixture({ runtime: runtimeA, path }),
      durableExecution: true,
      generate: async () => ({ content: 'top', toolCalls: [] }),
      toolbox: createToolbox([]),
    });

    try {
      const run = harnessA.bureau.run('p', 'go');
      const runId = await stableRunId(run);
      harnessA.scope.register({ kind: 'run', identifier: runId, run, detached: true });
      await waitForCondition(() => steps.includes(1), 'bureau A never parked at step 1');

      const runtimeB = createManualRuntimeServices();
      const harnessB = await createBureauTestHarness({
        // Deliberately missing the 'p' catalog agent — simulates the agent
        // having been retired between restarts (AB-240's precedent).
        agents: {},
        runtime: runtimeB,
        storage: createSqliteStorageFixture({ runtime: runtimeB, path }),
        durableExecution: true,
        generate: async () => ({ content: 'top', toolCalls: [] }),
        toolbox: createToolbox([]),
      });

      try {
        await waitForCondition(async () => {
          const state = await harnessB.bureau.getDurableRun(runId);
          return state?.status === 'failed';
        }, 'bureau B never observed the broken-reconstruction failure');
        const state = await harnessB.bureau.getDurableRun(runId);

        // The AB-29 assertion: an observable failure, never a bare null.
        expect(state).not.toBeNull();
        expect(state?.status).toBe('failed');
        expect(state?.error).toBeDefined();
        expect(typeof state?.error).toBe('string');
        expect(state?.error).toContain('p');

        harnessB.registerDurableRun(runId);
      } finally {
        await harnessB.close();
      }

      harnessA.registerDurableRun(runId, { detached: true });
    } finally {
      await harnessA.close();
      await ownedStorage.dispose();
    }
  });
});
