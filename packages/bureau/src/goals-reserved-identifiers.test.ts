/**
 * COR-851 — the ids a durable goal derives are the goal's alone.
 *
 * A goal's audit events are recorded under `bureau-goal-audit:<id>`, and Weft
 * deletes every event carrying a workflow's id when it purges that workflow. A
 * child run whose caller-chosen id equals the audit id would take the goal's
 * trail with it, across principals; ownership verification cannot prevent a
 * purge by id. So every prefix a goal derives an id under is refused for every
 * id an ordinary caller chooses, and a goal still runs under its own.
 */
import { createMockGenerate, stopWhen } from '@lostgradient/operative';
import { createToolbox } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';

import { BureauError, createBureau } from './create-bureau';
import {
  createCheckValidator,
  createDiagnostics,
  durableIds,
  goalRequest,
  hangUntilAborted,
  pollUntil,
  workerAgent,
  workflowStatus,
} from './testing/goal-fixtures.test-support';
import type { Bureau } from './types';

const open: Bureau[] = [];

afterEach(async () => {
  for (const bureau of open.splice(0)) await bureau.dispose();
});

async function boot() {
  const bureau = await createBureau({
    agents: {
      worker: workerAgent(hangUntilAborted),
      planner: workerAgent(hangUntilAborted, 'planner'),
    },
    validators: [createCheckValidator()],
    generate: createMockGenerate([{ content: 'ok', toolCalls: [] }]),
    toolbox: createToolbox([]),
    stopWhen: stopWhen.noToolCalls(),
    storage: { type: 'memory' },
    durableExecution: true,
    onDiagnostic: createDiagnostics().onDiagnostic,
  });
  const typed = bureau as unknown as Bureau;
  open.push(typed);
  return typed;
}

const RESERVED: string[] = ['goal:g1', 'goal-g1-s0', 'goal-g1-a0', 'bureau-goal-audit:g1'];

function thrown(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  return undefined;
}

async function expectChildRunIdRefused(bureau: Bureau, childRunId: string): Promise<void> {
  bureau.run('planner', 'plan');
  await pollUntil(async () => {
    const parents = await durableIds(bureau, 'agent-run-');
    return parents.length === 1;
  });
  const [parentRunId] = await durableIds(bureau, 'agent-run-');
  if (parentRunId === undefined) throw new Error('the parent run never started');

  const outcome = await bureau.children.dispatch({
    parentRunId,
    agentName: 'worker',
    input: 'x',
    childRunId,
    principal: 'mallory',
  });

  expect(outcome).toMatchObject({ outcome: 'rejected', code: 'reserved-child-run-id' });
  expect(await bureau.children.list(parentRunId)).toEqual([]);
}

describe('an id an ordinary caller chooses', () => {
  it.each(RESERVED)('may not be the child run id %s', async (childRunId) => {
    const bureau = await boot();
    await bureau.goals.create(goalRequest());

    await expectChildRunIdRefused(bureau, childRunId);
  });

  // Event history records a run, session, or schedule under `run:<id>`,
  // `session:<id>`, or `schedule:<id>`, and a child's workflow id is its run id:
  // a child with such an id would erase the owner's history when it is purged.
  it.each(['run:r1', 'session:s1', 'schedule:sch1'])(
    'may not be the child run id %s, an event-history owner id',
    async (childRunId) => {
      const bureau = await boot();

      await expectChildRunIdRefused(bureau, childRunId);
    },
  );

  it.each(RESERVED)('may not be the session id %s of createRun', async (sessionId) => {
    const bureau = await boot();

    const error = await bureau.createRun({ message: 'hello', sessionId }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BureauError);
    expect(error).toMatchObject({ code: 'BAD_REQUEST' });
    expect((error as Error).message).toContain('reserved-identifier');
  });

  it.each(RESERVED)('may not be the session id %s of bureau.run', async (sessionId) => {
    const bureau = await boot();

    const error = thrown(() => bureau.run('worker', 'hello', { sessionId }));

    expect(error).toBeInstanceOf(BureauError);
    expect(error).toMatchObject({ code: 'BAD_REQUEST' });
    expect((error as Error).message).toContain('reserved-identifier');
  });

  it.each(RESERVED)('may not be the session id %s of a schedule', async (sessionId) => {
    const bureau = await boot();

    const error = await bureau
      .createSchedule({ agentName: 'worker', input: 'x', spec: '1h', sessionId })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BureauError);
    expect(error).toMatchObject({ code: 'BAD_REQUEST' });
    expect((error as Error).message).toContain('reserved-identifier');
  });

  it('is still free when it only resembles a goal prefix', async () => {
    const bureau = await boot();

    const run = await bureau.createRun({ message: 'hello', sessionId: 'goalpost' });

    expect(run.sessionId).toBe('goalpost');
  });
});

describe('a goal', () => {
  it('still runs under its own reserved ids', async () => {
    const bureau = await boot();

    expect(await bureau.goals.create(goalRequest())).toMatchObject({ outcome: 'created' });

    await pollUntil(async () => (await workflowStatus(bureau, 'goal-g1-a0')) === 'running');
    expect(await workflowStatus(bureau, 'goal:g1')).toBe('running');
  });
});
