/**
 * COR-772 — `bureau.children` end to end, over a real `createBureau`.
 *
 * The crash-and-recovery tests follow the same cross-process pattern as the
 * AB-240 catalog-recovery tests in `create-bureau.test.ts`: bureau A runs
 * until a durable step has checkpointed and then "dies" (its generate never
 * resolves and it is deliberately not disposed), and bureau B boots over the
 * same SQLite file. Everything B knows about A's children it learns from
 * storage.
 */
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createAgent,
  createLazyAgent,
  createMockGenerate,
  defineChildSignals,
  type GenerateFunction,
  readParentSignals,
  stopWhen,
  type Toolbox,
} from '@lostgradient/operative';
import {
  type ConditionalTextValueStore,
  decode,
  MemoryStorage,
  resolveStorage,
  textValueStore,
  yieldToPortableEventLoop,
} from '@lostgradient/weft';
import { createTool, createToolbox } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { BureauError, createBureau } from './create-bureau';
import { CATALOG_RUN_RECOVERY_KEY_PREFIX } from './runtime-composition';
import { rejectionOf, throwingRejectionOf } from './testing/promise-outcome.test-support.ts';
import type { Bureau, BureauDiagnostic } from './types';

let databaseCounter = 0;

/**
 * Every bureau here reports into this sink instead of the console. Disposing
 * a bureau while a recovered run is still in flight is expected to produce
 * recovery diagnostics; the child topology itself must produce none.
 */
let diagnostics: BureauDiagnostic[] = [];
const onDiagnostic = (diagnostic: BureauDiagnostic): void => {
  diagnostics.push(diagnostic);
};

afterEach(async () => {
  await yieldToPortableEventLoop();
  expect(diagnostics.filter((diagnostic) => diagnostic.scope === 'child-topology')).toEqual([]);
  diagnostics = [];
});

async function pollUntil(
  check: () => boolean | Promise<boolean>,
  attempts = 200,
): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (await check()) return true;
    await yieldToPortableEventLoop();
  }
  return check();
}

function databasePath(label: string): string {
  return join(tmpdir(), `bureau-children-${label}-${process.pid}-${databaseCounter++}.sqlite`);
}

async function removeDatabase(path: string): Promise<void> {
  await rm(path, { force: true });
  await rm(`${path}-wal`, { force: true });
  await rm(`${path}-shm`, { force: true });
}

const proceedSignals = defineChildSignals({
  signals: { proceed: z.object({ note: z.string() }) },
  events: {},
});

/** A tool that blocks until the parent sends `proceed`, then reports the note. */
function createAwaitParentTool() {
  return createTool({
    name: 'await-parent',
    description: 'Waits for the parent to say proceed.',
    input: z.object({}),
    async execute(_input, toolContext) {
      const port = readParentSignals(toolContext.executionContext, proceedSignals);
      if (!port) return 'no parent port';
      return new Promise<string>((resolve) => {
        port.onSignal('proceed', (message) => {
          resolve(`parent said ${message.payload.note}`);
        });
      });
    },
  });
}

function createNextTool() {
  return createTool({
    name: 'next',
    description: 'continue',
    input: z.object({}),
    execute: async () => 'ok',
  });
}

function hang(): Promise<never> {
  return new Promise<never>(() => {});
}

/** Never answers, but stops when its run is aborted — as a real provider call does. */
const hangUntilAborted: GenerateFunction = ({ signal }) =>
  new Promise((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });

function createEmptyToolbox(): Toolbox {
  return createToolbox([]) as unknown as Toolbox;
}

function completingWorker(content = 'child done') {
  return createAgent({
    name: 'worker',
    generate: async () => ({ content, toolCalls: [] }),
    stopWhen: stopWhen.noToolCalls(),
  });
}

function hangingWorker() {
  return createAgent({
    name: 'hanging-worker',
    generate: hangUntilAborted,
    stopWhen: stopWhen.noToolCalls(),
  });
}

/** Steps 0 through `hangAt - 1` call `next`; step `hangAt` never returns. */
function hangingAtStep(
  hangAt: number,
  onStep: (step: number) => void = () => {},
): GenerateFunction {
  return async ({ step }) => {
    onStep(step);
    if (step < hangAt)
      return { content: `step ${step}`, toolCalls: [{ name: 'next', arguments: {} }] };
    return hang();
  };
}

// ---------------------------------------------------------------------------
// An ephemeral bureau: createRun parents, process-local children
// ---------------------------------------------------------------------------

describe('bureau.children over an ephemeral bureau', () => {
  async function createParentBureau(agents: Parameters<typeof createBureau>[0]['agents']) {
    const bureau = await createBureau({
      agents,
      generate: () => hang(),
      toolbox: createEmptyToolbox(),
      children: { signals: { worker: proceedSignals } },
      onDiagnostic,
    });
    const parent = await bureau.createRun({ message: 'plan the work' });
    return { bureau, parent };
  }

  it('dispatches, lists, gets, and waits on a child of a createRun parent', async () => {
    const { bureau, parent } = await createParentBureau({ worker: completingWorker() });

    try {
      const dispatched = await bureau.children.dispatch({
        parentRunId: parent.id,
        agentName: 'worker',
        input: 'do the work',
      });
      if (dispatched.outcome !== 'started') throw new Error('expected a started child');
      const reference = { parentRunId: parent.id, childRunId: dispatched.child.childRunId };

      expect(dispatched.child).toMatchObject({
        parentRunId: parent.id,
        parentAgentName: 'bureau',
        childAgentName: 'worker',
        status: 'running',
        workflow: { kind: 'process-local' },
        parentCancellation: 'cascade',
      });
      expect(typeof dispatched.child.createdAt).toBe('number');
      expect(await bureau.children.wait(reference)).toMatchObject({
        outcome: 'settled',
        child: {
          status: 'completed',
          outcome: { finishReason: 'stop-condition', content: 'child done' },
        },
      });
      expect(await bureau.children.list(parent.id)).toEqual([
        expect.objectContaining({ childRunId: reference.childRunId, status: 'completed' }),
      ]);
      expect(await bureau.children.get(reference)).toMatchObject({ status: 'completed' });
    } finally {
      await bureau.dispose();
    }
  });

  it('never lets an unrelated parent inspect, wait on, signal, or cancel another parent’s child', async () => {
    const { bureau, parent } = await createParentBureau({ worker: hangingWorker() });
    const other = await bureau.createRun({ message: 'another plan' });

    try {
      const dispatched = await bureau.children.dispatch({
        parentRunId: parent.id,
        agentName: 'worker',
        input: 'x',
      });
      if (dispatched.outcome !== 'started') throw new Error('expected a started child');
      const foreign = { parentRunId: other.id, childRunId: dispatched.child.childRunId };

      expect(await bureau.children.get(foreign)).toBeUndefined();
      expect(await bureau.children.list(other.id)).toEqual([]);
      expect(await bureau.children.wait(foreign)).toEqual({ outcome: 'not-found' });
      expect(await bureau.children.signal({ ...foreign, name: 'proceed', payload: {} })).toEqual({
        outcome: 'not-found',
      });
      expect(await bureau.children.cancel(foreign)).toEqual({ outcome: 'not-found' });
      expect(
        await bureau.children.get({
          parentRunId: parent.id,
          childRunId: dispatched.child.childRunId,
        }),
      ).toMatchObject({ status: 'running' });
      expect(
        await bureau.children.dispatch({
          parentRunId: 'no-such-run',
          agentName: 'worker',
          input: 'x',
        }),
      ).toEqual({ outcome: 'not-found' });
    } finally {
      await bureau.dispose();
    }
  });

  it('applies each child’s parent-cancellation policy when the parent is aborted, not a shared signal', async () => {
    const { bureau, parent } = await createParentBureau({ worker: hangingWorker() });

    try {
      const cascade = await bureau.children.dispatch({
        parentRunId: parent.id,
        agentName: 'worker',
        input: 'x',
        childRunId: 'cascade-child',
      });
      const detach = await bureau.children.dispatch({
        parentRunId: parent.id,
        agentName: 'worker',
        input: 'x',
        childRunId: 'detached-child',
        parentCancellation: 'detach',
      });
      expect([cascade.outcome, detach.outcome]).toEqual(['started', 'started']);

      bureau.abortRun(parent.id);

      expect(
        await bureau.children.wait({ parentRunId: parent.id, childRunId: 'cascade-child' }),
      ).toMatchObject({
        outcome: 'settled',
        child: { status: 'aborted', outcome: { reason: expect.stringContaining('cancelled') } },
      });
      expect(
        await bureau.children.get({ parentRunId: parent.id, childRunId: 'detached-child' }),
      ).toMatchObject({ status: 'running' });

      expect(
        await bureau.children.cancel({
          parentRunId: parent.id,
          childRunId: 'detached-child',
          reason: 'cleaning up',
        }),
      ).toMatchObject({ outcome: 'requested' });
      expect(
        await bureau.children.wait({ parentRunId: parent.id, childRunId: 'detached-child' }),
      ).toMatchObject({ child: { status: 'aborted', outcome: { reason: 'cleaning up' } } });
    } finally {
      await bureau.dispose();
    }
  });

  it('refuses a child under a createRun parent that abortRun has not finished tearing down', async () => {
    const { bureau, parent } = await createParentBureau({ worker: hangingWorker() });

    try {
      expect(bureau.abortRun(parent.id)).toMatchObject({ status: 'aborting' });
      expect(bureau.getRun(parent.id)).toMatchObject({ status: 'running' });

      expect(
        await bureau.children.dispatch({
          parentRunId: parent.id,
          agentName: 'worker',
          input: 'x',
          childRunId: 'late',
        }),
      ).toMatchObject({ outcome: 'rejected', code: 'parent-terminal' });
      expect(await bureau.children.list(parent.id)).toEqual([]);
    } finally {
      await bureau.dispose();
    }
  });

  it('treats a repeated dispatch of the same child as a duplicate and starts it once', async () => {
    let generations = 0;
    const worker = createAgent({
      name: 'worker',
      generate: (context) => {
        generations += 1;
        return hangUntilAborted(context);
      },
      stopWhen: stopWhen.noToolCalls(),
    });
    const { bureau, parent } = await createParentBureau({ worker });

    try {
      const request = {
        parentRunId: parent.id,
        agentName: 'worker' as const,
        input: 'x',
        childRunId: 'only-once',
      };
      const first = await bureau.children.dispatch(request);
      const second = await bureau.children.dispatch(request);

      expect(first.outcome).toBe('started');
      expect(second).toMatchObject({ outcome: 'duplicate', child: { childRunId: 'only-once' } });
      await pollUntil(() => generations > 0);
      expect(generations).toBe(1);
    } finally {
      await bureau.dispose();
    }
  });

  it('delivers a typed signal to the child and returns its acknowledgement', async () => {
    const worker = createAgent({
      name: 'worker',
      generate: createMockGenerate([
        { content: '', toolCalls: [{ id: 'call-1', name: 'await-parent', arguments: {} }] },
        { content: 'finished after the signal', toolCalls: [] },
      ]),
      toolbox: createToolbox([createAwaitParentTool()]),
      stopWhen: stopWhen.noToolCalls(),
    });
    const { bureau, parent } = await createParentBureau({ worker });

    try {
      const dispatched = await bureau.children.dispatch({
        parentRunId: parent.id,
        agentName: 'worker',
        input: 'wait for me',
      });
      if (dispatched.outcome !== 'started') throw new Error('expected a started child');
      const reference = { parentRunId: parent.id, childRunId: dispatched.child.childRunId };

      expect(
        await bureau.children.signal({ ...reference, name: 'proceed', payload: { note: 7 } }),
      ).toMatchObject({ outcome: 'rejected', code: 'invalid-payload' });
      expect(
        await bureau.children.signal({ ...reference, name: 'proceed', payload: { note: 'go' } }),
      ).toMatchObject({ outcome: 'acknowledged' });
      expect(await bureau.children.wait(reference)).toMatchObject({
        child: { status: 'completed', outcome: { content: 'finished after the signal' } },
      });
    } finally {
      await bureau.dispose();
    }
  });

  it('lets a child own children of its own', async () => {
    const { bureau, parent } = await createParentBureau({
      worker: completingWorker(),
      planner: hangingWorker(),
    });

    try {
      await bureau.children.dispatch({
        parentRunId: parent.id,
        agentName: 'planner',
        input: 'x',
        childRunId: 'middle',
      });
      const grandchild = await bureau.children.dispatch({
        parentRunId: 'middle',
        agentName: 'worker',
        input: 'y',
      });

      expect(grandchild).toMatchObject({
        outcome: 'started',
        child: { parentRunId: 'middle', parentAgentName: 'planner' },
      });
      await bureau.children.cancel({ parentRunId: parent.id, childRunId: 'middle' });
      await bureau.children.wait({ parentRunId: parent.id, childRunId: 'middle' });
      expect(
        await bureau.children.dispatch({ parentRunId: 'middle', agentName: 'worker', input: 'z' }),
      ).toMatchObject({ outcome: 'rejected', code: 'parent-terminal' });
    } finally {
      await bureau.dispose();
    }
  });

  it('diagnoses an unreadable child record instead of trusting it', async () => {
    const bureau = await createBureau({
      agents: {},
      storage: { type: 'memory' },
      onDiagnostic,
    });

    try {
      await bureau.kv?.set('bureau-child:record:garbled', '{"schemaVersion":1}');

      expect(
        await bureau.children.get({ parentRunId: 'anyone', childRunId: 'garbled' }),
      ).toBeUndefined();
      expect(diagnostics).toContainEqual(
        expect.objectContaining({
          scope: 'child-topology',
          message: expect.stringContaining('bureau-child:record:garbled'),
        }),
      );
      // Expected here; the suite-wide check below is for the other tests.
      diagnostics = [];
    } finally {
      await bureau.dispose();
    }
  });

  it('still boots, and says so, when the child topology cannot be loaded for recovery', async () => {
    const base = textValueStore(new MemoryStorage());
    const failing: ConditionalTextValueStore = {
      ...base,
      list: (prefix) =>
        prefix.startsWith('bureau-child:')
          ? Promise.reject(new Error('child index offline'))
          : base.list(prefix),
    };
    const bureau = await createBureau({ agents: {}, persistence: failing, onDiagnostic });

    try {
      expect(diagnostics).toContainEqual(
        expect.objectContaining({
          scope: 'recovery',
          message: expect.stringContaining('child index offline'),
        }),
      );
      diagnostics = [];
    } finally {
      await bureau.dispose();
    }
  });

  it('rejects an empty delegation secret at construction', async () => {
    expect(
      await rejectionOf(createBureau({ agents: {}, children: { delegation: { secret: '' } } })),
    ).toBeInstanceOf(BureauError);
    expect(
      await throwingRejectionOf(
        createBureau({
          agents: {},
          children: { delegation: { secret: 's', defaultTimeToLiveMilliseconds: 0 } },
        }),
      ),
    ).toThrow('defaultTimeToLiveMilliseconds');
  });
});

// ---------------------------------------------------------------------------
// A durable bureau: bureau.run parents, durable children
// ---------------------------------------------------------------------------

describe('bureau.children over a durable bureau', () => {
  /** The first durable `bureau.run` run not in `known` once it has started. */
  async function startedDurableRun(
    bureau: Pick<Bureau, 'listDurableRuns'>,
    known: readonly string[] = [],
  ): Promise<string> {
    let runId: string | undefined;
    await pollUntil(async () => {
      const runs = await bureau.listDurableRuns();
      runId = runs?.items.find(
        (item) => item.id.startsWith('agent-run-') && !known.includes(item.id),
      )?.id;
      return runId !== undefined;
    });
    if (runId === undefined) throw new Error('the durable run never started');
    return runId;
  }

  function hangingAgents() {
    return {
      planner: createAgent({
        name: 'planner',
        generate: hangUntilAborted,
        stopWhen: stopWhen.noToolCalls(),
      }),
      worker: createAgent({
        name: 'worker',
        generate: hangUntilAborted,
        stopWhen: stopWhen.noToolCalls(),
      }),
    };
  }

  it('refuses a child identifier that names another principal’s run, and leaves that run as it was', async () => {
    const path = databasePath('foreign-run-id');
    // Owned here so the catalog recovery record can be read back byte for byte.
    const storage = await resolveStorage({ type: 'sqlite', path });
    const bureau = await createBureau({
      agents: hangingAgents(),
      storage,
      durableExecution: true,
      onDiagnostic,
    });

    try {
      bureau.run('worker', 'alice’s private work', { principal: 'alice' });
      const aliceRunId = await startedDurableRun(bureau);
      bureau.run('planner', 'mallory’s plan', { principal: 'mallory' });
      const malloryRunId = await startedDurableRun(bureau, [aliceRunId]);
      const recoveryKey = `${CATALOG_RUN_RECOVERY_KEY_PREFIX}${aliceRunId}`;
      const recoveryRecord = decode((await storage.get(recoveryKey))!);
      expect(recoveryRecord).toMatchObject({ agentName: 'worker', principal: 'alice' });
      const history = (principal: string) =>
        bureau.eventHistory({ kind: 'run', id: aliceRunId }, { principal });
      expect(await history('alice')).not.toEqual({ outcome: 'not-found' });
      expect(await history('mallory')).toEqual({ outcome: 'not-found' });

      expect(
        await bureau.children.dispatch({
          parentRunId: malloryRunId,
          agentName: 'worker',
          input: 'mallory’s input',
          childRunId: aliceRunId,
          principal: 'mallory',
        }),
      ).toMatchObject({ outcome: 'rejected', code: 'child-run-id-conflict' });

      expect(await history('alice')).not.toEqual({ outcome: 'not-found' });
      expect(await history('mallory')).toEqual({ outcome: 'not-found' });
      expect(decode((await storage.get(recoveryKey))!)).toEqual(recoveryRecord);
      expect(await bureau.children.list(malloryRunId)).toEqual([]);
      expect(await bureau.getDurableRun(aliceRunId)).toMatchObject({ status: 'running' });
      // Alice's run is still the parent Bureau knows by that identifier.
      expect(
        await bureau.children.dispatch({
          parentRunId: aliceRunId,
          agentName: 'worker',
          input: 'alice’s sub-task',
          principal: 'alice',
        }),
      ).toMatchObject({
        outcome: 'started',
        child: { parentAgentName: 'worker', principal: 'alice' },
      });
    } finally {
      await bureau.dispose();
      storage[Symbol.dispose]();
      await removeDatabase(path);
    }
  });

  it('applies the parent-cancellation policy when a bureau.run parent is aborted through its own handle', async () => {
    const bureau = await createBureau({
      agents: hangingAgents(),
      storage: { type: 'memory' },
      durableExecution: true,
      onDiagnostic,
    });

    try {
      const parent = bureau.run('planner', 'plan');
      const parentRunId = await startedDurableRun(bureau);
      const dispatch = (childRunId: string, parentCancellation: 'cascade' | 'detach') =>
        bureau.children.dispatch({
          parentRunId,
          agentName: 'worker',
          input: 'work',
          childRunId,
          parentCancellation,
        });
      expect(await dispatch('cascade-child', 'cascade')).toMatchObject({ outcome: 'started' });
      expect(await dispatch('detached-child', 'detach')).toMatchObject({ outcome: 'started' });

      parent.abort('the planner changed its mind');

      expect(await parent.result()).toMatchObject({ finishReason: 'aborted' });
      expect(
        await bureau.children.wait({ parentRunId, childRunId: 'cascade-child' }),
      ).toMatchObject({
        outcome: 'settled',
        child: {
          status: 'aborted',
          outcome: { reason: expect.stringContaining('the planner changed its mind') },
        },
      });
      expect(
        await bureau.children.get({ parentRunId, childRunId: 'detached-child' }),
      ).toMatchObject({ status: 'running' });
      expect(await bureau.getDurableRun('cascade-child')).toMatchObject({ status: 'cancelled' });
      const detachedWorkflow = await bureau.getDurableRun('detached-child');
      expect(detachedWorkflow?.status).not.toBe('cancelled');
    } finally {
      await bureau.dispose();
    }
  });

  it('records child.aborted in the audit trail for a running child when the bureau is disposed under the default ownership', async () => {
    const path = databasePath('disposed-audit');
    try {
      const bureau = await createBureau({
        agents: hangingAgents(),
        storage: { type: 'sqlite', path },
        durableExecution: true,
        onDiagnostic,
      });

      const parent = bureau.run('planner', 'plan');
      const parentRunId = await startedDurableRun(bureau);
      expect(
        await bureau.children.dispatch({
          parentRunId,
          agentName: 'worker',
          input: 'work',
          childRunId: 'disposed-child',
          parentCancellation: 'detach',
        }),
      ).toMatchObject({ outcome: 'started' });
      parent.abort('done');
      await parent.result();

      await bureau.dispose();
      await yieldToPortableEventLoop();

      expect(
        diagnostics.filter((diagnostic) => diagnostic.message.includes('audit trail')),
      ).toEqual([]);
      expect(diagnostics.filter((diagnostic) => diagnostic.scope === 'child-topology')).toEqual([]);

      const second = await createBureau({
        agents: hangingAgents(),
        storage: { type: 'sqlite', path },
        durableExecution: true,
        onDiagnostic,
      });
      try {
        const records = await second.auditTrail?.query({ runId: 'disposed-child' });
        const aborted = records?.filter((record) => record.type === 'child.aborted');
        expect(aborted).toHaveLength(1);
        expect(
          await second.children.get({ parentRunId, childRunId: 'disposed-child' }),
        ).toMatchObject({ status: 'aborted' });
      } finally {
        await second.dispose();
      }
    } finally {
      await removeDatabase(path);
    }
  });

  it('runs a createLazyAgent parent and child durably, as it does createAgent ones', async () => {
    const lazyHanging = (name: string) =>
      createLazyAgent(async () =>
        createAgent({ name, generate: hangUntilAborted, stopWhen: stopWhen.noToolCalls() }),
      );
    const bureau = await createBureau({
      agents: { planner: lazyHanging('planner'), worker: lazyHanging('worker') },
      storage: { type: 'memory' },
      durableExecution: true,
      onDiagnostic,
    });

    try {
      const plannerRun = bureau.run('planner', 'plan');
      const parentRunId = await startedDurableRun(bureau);
      // Its handle names the same durable run, as a createAgent parent's does.
      expect(await pollUntil(() => plannerRun.snapshot().id === parentRunId)).toBe(true);
      expect(plannerRun.snapshot().durability).toBe('durable');

      expect(
        await bureau.children.dispatch({
          parentRunId,
          agentName: 'worker',
          input: 'work',
          childRunId: 'lazy-child',
        }),
      ).toMatchObject({
        outcome: 'started',
        child: {
          parentAgentName: 'planner',
          workflow: { kind: 'durable', workflowType: 'agentRun', workflowId: 'lazy-child' },
        },
      });
      expect(
        await pollUntil(async () => {
          const workflow = await bureau.getDurableRun('lazy-child');
          return workflow?.status === 'running';
        }),
      ).toBe(true);
    } finally {
      await bureau.dispose();
    }
  });

  it('refuses a grandchild under a child whose cancellation is still winding down', async () => {
    let honourAbort: (() => void) | undefined;
    // Honours its abort only once the test lets it — a tool mid-flight, say.
    const slowToAbort: GenerateFunction = ({ signal }) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener(
          'abort',
          () => {
            honourAbort = () => reject(new Error('aborted'));
          },
          { once: true },
        );
      });
    const bureau = await createBureau({
      agents: {
        ...hangingAgents(),
        slow: createAgent({
          name: 'slow',
          generate: slowToAbort,
          stopWhen: stopWhen.noToolCalls(),
        }),
      },
      storage: { type: 'memory' },
      durableExecution: true,
      onDiagnostic,
    });

    try {
      bureau.run('planner', 'plan');
      const parentRunId = await startedDurableRun(bureau);
      const middle = { parentRunId, childRunId: 'middle' };
      expect(
        await bureau.children.dispatch({ ...middle, agentName: 'slow', input: 'x' }),
      ).toMatchObject({ outcome: 'started' });
      expect(
        await pollUntil(async () => {
          const workflow = await bureau.getDurableRun('middle');
          return workflow?.status === 'running';
        }),
      ).toBe(true);

      expect(await bureau.children.cancel(middle)).toMatchObject({
        outcome: 'requested',
        child: { status: 'running' },
      });
      expect(await pollUntil(() => honourAbort !== undefined)).toBe(true);
      expect(
        await bureau.children.dispatch({
          parentRunId: 'middle',
          agentName: 'worker',
          input: 'x',
          childRunId: 'late',
        }),
      ).toMatchObject({ outcome: 'rejected', code: 'parent-terminal' });

      honourAbort?.();
      expect(await bureau.children.wait(middle)).toMatchObject({
        outcome: 'settled',
        child: { status: 'aborted' },
      });
      expect(await bureau.children.list('middle')).toEqual([]);
      expect(await bureau.getDurableRun('late')).toBeNull();
    } finally {
      await bureau.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// A durable bureau: crash, restart, and recover
// ---------------------------------------------------------------------------

describe('bureau.children across a process restart', () => {
  const delegation = { secret: 'children-secret' };

  /**
   * Bureau A: a durable `planner` parent that parks at step 1, and a durable
   * `worker` child dispatched under it that parks at step 1 too. Returns once
   * both have checkpointed step 0 — the moment A "dies".
   */
  async function crashWithChild(path: string, childRunId: string) {
    let parentAtStep1 = false;
    let childAtStep1 = false;
    const bureauA = await createBureau({
      agents: {
        planner: createAgent({
          name: 'planner',
          generate: hangingAtStep(1, (step) => (parentAtStep1 ||= step === 1)),
          toolbox: createToolbox([createNextTool()]),
          stopWhen: stopWhen.noToolCalls(),
        }),
        worker: createAgent({
          name: 'worker',
          generate: hangingAtStep(1, (step) => (childAtStep1 ||= step === 1)),
          toolbox: createToolbox([createNextTool()]),
          stopWhen: stopWhen.noToolCalls(),
        }),
      },
      storage: { type: 'sqlite', path },
      durableExecution: true,
      durableOwnership: { ownership: 'none' },
      onDiagnostic,
      children: { signals: { worker: proceedSignals }, delegation },
    });
    bureauA.run('planner', 'plan');
    await pollUntil(() => parentAtStep1);
    const runs = await bureauA.listDurableRuns();
    const parentRunId = runs?.items.find((item) => item.id.startsWith('agent-run-'))?.id;
    if (parentRunId === undefined) throw new Error('parent run was not checkpointed');

    const dispatched = await bureauA.children.dispatch({
      parentRunId,
      agentName: 'worker',
      input: 'work',
      childRunId,
      authority: { depth: 1 },
    });
    expect(dispatched).toMatchObject({
      outcome: 'started',
      child: {
        parentAgentName: 'planner',
        workflow: { kind: 'durable', workflowType: 'agentRun', workflowId: childRunId },
      },
      grant: { depth: 1 },
    });
    await pollUntil(() => childAtStep1);
    expect(childAtStep1).toBe(true);
    return { bureauA, parentRunId };
  }

  it('reattaches a running child without a duplicate workflow, and the parent can signal and await it', async () => {
    const path = databasePath('reattach');
    const childRunId = 'child-reattach';
    try {
      const { bureauA, parentRunId } = await crashWithChild(path, childRunId);
      const reference = { parentRunId, childRunId };

      const childSteps: number[] = [];
      const bureauB = await createBureau({
        agents: {
          planner: createAgent({
            name: 'planner',
            generate: () => hang(),
            toolbox: createToolbox([createNextTool()]),
            stopWhen: stopWhen.noToolCalls(),
          }),
          worker: createAgent({
            name: 'worker',
            generate: async ({ step }) => {
              childSteps.push(step);
              return step === 1
                ? { content: '', toolCalls: [{ name: 'await-parent', arguments: {} }] }
                : { content: 'finished after the restart', toolCalls: [] };
            },
            toolbox: createToolbox([createNextTool(), createAwaitParentTool()]),
            stopWhen: stopWhen.noToolCalls(),
          }),
        },
        storage: { type: 'sqlite', path },
        durableExecution: true,
        durableOwnership: { ownership: 'none' },
        onDiagnostic,
        children: { signals: { worker: proceedSignals }, delegation },
      });

      try {
        expect(await bureauB.children.get(reference)).toMatchObject({
          status: 'running',
          recoveries: 1,
          workflow: { kind: 'durable', workflowId: childRunId },
        });
        const durableRuns = await bureauB.listDurableRuns();
        expect(durableRuns?.items.filter((item) => item.id === childRunId)).toHaveLength(1);

        expect(
          await bureauB.children.signal({ ...reference, name: 'proceed', payload: { note: 'go' } }),
        ).toMatchObject({ outcome: 'acknowledged' });
        expect(await bureauB.children.wait(reference)).toMatchObject({
          outcome: 'settled',
          child: { status: 'completed', outcome: { content: 'finished after the restart' } },
        });
        // Resumed at the checkpointed step 1 — never restarted from step 0.
        expect(childSteps).toEqual([1, 2]);

        const audit = await bureauB.auditTrail?.query({ runId: childRunId });
        expect(audit?.map((record) => record.type)).toEqual([
          'child.started',
          'child.reattached',
          'child.completed',
        ]);
      } finally {
        await bureauB.dispose();
      }

      // Bureau A was still holding the child's old in-process run. Disposing it
      // aborts that run, and its late terminal write is a stale update: the
      // record keeps the outcome bureau B recorded, and no second transition
      // reaches the audit trail.
      await bureauA.dispose();
      const bureauC = await createBureau({
        agents: {},
        storage: { type: 'sqlite', path },
        durableExecution: true,
        durableOwnership: { ownership: 'none' },
        onDiagnostic,
      });
      try {
        expect(await bureauC.children.get(reference)).toMatchObject({
          status: 'completed',
          outcome: { content: 'finished after the restart' },
        });
        const audit = await bureauC.auditTrail?.query({ runId: childRunId });
        expect(audit?.filter((record) => record.type === 'child.aborted')).toEqual([]);
      } finally {
        await bureauC.dispose();
      }
    } finally {
      await removeDatabase(path);
    }
  });

  it('records a child that finished while its parent was unavailable with its real outcome', async () => {
    const path = databasePath('finished-alone');
    const childRunId = 'child-finished-alone';
    try {
      const { bureauA, parentRunId } = await crashWithChild(path, childRunId);
      const bureauB = await createBureau({
        agents: {
          planner: createAgent({
            name: 'planner',
            generate: () => hang(),
            toolbox: createToolbox([createNextTool()]),
            stopWhen: stopWhen.noToolCalls(),
          }),
          worker: createAgent({
            name: 'worker',
            generate: async () => ({ content: 'finished with nobody watching', toolCalls: [] }),
            toolbox: createToolbox([createNextTool()]),
            stopWhen: stopWhen.noToolCalls(),
          }),
        },
        storage: { type: 'sqlite', path },
        durableExecution: true,
        durableOwnership: { ownership: 'none' },
        onDiagnostic,
        children: { delegation },
      });

      try {
        expect(await bureauB.children.wait({ parentRunId, childRunId })).toMatchObject({
          outcome: 'settled',
          child: { status: 'completed', outcome: { content: 'finished with nobody watching' } },
        });
        const audit = await bureauB.auditTrail?.query({ runId: childRunId });
        expect(audit?.filter((record) => record.type === 'child.completed')).toHaveLength(1);
      } finally {
        await bureauB.dispose();
      }
      await bureauA.dispose();
    } finally {
      await removeDatabase(path);
    }
  });

  it('denies and cancels a recovered child whose grant no longer verifies', async () => {
    const path = databasePath('grant-rotated');
    const childRunId = 'child-grant-rotated';
    try {
      const { bureauA, parentRunId } = await crashWithChild(path, childRunId);
      const bureauB = await createBureau({
        agents: {
          planner: createAgent({
            name: 'planner',
            generate: () => hang(),
            toolbox: createToolbox([createNextTool()]),
            stopWhen: stopWhen.noToolCalls(),
          }),
          worker: createAgent({
            name: 'worker',
            generate: () => hang(),
            toolbox: createToolbox([createNextTool()]),
            stopWhen: stopWhen.noToolCalls(),
          }),
        },
        storage: { type: 'sqlite', path },
        durableExecution: true,
        durableOwnership: { ownership: 'none' },
        onDiagnostic,
        // A different secret: every grant signed under the old one fails verification.
        children: { delegation: { secret: 'rotated-without-migration' } },
      });

      try {
        expect(await bureauB.children.get({ parentRunId, childRunId })).toMatchObject({
          status: 'aborted',
          outcome: { reason: expect.stringContaining('invalid-signature') },
        });
        const audit = await bureauB.auditTrail?.query({ runId: childRunId });
        expect(
          audit
            ?.map((record) => record.type)
            .filter((type) => type.startsWith('child.') || type.startsWith('delegation.')),
        ).toEqual(['child.started', 'delegation.rejected', 'child.aborted']);
        const durableChild = await bureauB.getDurableRun(childRunId);
        expect(durableChild?.status).toBe('cancelled');
      } finally {
        await bureauB.dispose();
      }
      await bureauA.dispose();
    } finally {
      await removeDatabase(path);
    }
  });

  it('cascades a committed cancelDurableRun of the parent to its cascade children', async () => {
    const path = databasePath('cancel-durable');
    const childRunId = 'child-cancel-durable';
    try {
      const { bureauA, parentRunId } = await crashWithChild(path, childRunId);
      try {
        expect(await bureauA.cancelDurableRun(parentRunId)).toEqual({ status: 'requested' });
        expect(await bureauA.children.wait({ parentRunId, childRunId })).toMatchObject({
          child: { status: 'aborted', outcome: { reason: expect.stringContaining(parentRunId) } },
        });
      } finally {
        await bureauA.dispose();
      }
    } finally {
      await removeDatabase(path);
    }
  });
});
