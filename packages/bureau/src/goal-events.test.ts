/**
 * COR-851 — a durable goal's audit history, read through `bureau.eventHistory`
 * over a real `createBureau`: what an operator sees, who may see it, and that a
 * restart neither loses nor repeats it.
 *
 * `goal-event-projection.test.ts` covers the projection itself; this file is
 * the wiring. History needs persistent storage, so every bureau here is over a
 * SQLite file.
 */
import type { DurableEventEnvelope } from '@lostgradient/operative';
import { createFleetEventFeed, resolveStorage } from '@lostgradient/weft';
import { afterEach, describe, expect, it } from 'bun:test';

import { goalTransitionId } from './goal-state';
import {
  createCheckValidator,
  createDiagnostics,
  createTestDatabase,
  goalRequest,
  goalStatus,
  hangForever,
  pollUntil,
  TERMINAL_STATUSES,
  type TestDatabase,
  workerAgent,
  workflowStatus,
} from './testing/goal-fixtures.test-support';
import {
  bootOver,
  inspect,
  pendingGoal,
  seedPoisoned,
} from './testing/goal-recovery-fixtures.test-support';
import type { Bureau } from './types';

const cleanups: Array<() => Promise<void> | void> = [];
let database: TestDatabase = createTestDatabase('unset');

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
  await database.remove();
});

const answerDone = () => workerAgent(() => Promise.resolve({ content: 'done', toolCalls: [] }));

async function boot(agent = answerDone()) {
  const { bureau } = await bootOver({
    path: database.path,
    agents: { worker: agent },
    validators: [createCheckValidator()],
    diagnostics: createDiagnostics(),
  });
  cleanups.push(() => bureau.dispose());
  await bureau.waitForRecovery?.();
  return bureau;
}

async function ended(bureau: Bureau, goalRunId = 'g1') {
  const reached = await pollUntil(async () => {
    const goal = await bureau.goals.get(goalRunId);
    return goal !== undefined && (TERMINAL_STATUSES as readonly string[]).includes(goal.status);
  });
  expect(reached).toBe(true);
}

async function goalEvents(
  bureau: Bureau,
  goalRunId = 'g1',
  options?: { principal?: string },
): Promise<DurableEventEnvelope[]> {
  const page = await bureau.eventHistory({ kind: 'goal', id: goalRunId }, options);
  if (!('events' in page) || 'owner' in page) {
    throw new Error(`expected an event page, got ${JSON.stringify(page)}`);
  }
  return [...page.events];
}

const kinds = (events: readonly DurableEventEnvelope[]) => events.map((event) => event.kind);

describe('a goal in bureau.eventHistory', () => {
  it('shows the audit events of a goal that retries and then passes', async () => {
    database = createTestDatabase('events-retry');
    let calls = 0;
    const bureau = await boot(
      workerAgent(() => {
        calls += 1;
        return Promise.resolve({ content: calls === 1 ? 'nope' : 'done', toolCalls: [] });
      }),
    );

    await bureau.goals.create(goalRequest());
    await ended(bureau);

    const events = await goalEvents(bureau);
    expect(kinds(events)).toEqual([
      'goal.started',
      'goal.attempt.started',
      'goal.attempt.validated',
      'goal.attempt.started',
      'goal.attempt.validated',
      'goal.succeeded',
    ]);
    expect(events.map((event) => event.owner)).toEqual(
      events.map(() => ({ kind: 'goal', id: 'g1' })),
    );
    expect(events[2]?.payload).toMatchObject({ outcomeKind: 'fail' });
    expect(events[5]?.payload).toEqual({ goalRunId: 'g1', terminalReason: 'validator-passed' });
    // Neither the objective nor the validator's feedback is in any event.
    expect(JSON.stringify(events)).not.toContain('say done');
    expect(JSON.stringify(events)).not.toContain('"work"');
  });

  it('records a goal that cannot start as started then failed', async () => {
    database = createTestDatabase('events-unsupported');
    const { bureau } = await bootOver({
      path: database.path,
      agents: { worker: answerDone() },
      validators: [createCheckValidator({ determinism: 'stochastic' })],
    });
    cleanups.push(() => bureau.dispose());

    await bureau.goals.create(goalRequest({ requireDeterministicValidation: true }));

    const events = await goalEvents(bureau);
    expect(kinds(events)).toEqual(['goal.started', 'goal.failed']);
    expect(events[1]?.payload).toEqual({
      goalRunId: 'g1',
      terminalReason: 'unsupported-validation',
    });
  });

  it('records a cancellation as the goal.canceled event, once', async () => {
    database = createTestDatabase('events-cancel');
    const bureau = await boot(workerAgent(hangForever));
    await bureau.goals.create(goalRequest());
    await pollUntil(async () => (await goalStatus(bureau)) === 'running');

    await bureau.goals.cancel('g1', { reason: 'no longer needed' });
    await ended(bureau);

    const events = await goalEvents(bureau);
    expect(kinds(events)).toEqual(['goal.started', 'goal.attempt.started', 'goal.canceled']);
    expect(events[2]?.payload).toEqual({ goalRunId: 'g1', terminalReason: 'goal-canceled' });
    // The reason an operator gave is on the record, not in the audit stream.
    expect(JSON.stringify(events)).not.toContain('no longer needed');
  });

  it('leaves another goal alone and pages with a cursor', async () => {
    database = createTestDatabase('events-owners');
    const bureau = await boot();
    await bureau.goals.create(goalRequest({ goalRunId: 'g1' }));
    await bureau.goals.create(goalRequest({ goalRunId: 'g2' }));
    await ended(bureau, 'g1');
    await ended(bureau, 'g2');

    const first = await bureau.eventHistory({ kind: 'goal', id: 'g1' }, { limit: 2 });
    if (!('events' in first)) throw new Error('expected a page');
    const rest = await bureau.eventHistory(
      { kind: 'goal', id: 'g1' },
      { limit: 10, ...(first.nextCursor === undefined ? {} : { since: first.nextCursor }) },
    );
    if (!('events' in rest)) throw new Error('expected a page');

    expect(first.hasMore).toBe(true);
    const everything = [...first.events, ...rest.events];
    expect(kinds(everything)).toEqual(kinds(await goalEvents(bureau, 'g1')));
    expect(
      everything.every((event) => (event.payload as { goalRunId: string }).goalRunId === 'g1'),
    ).toBe(true);
  });

  it('delivers the history to a live subscriber', async () => {
    database = createTestDatabase('events-subscribe');
    const bureau = await boot();
    const seen: string[] = [];
    const subscription = bureau.subscribeEventHistory({ kind: 'goal', id: 'g1' }, (event) =>
      seen.push(event.kind),
    );
    cleanups.push(() => subscription.unsubscribe());

    await bureau.goals.create(goalRequest());

    expect(await pollUntil(() => seen.includes('goal.succeeded'))).toBe(true);
    expect(seen[0]).toBe('goal.started');
  });
});

describe('who may read a goal history', () => {
  async function owned() {
    database = createTestDatabase('events-authorization');
    const bureau = await boot();
    await bureau.goals.create(goalRequest({ principal: 'alice' }));
    await ended(bureau);
    return bureau;
  }

  it('lets the owner and a trusted caller read it, and tells a stranger it is not there', async () => {
    const bureau = await owned();

    expect(kinds(await goalEvents(bureau, 'g1', { principal: 'alice' }))).toContain(
      'goal.succeeded',
    );
    expect(kinds(await goalEvents(bureau, 'g1'))).toContain('goal.succeeded');
    expect(await bureau.eventHistory({ kind: 'goal', id: 'g1' }, { principal: 'bob' })).toEqual({
      outcome: 'not-found',
    });
  });

  it('answers a stranger exactly as it answers a goal that does not exist', async () => {
    const bureau = await owned();

    const stranger = await bureau.eventHistory({ kind: 'goal', id: 'g1' }, { principal: 'bob' });
    const absent = await bureau.eventHistory(
      { kind: 'goal', id: 'never-created' },
      { principal: 'bob' },
    );

    expect(stranger).toEqual(absent);
  });

  it('hides the retention gap from a stranger too', async () => {
    const bureau = await owned();
    // Advance the feed's retention floor so a cursor before it is genuinely a gap.
    const storage = await resolveStorage({ type: 'sqlite', path: database.path });
    cleanups.push(() => storage[Symbol.dispose]());
    await createFleetEventFeed(storage).retain({ beforeSequence: 2 });
    const options = { since: '0' };

    const owner = await bureau.eventHistory(
      { kind: 'goal', id: 'g1' },
      { ...options, principal: 'alice' },
    );
    const stranger = await bureau.eventHistory(
      { kind: 'goal', id: 'g1' },
      { ...options, principal: 'bob' },
    );

    // The owner really is told about the gap; the stranger learns nothing, not even that.
    expect(owner).toMatchObject({ outcome: 'gap', firstRetainedSequence: 2 });
    expect(stranger).toEqual({ outcome: 'not-found' });
  });

  it('is open for a goal created with no principal', async () => {
    database = createTestDatabase('events-open');
    const bureau = await boot();
    await bureau.goals.create(goalRequest());
    await ended(bureau);

    expect(kinds(await goalEvents(bureau, 'g1', { principal: 'anyone' }))).toContain(
      'goal.succeeded',
    );
  });

  it('does not consider a goal a deleted aggregate', async () => {
    const bureau = await owned();
    await bureau.goals.close('g1');

    const page = await bureau.eventHistory({ kind: 'goal', id: 'g1' }, { principal: 'alice' });

    expect('outcome' in page).toBe(false);
  });
});

describe('a goal history across a restart', () => {
  it('neither repeats nor loses an event when the bureau boots again over a finished goal', async () => {
    database = createTestDatabase('events-reboot');
    const first = await boot();
    await first.goals.create(goalRequest());
    await ended(first);
    const before = await goalEvents(first);
    await first.dispose();

    const second = await boot();

    expect(await goalEvents(second)).toEqual(before);
  });

  it('records one attempt start and one success when a restart finishes a running goal', async () => {
    database = createTestDatabase('events-crash');
    const dead = await boot(workerAgent(hangForever));
    await dead.goals.create(goalRequest());
    await pollUntil(async () => (await goalStatus(dead)) === 'running');

    const survivor = await boot();
    await ended(survivor);

    const events = await goalEvents(survivor);
    expect(kinds(events)).toEqual([
      'goal.started',
      'goal.attempt.started',
      'goal.attempt.validated',
      'goal.succeeded',
    ]);
  });

  it('fills in the events of a goal whose projection a crash lost', async () => {
    database = createTestDatabase('events-lost');
    const view = await inspect(database.path);
    await view.store.create(pendingGoal());
    await view.store.applyTransition({
      goalRunId: 'g1',
      seq: 1,
      transitionId: goalTransitionId('g1', 1),
      to: 'failed',
      at: '2026-10-02T00:00:01.000Z',
      cause: 'fail: unsupported-validation',
      terminalReason: 'unsupported-validation',
    });
    await view.dispose();

    const bureau = await boot();

    const events = await goalEvents(bureau);
    expect(kinds(events)).toEqual(['goal.started', 'goal.failed']);
    expect(events.map((event) => event.emittedAtMs)).toEqual([
      Date.parse(pendingGoal().createdAt),
      Date.parse('2026-10-02T00:00:01.000Z'),
    ]);
  });

  it('records goal.recovered for each controller restart', async () => {
    database = createTestDatabase('events-recovered');
    const bureau = await boot();
    const view = await inspect(database.path);
    cleanups.push(() => view.dispose());
    await seedPoisoned(view);
    await bureau.goals.recover('g1');
    expect(
      await pollUntil(async () => (await workflowStatus(bureau, 'goal:g1')) === 'failed'),
    ).toBe(true);

    const report = await bureau.goals.recover('g1');

    expect(report.goals[0]).toMatchObject({ outcome: 'restarted' });
    const history = await goalEvents(bureau);
    const recovered = history.filter((event) => event.kind === 'goal.recovered');
    expect(recovered.map((event) => event.payload)).toMatchObject([
      { goalRunId: 'g1', controllerRestarts: 1, status: 'pending' },
    ]);
  });
});

describe('who may subscribe to a goal history', () => {
  async function aliceGoalEnded() {
    database = createTestDatabase('events-subscribe-authorization');
    const bureau = await boot();
    await bureau.goals.create(goalRequest({ principal: 'alice' }));
    await ended(bureau);
    return bureau;
  }

  function watch(bureau: Bureau, principal?: string) {
    const seen: string[] = [];
    const subscription = bureau.subscribeEventHistory(
      { kind: 'goal', id: 'g1' },
      (event) => seen.push(event.kind),
      principal === undefined ? undefined : { principal },
    );
    cleanups.push(() => subscription.unsubscribe());
    return { seen, subscription };
  }

  it('replays the history to the goal owner and to a trusted caller', async () => {
    const bureau = await aliceGoalEnded();

    const owner = watch(bureau, 'alice');
    const trusted = watch(bureau);

    expect(await pollUntil(() => owner.seen.includes('goal.succeeded'))).toBe(true);
    expect(await pollUntil(() => trusted.seen.includes('goal.succeeded'))).toBe(true);
    expect(owner.seen[0]).toBe('goal.started');
    expect(owner.subscription.closed).toBe(false);
  });

  it('delivers nothing to a stranger', async () => {
    const bureau = await aliceGoalEnded();
    const owner = watch(bureau, 'alice');
    const stranger = watch(bureau, 'bob');

    // The owner's replay finished, so anything the stranger was going to be given has been.
    expect(await pollUntil(() => owner.seen.includes('goal.succeeded'))).toBe(true);
    expect(await pollUntil(() => stranger.seen.length > 0, 100)).toBe(false);
  });

  it('delivers nothing to a stranger who subscribed to the id before the goal existed, and everything to its owner', async () => {
    database = createTestDatabase('events-subscribe-before-creation');
    const bureau = await boot();
    const stranger = watch(bureau, 'bob');
    const owner = watch(bureau, 'alice');

    await bureau.goals.create(goalRequest({ principal: 'alice' }));
    await ended(bureau);

    expect(await pollUntil(() => owner.seen.includes('goal.succeeded'))).toBe(true);
    expect(owner.seen[0]).toBe('goal.started');
    expect(await pollUntil(() => stranger.seen.length > 0, 100)).toBe(false);
  });
});
