/**
 * COR-851 — the owned engine over a REAL Weft engine. Weft's `Engine` methods
 * read their instance state through the receiver, so a wrapper that calls one
 * detached from the engine breaks controller start, signal, cancel, and resume
 * even though every test over a hand-written fake engine passes. These tests
 * drive each override against the real thing.
 */
import {
  createRunEngine,
  GOAL_WORKFLOW_TYPE,
  type RegistryAgnosticEngine,
} from '@lostgradient/operative';
import { MemoryStorage, workflow } from '@lostgradient/weft';
import { afterEach, describe, expect, it } from 'bun:test';

import { createOwnedGoalEngine } from './goal-ownership';
import type { GoalEngine } from './goal-types';
import { pollUntil } from './testing/goal-fixtures.test-support';

const disposers: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
});

/** A controller that parks on `ping` and returns, owned by the goal named in its input. */
const parkedController = () =>
  workflow({ name: GOAL_WORKFLOW_TYPE }).execute(async function* (ctx) {
    yield* ctx.waitForSignal<unknown>('ping');
    return 'pinged';
  });
const idleRun = () =>
  workflow({ name: 'agentRun' }).execute(async function* (ctx) {
    return yield* ctx.run(() => Promise.resolve('idle'));
  });

async function realEngine(storage: MemoryStorage) {
  const { engine } = await createRunEngine({
    storage,
    runWorkflow: idleRun(),
    goalWorkflow: parkedController(),
    recover: false,
  });
  disposers.push(() => engine[Symbol.dispose]());
  return engine;
}

const own = (engine: RegistryAgnosticEngine) =>
  createOwnedGoalEngine(
    engine as unknown as GoalEngine,
    () => Promise.resolve({ status: 'missing' }),
    () => Promise.resolve({ agentName: 'worker', principal: undefined, maximumAttempts: 10 }),
  );

describe('createOwnedGoalEngine over a real Weft engine', () => {
  it('starts a controller and signals it', async () => {
    const engine = await realEngine(new MemoryStorage());
    const owned = own(engine);

    const handle = await owned.start(GOAL_WORKFLOW_TYPE, { goalRunId: 'g1' }, { id: 'goal:g1' });
    await owned.signal('goal:g1', 'ping', {});

    expect(await handle.result()).toBe('pinged');
  });

  it('cancels a controller', async () => {
    const engine = await realEngine(new MemoryStorage());
    const owned = own(engine);
    await owned.start(GOAL_WORKFLOW_TYPE, { goalRunId: 'g2' }, { id: 'goal:g2' });

    await owned.cancel('goal:g2');

    await pollUntil(async () => {
      const state = await engine.get('goal:g2');
      return state?.status === 'cancelled';
    });
  });

  it('resumes a controller a stopped engine left behind', async () => {
    const storage = new MemoryStorage();
    const first = await realEngine(storage);
    await own(first).start(GOAL_WORKFLOW_TYPE, { goalRunId: 'g3' }, { id: 'goal:g3' });
    first[Symbol.dispose]();

    const second = await realEngine(storage);
    const owned = own(second);
    const handle = await owned.resume('goal:g3');
    await owned.signal('goal:g3', 'ping', {});

    expect(await handle.result()).toBe('pinged');
  });
});
