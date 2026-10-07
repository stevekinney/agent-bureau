/**
 * COR-851 — what the goal composition does around the boot sweep: a store that
 * cannot be listed does not keep the sweep from running, and a recovery that
 * outlived the sweep's budget is drained, not left running over a disposed engine.
 */
import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import { GOAL_WORKFLOW_TYPE } from '@lostgradient/operative';
import { MemoryStorage, textValueStore } from '@lostgradient/weft';
import { describe, expect, it } from 'bun:test';

import { createGoalAttemptFenceHost } from './goal-attempt-fence';
import { createGoalWorkflowHost } from './goal-ports';
import { GOAL_BOOT_SWEEP_BUDGET_MS } from './goal-recovery';
import { createGoalState } from './goal-state';
import { createGoalStore } from './goal-store';
import { createGoalValidatorCatalog } from './goal-validator-catalog';
import { composeBureauGoals, GOAL_DRAIN_BUDGET_MS } from './goals-composition';
import { NOW, runningGoal, scriptedEngine } from './testing/goal-control-fixtures.test-support';
import { CHECK } from './testing/goal-fixtures.test-support';
import type { BureauDiagnostic } from './types';

const turns = async (count = 200) => {
  for (let turn = 0; turn < count; turn += 1) await Promise.resolve();
};

function compose(options: {
  kv: ReturnType<typeof textValueStore>;
  workflows: Record<string, string>;
  isClosing?: () => boolean;
}) {
  const diagnostics: BureauDiagnostic[] = [];
  const runtime = createManualRuntimeServices();
  const { engine, calls } = scriptedEngine({ workflows: options.workflows });
  const composition = composeBureauGoals({
    catalog: createGoalValidatorCatalog([
      {
        identity: CHECK,
        determinism: 'deterministic',
        validate: () => Promise.resolve({ kind: 'pass', evidence: [] }),
      } as never,
    ]),
    kv: options.kv,
    sessionStore: undefined,
    resolveFreshAttemptSource: undefined,
    runtimeServices: runtime,
    host: createGoalWorkflowHost(),
    fenceClaim: () => Promise.resolve('fenced'),
    fenceHost: createGoalAttemptFenceHost(),
    getDurable: () => ({ engine: engine as never, checkpointStore: {} as never }),
    planAgent: () => ({ durable: true, agentVersion: '1' }),
    startAttemptRun: () => {
      throw new Error('no attempt run was expected');
    },
    cancelRun: () => Promise.resolve({ status: 'requested' }),
    readRunRecord: () => Promise.resolve({ status: 'missing' }),
    cleanupWorkflow: () => Promise.resolve({ status: 'not-required' }),
    isClosing: options.isClosing ?? (() => false),
    diagnose: (diagnostic) => diagnostics.push(diagnostic),
    eventHistory: { record: () => Promise.resolve({ status: 'recorded' }) as never },
  });
  return { composition, diagnostics, calls, runtime, engine };
}

describe('the boot sweep when the goal store cannot be listed for the event re-projection', () => {
  it('diagnoses the failure and still runs the goal recovery sweep', async () => {
    const kv = textValueStore(new MemoryStorage());
    await createGoalStore(kv).create(
      createGoalState({
        goalRunId: 'g1',
        identity: { name: 'goal', version: '1' },
        objective: { agentName: 'worker', prompt: 'work' },
        validator: CHECK,
        conversationPolicy: { kind: 'continue' },
        bounds: { maximumAttempts: 2, maximumTotalSteps: 10 },
        now: NOW,
      }),
    );
    let listings = 0;
    const flaky = {
      ...kv,
      list: (prefix?: string) => {
        listings += 1;
        return listings === 1
          ? Promise.reject(new Error('listing is down'))
          : kv.list(prefix ?? '');
      },
    } as typeof kv;
    const { composition, diagnostics, calls } = compose({ kv: flaky, workflows: {} });

    const report = await composition.recoverAtBoot();

    expect(
      diagnostics.some(
        (diagnostic) =>
          diagnostic.message.includes('re-project') && String(diagnostic.cause).includes('down'),
      ),
    ).toBe(true);
    // The sweep ran: the pending goal got its controller.
    expect(calls).toContain('start:goal:g1');
    expect(report.goals).toMatchObject([{ goalRunId: 'g1', outcome: 'started' }]);
  });
});

describe('shutdown after a boot sweep that outlived its budget', () => {
  it('aborts the recovery still running and waits for it to settle, leaving no timer behind', async () => {
    const kv = textValueStore(new MemoryStorage());
    await runningGoal('g1', createGoalStore(kv));
    // The attempt's run is gone, so recovery starts it again; that start never settles.
    let hang = false;
    const hanging = {
      ...kv,
      get: (key: string) => (hang ? new Promise<never>(() => {}) : kv.get(key)),
    } as typeof kv;
    const base = compose({ kv: hanging, workflows: {} });
    const original = base.engine.get.bind(base.engine);
    base.engine.get = (id: string) => {
      if (id === 'goal-g1-a0') hang = true;
      if (id === 'goal:g1') {
        return Promise.resolve({
          id,
          type: GOAL_WORKFLOW_TYPE,
          input: { goalRunId: 'g1' },
          status: 'running',
        } as never);
      }
      return original(id);
    };

    let report: Awaited<ReturnType<typeof base.composition.recoverAtBoot>> | undefined;
    void base.composition.recoverAtBoot().then((done) => {
      report = done;
    });
    await turns();
    await base.runtime.advance(GOAL_BOOT_SWEEP_BUDGET_MS);
    await turns();
    expect(report?.failures.map((failure) => failure.goalRunId)).toEqual(['g1']);

    let drained = false;
    const draining = base.composition.drain().then(() => {
      drained = true;
    });
    await turns();

    expect(drained).toBe(true);
    await draining;
    expect(base.runtime.pendingTimers()).toEqual([]);
  });
});

describe('shutdown after a boot sweep blocked outside the attempt start', () => {
  it('stops waiting for the sweep once the drain budget passes, diagnoses it, and leaves no timer behind', async () => {
    const kv = textValueStore(new MemoryStorage());
    await runningGoal('g1', createGoalStore(kv));
    const base = compose({ kv, workflows: {} });
    // The controller read never settles, and nothing the shutdown signal reaches is waiting on it.
    base.engine.get = () => new Promise<never>(() => {});

    let report: Awaited<ReturnType<typeof base.composition.recoverAtBoot>> | undefined;
    void base.composition.recoverAtBoot().then((done) => {
      report = done;
    });
    await turns();
    await base.runtime.advance(GOAL_BOOT_SWEEP_BUDGET_MS);
    await turns();
    expect(report?.failures.map((failure) => failure.goalRunId)).toEqual(['g1']);

    let drained = false;
    const draining = base.composition.drain().then(() => {
      drained = true;
    });
    await turns();
    expect(drained).toBe(false);

    await base.runtime.advance(GOAL_DRAIN_BUDGET_MS);
    await turns();

    expect(drained).toBe(true);
    await draining;
    expect(base.diagnostics.map((diagnostic) => diagnostic.message)).toContainEqual(
      expect.stringContaining('did not settle'),
    );
    expect(base.runtime.pendingTimers()).toEqual([]);
  });
});
