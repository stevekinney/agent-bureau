/**
 * COR-1251 — executable copies of the durable parent-child examples in
 * `documentation/multi-agent-lifecycle.md` and this package's README.
 *
 * Each example test reproduces one documented example as written. Only the imports
 * (`./index` stands in for `@lostgradient/bureau`), the SQLite path (a
 * per-process temporary file, removed afterwards), and the delegation secret
 * (which the documentation leaves to the host's secret store) differ. Every
 * result the documentation claims in a comment is asserted. The tests for a
 * durable `bureau.run` parent's identifier, and for which principal owns a
 * child, check the addressing contract the guide states, using the same
 * `durableRunId` helper both examples use. Change the examples and the
 * documentation together.
 */
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type AgentRun,
  createAgent,
  defineChildSignals,
  type GenerateFunction,
  readParentSignals,
  stopWhen,
} from '@lostgradient/operative';
import { createTool } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { type Bureau, createBureau } from './index';
import { throwingRejectionOf } from './testing/promise-outcome.test-support.ts';

const databasePath = join(tmpdir(), `bureau-children-guide-${process.pid}.sqlite`);

afterEach(async () => {
  for (const suffix of ['', '-wal', '-shm']) {
    await rm(`${databasePath}${suffix}`, { force: true });
  }
});

/** Never answers, and stops when its run is aborted, as a real provider call does. */
const untilAborted: GenerateFunction = ({ signal }) =>
  new Promise((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(new Error('stopped')), { once: true });
  });

// `bureau.run` returns its handle at once. The handle's snapshot names the
// agent until the durable dispatch resolves, then carries the durable run
// identifier. Children can be dispatched under it once the engine has the workflow.
async function durableRunId(
  bureau: Pick<Bureau, 'getDurableRun'>,
  run: Pick<AgentRun, 'snapshot'>,
): Promise<string> {
  for (;;) {
    const { id, durability, status } = run.snapshot();
    if (durability === 'durable') {
      if (await bureau.getDurableRun(id)) return id;
    } else if (status !== 'created') {
      throw new Error(`Run "${id}" is not durable, so it cannot own Bureau children.`);
    }
    await Bun.sleep(5);
  }
}

describe('documentation/multi-agent-lifecycle.md — durable children in Bureau', () => {
  it('lists, inspects, signals, and cancels one child while its sibling keeps running', async () => {
    // Parent → child messages, shared by the dispatching host and the child's tools.
    const researchSignals = defineChildSignals({
      signals: { focus: z.object({ topic: z.string() }) },
      events: {},
    });

    // The researcher waits in a tool until its parent names a topic.
    const researcher = createAgent({
      name: 'researcher',
      generate: async ({ step }) =>
        step === 0
          ? { content: '', toolCalls: [{ name: 'await-focus', arguments: {} }] }
          : { content: 'findings are ready', toolCalls: [] },
      tools: {
        'await-focus': createTool({
          name: 'await-focus',
          description: 'Waits for the supervising run to choose a topic.',
          input: z.object({}),
          async execute(_input, context) {
            const parent = readParentSignals(context.executionContext, researchSignals);
            if (!parent) return 'no supervising run';
            return new Promise<string>((resolve) => {
              parent.onSignal('focus', ({ payload }) => resolve(payload.topic));
            });
          },
        }),
      },
      stopWhen: stopWhen.noToolCalls(),
    });

    // The planner stands in for a long-running supervising agent.
    const planner = createAgent({ name: 'planner', generate: untilAborted });

    const bureau = await createBureau({
      agents: { planner, researcher },
      storage: { type: 'sqlite', path: databasePath },
      children: { signals: { researcher: researchSignals } },
    });

    const plannerRun = bureau.run('planner', 'Plan the corvid report');
    const parentRunId = await durableRunId(bureau, plannerRun);

    await bureau.children.dispatch({
      parentRunId,
      agentName: 'researcher',
      input: 'Research crows',
      childRunId: 'research-crows',
    });
    await bureau.children.dispatch({
      parentRunId,
      agentName: 'researcher',
      input: 'Research ravens',
      childRunId: 'research-ravens',
      parentCancellation: 'detach',
    });

    const children = await bureau.children.list(parentRunId);
    // Two records, both `status: 'running'`, each with a durable workflow identity.
    const crows = await bureau.children.get({ parentRunId, childRunId: 'research-crows' });
    // crows?.parentCancellation === 'cascade', the default

    const reply = await bureau.children.signal({
      parentRunId,
      childRunId: 'research-ravens',
      name: 'focus',
      payload: { topic: 'ravens' },
    });
    // { outcome: 'acknowledged', signalId: 'research-ravens:signal:1', sequence: 1 }

    const cancelled = await bureau.children.cancel({
      parentRunId,
      childRunId: 'research-crows',
      reason: 'duplicate work',
    });
    // { outcome: 'requested', child } — research-ravens is untouched

    const ravens = await bureau.children.wait({ parentRunId, childRunId: 'research-ravens' });
    // { outcome: 'settled', child: { status: 'completed', outcome: { content: 'findings are ready', ... } } }
    const stopped = await bureau.children.wait({ parentRunId, childRunId: 'research-crows' });
    // { outcome: 'settled', child: { status: 'aborted', outcome: { reason: 'duplicate work' } } }

    const history = await bureau.auditTrail?.query({ runId: 'research-crows' });
    // history?.map((record) => record.type) → ['child.started', 'child.aborted']

    plannerRun.abort('report planned');
    await bureau.dispose();

    expect(children).toHaveLength(2);
    for (const child of children) {
      expect(child).toMatchObject({
        parentRunId,
        parentAgentName: 'planner',
        childAgentName: 'researcher',
        status: 'running',
        workflow: { kind: 'durable', workflowType: 'agentRun', workflowId: child.childRunId },
      });
    }
    expect(crows).toMatchObject({ childRunId: 'research-crows', parentCancellation: 'cascade' });
    expect(reply).toEqual({
      outcome: 'acknowledged',
      signalId: 'research-ravens:signal:1',
      sequence: 1,
    });
    expect(cancelled).toMatchObject({
      outcome: 'requested',
      child: { childRunId: 'research-crows' },
    });
    expect(ravens).toMatchObject({
      outcome: 'settled',
      child: {
        childRunId: 'research-ravens',
        status: 'completed',
        outcome: { finishReason: 'stop-condition', content: 'findings are ready' },
      },
    });
    expect(stopped).toMatchObject({
      outcome: 'settled',
      child: { status: 'aborted', outcome: { reason: 'duplicate work' } },
    });
    expect(history?.map((record) => record.type)).toEqual(['child.started', 'child.aborted']);
  });
});

describe('documentation/multi-agent-lifecycle.md — a durable bureau.run parent’s identifier', () => {
  it('reads each parent’s identifier from its own handle, whatever else the engine lists', async () => {
    const planner = createAgent({ name: 'planner', generate: untilAborted });
    const bureau = await createBureau({
      agents: { planner },
      storage: { type: 'sqlite', path: databasePath },
    });

    const first = bureau.run('planner', 'First plan');
    // Until the durable dispatch resolves, the snapshot is a placeholder.
    const placeholder = first.snapshot();
    const second = bureau.run('planner', 'Second plan');
    const secondRunId = await durableRunId(bureau, second);
    const firstRunId = await durableRunId(bureau, first);

    const child = await bureau.children.dispatch({
      parentRunId: firstRunId,
      agentName: 'planner',
      input: 'Help the first plan',
      childRunId: 'first-plan-helper',
    });
    // The engine's listing holds every durable run, children included, newest first.
    let listed: readonly { readonly id: string; readonly createdAt: number }[] = [];
    while (!listed.some(({ id }) => id === 'first-plan-helper')) {
      await Bun.sleep(5);
      const page = await bureau.listDurableRuns();
      listed = page?.items ?? [];
    }
    // The handle still names its own run once others have started.
    const firstRunIdAgain = await durableRunId(bureau, first);

    first.abort('done');
    second.abort('done');
    await bureau.children.wait({ parentRunId: firstRunId, childRunId: 'first-plan-helper' });
    await bureau.dispose();

    expect(placeholder).toMatchObject({
      id: 'planner',
      durability: 'process-local',
      status: 'created',
    });
    expect(firstRunId).not.toBe(secondRunId);
    expect(firstRunIdAgain).toBe(firstRunId);
    expect(first.snapshot()).toMatchObject({ id: firstRunId, durability: 'durable' });
    expect(second.snapshot()).toMatchObject({ id: secondRunId, durability: 'durable' });
    expect(child).toMatchObject({ outcome: 'started', child: { parentRunId: firstRunId } });
    expect(listed.map(({ id }) => id).toSorted()).toEqual(
      [firstRunId, secondRunId, 'first-plan-helper'].toSorted(),
    );
    const createdAt = listed.map((item) => item.createdAt);
    expect(createdAt).toEqual(createdAt.toSorted((left, right) => right - left));
  });

  it('refuses a bureau.run run that is not durable, which cannot own children', async () => {
    const planner = createAgent({ name: 'planner', generate: untilAborted });
    // No storage, so no durable engine: `bureau.run` runs the agent in memory.
    const bureau = await createBureau({ agents: { planner } });

    const run = bureau.run('planner', 'Plan in memory');
    const failure = await throwingRejectionOf(durableRunId(bureau, run));
    const { id, durability } = run.snapshot();
    const dispatched = await bureau.children.dispatch({
      parentRunId: id,
      agentName: 'planner',
      input: 'Help the in-memory plan',
    });

    run.abort('done');
    await run.result();
    await bureau.dispose();

    expect(id).not.toBe('planner');
    expect(durability).toBe('process-local');
    expect(failure).toThrow(`Run "${id}" is not durable, so it cannot own Bureau children.`);
    expect(dispatched).toEqual({ outcome: 'not-found' });
  });
});

describe('documentation/multi-agent-lifecycle.md — which principal owns a Bureau child', () => {
  it('gives a child the parent’s principal, or the dispatching principal when the parent has none', async () => {
    const planner = createAgent({ name: 'planner', generate: untilAborted });
    const bureau = await createBureau({
      agents: { planner },
      storage: { type: 'sqlite', path: databasePath },
    });

    const shared = bureau.run('planner', 'A plan with no principal');
    const owned = bureau.run('planner', 'The owner’s plan', { principal: 'owner' });
    const sharedRunId = await durableRunId(bureau, shared);
    const ownedRunId = await durableRunId(bureau, owned);
    const dispatch = (parentRunId: string, childRunId: string, principal?: string) =>
      bureau.children.dispatch({
        parentRunId,
        agentName: 'planner',
        input: `Help as ${principal ?? 'the host'}`,
        childRunId,
        ...(principal === undefined ? {} : { principal }),
      });

    const alices = await dispatch(sharedRunId, 'alices-helper', 'alice');
    const bobs = await dispatch(sharedRunId, 'bobs-helper', 'bob');
    const ownersByHost = await dispatch(ownedRunId, 'owners-helper');
    const alicesUnderOwner = await dispatch(ownedRunId, 'alices-intrusion', 'alice');
    const alicesAsBob = { parentRunId: sharedRunId, childRunId: 'alices-helper', principal: 'bob' };
    const readAsBob = {
      get: await bureau.children.get(alicesAsBob),
      list: await bureau.children.list(sharedRunId, { principal: 'bob' }),
      wait: await bureau.children.wait(alicesAsBob),
      cancel: await bureau.children.cancel(alicesAsBob),
    };
    const readAsAlice = await bureau.children.get({ ...alicesAsBob, principal: 'alice' });
    const readByHost = await bureau.children.get({
      parentRunId: sharedRunId,
      childRunId: 'alices-helper',
    });
    const ownersAsAlice = await bureau.children.get({
      parentRunId: ownedRunId,
      childRunId: 'owners-helper',
      principal: 'alice',
    });

    shared.abort('done');
    owned.abort('done');
    for (const [parentRunId, childRunId] of [
      [sharedRunId, 'alices-helper'],
      [sharedRunId, 'bobs-helper'],
      [ownedRunId, 'owners-helper'],
    ] as const) {
      await bureau.children.wait({ parentRunId, childRunId });
    }
    await bureau.dispose();

    expect(alices).toMatchObject({ outcome: 'started', child: { principal: 'alice' } });
    expect(bobs).toMatchObject({ outcome: 'started', child: { principal: 'bob' } });
    expect(ownersByHost).toMatchObject({ outcome: 'started', child: { principal: 'owner' } });
    expect(alicesUnderOwner).toEqual({ outcome: 'not-found' });
    expect(readAsBob).toEqual({
      get: undefined,
      list: [expect.objectContaining({ childRunId: 'bobs-helper' })],
      wait: { outcome: 'not-found' },
      cancel: { outcome: 'not-found' },
    });
    expect(readAsAlice).toMatchObject({ childRunId: 'alices-helper', status: 'running' });
    expect(readByHost).toMatchObject({ childRunId: 'alices-helper', principal: 'alice' });
    expect(ownersAsAlice).toBeUndefined();
  });
});

describe('packages/bureau/README.md — delegation grants for children', () => {
  it('issues attenuated grants and rejects depth, budget, and authority escalation', async () => {
    // The host loads this from its secret store; it must be the same across restarts.
    const delegationSecret = 'test-only-delegation-secret';

    const planner = createAgent({ name: 'planner', generate: untilAborted });

    const bureau = await createBureau({
      agents: { planner },
      storage: { type: 'sqlite', path: databasePath },
      children: { delegation: { secret: delegationSecret } },
    });

    const root = bureau.run('planner', 'Plan the corvid report');
    const parentRunId = await durableRunId(bureau, root);

    const lead = await bureau.children.dispatch({
      parentRunId,
      agentName: 'planner',
      input: 'Lead the research',
      childRunId: 'lead',
      authority: {
        depth: 1,
        budget: { concurrentChildren: 1 },
        capabilities: { tools: ['search'] },
      },
    });
    // { outcome: 'started', child, grant: { grantId, policyVersion: 'bureau-delegation/1', depth: 1, expiresAt } }

    const helper = await bureau.children.dispatch({
      parentRunId: 'lead',
      agentName: 'planner',
      input: 'Collect sources',
      childRunId: 'helper',
    });
    // { outcome: 'started', grant: { depth: 0, ... } } — attenuated from lead's grant

    const widened = await bureau.children.dispatch({
      parentRunId: 'lead',
      agentName: 'planner',
      input: 'Run a shell command',
      authority: { capabilities: { tools: ['shell'] } },
    });
    // { outcome: 'rejected', code: 'authority-exceeded' }

    const secondHelper = await bureau.children.dispatch({
      parentRunId: 'lead',
      agentName: 'planner',
      input: 'Collect more sources',
    });
    // { outcome: 'rejected', code: 'budget-exhausted' } — lead allows one concurrent child

    const grandchild = await bureau.children.dispatch({
      parentRunId: 'helper',
      agentName: 'planner',
      input: 'Go one level deeper',
    });
    // { outcome: 'rejected', code: 'depth-exhausted' }

    root.abort('report planned');
    await bureau.children.wait({ parentRunId: 'lead', childRunId: 'helper' });
    await bureau.dispose();

    expect(lead).toMatchObject({
      outcome: 'started',
      child: { childRunId: 'lead', grantId: expect.any(String) },
      grant: { policyVersion: 'bureau-delegation/1', depth: 1, expiresAt: expect.any(Number) },
    });
    // The default `'redacted'` disclosure policy keeps the budget out of the summary.
    expect(lead.outcome === 'started' ? lead.grant?.budget : 'not started').toBeUndefined();
    expect(helper).toMatchObject({ outcome: 'started', grant: { depth: 0 } });
    expect(widened).toMatchObject({ outcome: 'rejected', code: 'authority-exceeded' });
    expect(secondHelper).toMatchObject({ outcome: 'rejected', code: 'budget-exhausted' });
    expect(grandchild).toMatchObject({ outcome: 'rejected', code: 'depth-exhausted' });
  });
});
