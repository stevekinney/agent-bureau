/**
 * COR-851 — a controller is not started for a goal recorded while the bureau
 * began to shut down: the shutdown check made before the record was written is
 * repeated immediately before the start.
 */
import { MemoryStorage, textValueStore } from '@lostgradient/weft';
import { describe, expect, it } from 'bun:test';

import { createGoalStore } from './goal-store';
import { createGoalValidatorCatalog } from './goal-validator-catalog';
import { createBureauGoals } from './goals';
import { dependencies, scriptedEngine } from './testing/goal-control-fixtures.test-support';
import { createCheckValidator, goalRequest } from './testing/goal-fixtures.test-support';

describe('create when the bureau begins to shut down while the goal is being recorded', () => {
  it('records the goal, starts no controller, and says why', async () => {
    const baseStore = createGoalStore(textValueStore(new MemoryStorage()));
    let closing = false;
    const store = {
      ...baseStore,
      create: async (state: Parameters<typeof baseStore.create>[0]) => {
        const created = await baseStore.create(state);
        closing = true;
        return created;
      },
    };
    const { engine, calls } = scriptedEngine({ workflows: {} });
    const { control } = dependencies(store, engine, {
      catalog: createGoalValidatorCatalog([createCheckValidator()]),
      isClosing: () => closing,
    });
    const goals = createBureauGoals({
      ...control,
      runtime: { identifiers: undefined as never },
      resolveFreshAttemptSource: undefined,
      planAgent: () => ({ durable: true, agentVersion: '1' }),
    });

    const created = await goals.create(goalRequest());

    expect(created).toMatchObject({
      outcome: 'created',
      goal: { goalRunId: 'g1', status: 'pending' },
      controller: { status: 'start-failed', reason: 'The bureau is shutting down.' },
    });
    expect(calls.some((call) => call.startsWith('start:'))).toBe(false);
    expect(await baseStore.get('g1')).toBeDefined();
  });
});
