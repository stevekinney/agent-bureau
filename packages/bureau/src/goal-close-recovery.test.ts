/**
 * COR-851 — closing a goal applies the bureau's checkpoint retention to
 * everything the goal ran, and a process that dies between committing the
 * closure and finishing that cleanup leaves it for the next boot, with no API call.
 */
import { afterEach, describe, expect, it } from 'bun:test';

import { goalRecordKey, isGoalState } from './goal-state';
import {
  createCheckValidator,
  createTestDatabase,
  currentIsoTimestamp,
  goalRequest,
  pollUntil,
  type TestDatabase,
  workerAgent,
} from './testing/goal-fixtures.test-support';
import { bootOver, inspect } from './testing/goal-recovery-fixtures.test-support';
import { spyOnPrune } from './testing/prune-spy.test-support';

let database: TestDatabase = createTestDatabase('unset');
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
  await database.remove();
});

const agents = () => ({
  worker: workerAgent(() => Promise.resolve({ content: 'done', toolCalls: [] })),
});

/** Whether the goal is `succeeded`, read afresh. */
async function hasSucceeded(bureau: Awaited<ReturnType<typeof boot>>): Promise<boolean> {
  const goal = await bureau.goals.get('g1');
  return goal?.status === 'succeeded';
}

async function cleanedUpAt(bureau: Awaited<ReturnType<typeof boot>>): Promise<string | undefined> {
  const goal = await bureau.goals.get('g1');
  return goal?.cleanedUpAt;
}

async function boot() {
  const { bureau } = await bootOver({
    path: database.path,
    agents: agents(),
    validators: [createCheckValidator()],
    checkpointRetention: { keepLast: 1 },
  });
  cleanups.push(() => bureau.dispose());
  await bureau.waitForRecovery?.();
  return bureau;
}

describe('a goal closed by a process that died before its cleanup finished', () => {
  it('has its checkpoint history pruned by the next boot, once, with no API call', async () => {
    database = createTestDatabase('close-crash');
    const { spy, prunedIds } = await spyOnPrune();
    try {
      const first = await boot();
      await first.goals.create(goalRequest());
      expect(await pollUntil(() => hasSucceeded(first))).toBe(true);
      // The process committed `closedAt` and died before cleaning up.
      const view = await inspect(database.path);
      cleanups.push(() => view.dispose());
      const committed = await view.store.close('g1', currentIsoTimestamp());
      expect(committed.status).toBe('updated');
      expect(prunedIds(spy)).toEqual([]);

      const second = await boot();

      expect(prunedIds(spy).toSorted()).toEqual(['goal-g1-a0', 'goal:g1']);
      const repaired = await second.goals.get('g1');
      expect(repaired?.closedAt).toBeDefined();
      expect(repaired?.cleanedUpAt).toBeDefined();

      // Converged: a further boot has nothing left to prune.
      const pruned = prunedIds(spy).length;
      await boot();
      expect(prunedIds(spy)).toHaveLength(pruned);
    } finally {
      spy.mockRestore();
    }
  });

  it('is left for the next boot when this one could not prune it', async () => {
    database = createTestDatabase('close-unresolved');
    const { spy, original, prunedIds } = await spyOnPrune();
    try {
      const first = await boot();
      await first.goals.create(goalRequest());
      expect(await pollUntil(() => hasSucceeded(first))).toBe(true);
      const view = await inspect(database.path);
      cleanups.push(() => view.dispose());
      await view.store.close('g1', currentIsoTimestamp());
      spy.mockImplementation(function (this: unknown, workflowId, options) {
        return workflowId === 'goal-g1-a0'
          ? Promise.reject(new Error('storage hiccup'))
          : original.call(this, workflowId, options);
      });

      const second = await boot();

      expect(await cleanedUpAt(second)).toBeUndefined();
      spy.mockImplementation(function (this: unknown, workflowId, options) {
        return original.call(this, workflowId, options);
      });
      const before = prunedIds(spy).length;

      const third = await boot();

      expect(prunedIds(spy).length).toBeGreaterThan(before);
      expect(await cleanedUpAt(third)).toBeDefined();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('the record of a closed goal', () => {
  it('never reads as cleaned up unless it is closed', async () => {
    database = createTestDatabase('cleaned-unclosed');
    const first = await boot();
    await first.goals.create(goalRequest());
    expect(await pollUntil(() => hasSucceeded(first))).toBe(true);
    const view = await inspect(database.path);
    cleanups.push(() => view.dispose());
    const stored = JSON.parse((await view.kv.get(goalRecordKey('g1'))) as string) as Record<
      string,
      unknown
    >;

    expect(isGoalState({ ...stored, cleanedUpAt: '2026-10-02T00:00:00.000Z' })).toBe(false);
    expect(
      isGoalState({
        ...stored,
        closedAt: '2026-10-02T00:00:00.000Z',
        cleanedUpAt: '2026-10-02T00:00:01.000Z',
      }),
    ).toBe(true);
  });
});
