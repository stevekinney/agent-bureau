/**
 * COR-851 — `close()` reads a goal that is not terminal, and a cancellation
 * commits `canceled` before the close does. The store accepts the close over
 * the fresh `canceled` record, so the settlement a canceled goal owes before it
 * leaves the boot sweep must be run against what the close committed, not what
 * the caller read.
 */
import { describe, expect, it } from 'bun:test';

import { commitCancellation } from './goal-controller';
import type { GoalStore } from './goal-store';
import { createBureauGoals } from './goals';
import {
  dependencies,
  NOW,
  runningGoal,
  scriptedEngine,
} from './testing/goal-control-fixtures.test-support';

/** A store whose first `get` answers the record as it was before the race. */
function racing(store: GoalStore, before: Awaited<ReturnType<GoalStore['get']>>): GoalStore {
  let first = true;
  return {
    ...store,
    get: async (goalRunId) => {
      if (first) {
        first = false;
        return before;
      }
      return store.get(goalRunId);
    },
  };
}

async function canceledAfterTheCallerRead(workflows: Record<string, string>) {
  const store = await runningGoal();
  const before = await store.get('g1');
  await store.requestCancellation('g1', { requestedAt: NOW }, NOW);
  await commitCancellation(store, (await store.get('g1'))!, Date.parse(NOW));
  const { engine } = scriptedEngine({ workflows, finalizer: { status: 'succeeded' } });
  const { control } = dependencies(racing(store, before), engine);
  const goals = createBureauGoals({
    ...control,
    runtime: { identifiers: undefined as never },
    resolveFreshAttemptSource: undefined,
    planAgent: () => undefined,
  });
  return { store, goals };
}

describe('close() racing a cancellation', () => {
  it('does not mark cleanup done while the canceled goal still has a controller running', async () => {
    const { store, goals } = await canceledAfterTheCallerRead({
      'goal:g1': 'running',
      'goal-g1-a0': 'cancelled',
    });

    const closed = await goals.close('g1');

    expect(closed).toMatchObject({
      outcome: 'cancellation-pending',
      awaiting: ['controller'],
    });
    const after = await store.get('g1');
    // Closed, so the closure is committed, but still owing: the next boot's sweep settles it.
    expect(after?.closedAt).toBeDefined();
    expect(after?.cleanedUpAt).toBeUndefined();
  });

  it('closes and cleans a canceled goal whose controller and run have ended', async () => {
    const { store, goals } = await canceledAfterTheCallerRead({
      'goal:g1': 'cancelled',
      'goal-g1-a0': 'cancelled',
    });

    expect(await goals.close('g1')).toMatchObject({ outcome: 'closed' });
    const after = await store.get('g1');
    expect(after?.cleanedUpAt).toBeDefined();
  });
});
