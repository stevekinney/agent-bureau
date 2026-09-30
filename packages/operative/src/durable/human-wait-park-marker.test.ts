// COR-121 — isolation coverage for the replay-aware human-wait park marker:
// where it fires, where it must stay silent, and that it never leaks to a user
// `onLog` or the console.
import {
  Engine,
  MemoryStorage,
  textValueStore,
  workflow,
  type Storage,
  type WorkflowLogRecord,
} from '@lostgradient/weft';
import { createToolbox } from 'armorer';
import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { Conversation, createConversationHistory } from 'conversationalist';

import { HumanWaitParkedEvent } from '../events';
import { waitForCondition } from '../test/wait';
import { createRecoveredRunEventSurface } from './active-run-event-surface';
import { createCheckpointStore } from './checkpoint-store';
import { createRunEngine } from './create-run-engine';
import { HUMAN_WAIT_PARKED_LOG_MARKER } from './human-wait-park-marker';
import { runWorkflowPark } from './run-workflow-park';
import { createStorageActivities } from './storage-activities';
import type { DurableRunDeps } from './types';

const RUN_ID = 'marker-run';
const PARK_SIGNAL = 'human-response';
const HANG_SIGNAL = 'never-delivered';

interface CapturedEmitter {
  dispatch: (event: Event) => boolean;
  events: HumanWaitParkedEvent[];
}

function capturingEmitter(): CapturedEmitter {
  const events: HumanWaitParkedEvent[] = [];
  return {
    events,
    dispatch: (event) => {
      if (event instanceof HumanWaitParkedEvent) events.push(event);
      return true;
    },
  };
}

function servicesFor(emitter: CapturedEmitter, recoveredRun: boolean): DurableRunDeps {
  return {
    options: {},
    toolbox: {},
    emitter,
    ...(recoveredRun ? { recoveredRun: true } : {}),
  } as unknown as DurableRunDeps;
}

function makeParkWorkflow(storage: Storage, options: { hangAfterPark: boolean }) {
  const activities = createStorageActivities(
    createCheckpointStore(textValueStore(storage, { disposeUnderlyingStorage: false })),
  );
  return workflow({ name: 'agentRun' })
    .activities(activities)
    .execute(async function* (ctx) {
      ctx.log?.info('other record', { probe: true });
      const state = {
        snapshot: new Conversation(createConversationHistory()).snapshot(),
        cursor: { step: 1 },
        finishReason: 'maximum-steps',
        stoppedEarly: false,
        runId: RUN_ID,
        pendingHumanWait: { signalName: PARK_SIGNAL, prompt: 'Approve?' },
      };
      const parked = yield* runWorkflowPark(
        ctx,
        state as unknown as Parameters<typeof runWorkflowPark>[1],
      );
      if (options.hangAfterPark) {
        ctx.log?.info('past the park');
        yield* ctx.waitForSignal(HANG_SIGNAL);
      }
      return { parked };
    });
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function consoleSpies() {
  const spies = (['debug', 'info', 'warn', 'error'] as const).map((level) => {
    const spy = spyOn(console, level).mockImplementation(() => {});
    cleanups.push(() => spy.mockRestore());
    return spy;
  });
  return spies;
}

function markerReachedConsole(spies: ReturnType<typeof consoleSpies>): boolean {
  return spies.some((spy) =>
    spy.mock.calls.some((call) =>
      call.some(
        (argument) =>
          typeof argument === 'object' &&
          argument !== null &&
          (argument as WorkflowLogRecord).message === HUMAN_WAIT_PARKED_LOG_MARKER,
      ),
    ),
  );
}

describe('human-wait park marker routing (COR-121)', () => {
  it('dispatches once on a recovered run, forwards other records to onLog, and withholds the marker', async () => {
    const storage = new MemoryStorage();
    const records: WorkflowLogRecord[] = [];
    const emitter = capturingEmitter();
    const { engine } = await createRunEngine({
      storage,
      runWorkflow: makeParkWorkflow(storage, { hangAfterPark: false }),
      recover: false,
      onLog: (record) => {
        records.push(record);
      },
    });
    cleanups.push(() => engine[Symbol.dispose]());

    const handle = await engine.start(
      'agentRun',
      {},
      { id: RUN_ID, services: servicesFor(emitter, true) },
    );
    await waitForCondition(() => emitter.events.length === 1, 'expected the marker to dispatch');
    expect(emitter.events[0]?.signalName).toBe(PARK_SIGNAL);
    expect(emitter.events[0]?.runId).toBe(RUN_ID);
    expect(emitter.events[0]?.prompt).toBe('Approve?');

    await engine.signal(RUN_ID, PARK_SIGNAL, { approved: true });
    expect(await handle.result()).toEqual({ parked: true });

    const messages = new Set(records.map((record) => record.message));
    expect([...messages]).toEqual(['other record']);
  });

  it('routes non-marker records to the console when no onLog is given and never the marker', async () => {
    const spies = consoleSpies();
    const storage = new MemoryStorage();
    const emitter = capturingEmitter();
    const { engine } = await createRunEngine({
      storage,
      runWorkflow: makeParkWorkflow(storage, { hangAfterPark: false }),
      recover: false,
    });
    cleanups.push(() => engine[Symbol.dispose]());

    const handle = await engine.start(
      'agentRun',
      {},
      { id: RUN_ID, services: servicesFor(emitter, true) },
    );
    await waitForCondition(() => emitter.events.length === 1, 'expected the marker to dispatch');
    await engine.signal(RUN_ID, PARK_SIGNAL, { approved: true });
    await handle.result();

    const infoMessages = spies[1]!.mock.calls.flatMap((call) =>
      call.map((argument) => (argument as WorkflowLogRecord).message),
    );
    expect(infoMessages).toContain('other record');
    expect(markerReachedConsole(spies)).toBe(false);
  });

  it('a user onLog that throws does not fail the run', async () => {
    consoleSpies();
    const storage = new MemoryStorage();
    const emitter = capturingEmitter();
    const { engine } = await createRunEngine({
      storage,
      runWorkflow: makeParkWorkflow(storage, { hangAfterPark: false }),
      recover: false,
      onLog: () => {
        throw new Error('sink failure');
      },
    });
    cleanups.push(() => engine[Symbol.dispose]());

    const handle = await engine.start(
      'agentRun',
      {},
      { id: RUN_ID, services: servicesFor(emitter, true) },
    );
    await waitForCondition(() => emitter.events.length === 1, 'expected the marker to dispatch');
    await engine.signal(RUN_ID, PARK_SIGNAL, { approved: true });
    expect(await handle.result()).toEqual({ parked: true });
  });

  it('never emits for a services object without the recovered-run field (createRunEngine)', async () => {
    const spies = consoleSpies();
    const storage = new MemoryStorage();
    const emitter = capturingEmitter();
    const { engine } = await createRunEngine({
      storage,
      runWorkflow: makeParkWorkflow(storage, { hangAfterPark: false }),
      recover: false,
    });
    cleanups.push(() => engine[Symbol.dispose]());

    const handle = await engine.start(
      'agentRun',
      {},
      { id: RUN_ID, services: servicesFor(emitter, false) },
    );
    await waitForCondition(
      () => spies[1]!.mock.calls.length > 0,
      'expected the non-marker record to be logged',
    );
    await engine.signal(RUN_ID, PARK_SIGNAL, { approved: true });
    await handle.result();

    expect(emitter.events).toHaveLength(0);
    expect(markerReachedConsole(spies)).toBe(false);
  });

  it('never emits through a directly built engine whose services lack the recovered-run field', async () => {
    const spies = consoleSpies();
    const storage = new MemoryStorage();
    const emitter = capturingEmitter();
    const activities = createStorageActivities(
      createCheckpointStore(textValueStore(storage, { disposeUnderlyingStorage: false })),
    );
    const engine = await Engine.create({
      storage,
      recover: false,
      workflows: { agentRun: makeParkWorkflow(storage, { hangAfterPark: false }) },
      activities: {
        saveCursor: activities.saveCursor,
        saveConversation: activities.saveConversation,
        recordStep: activities.recordStep,
      },
    });
    cleanups.push(() => engine[Symbol.dispose]());

    const handle = await engine.start(
      'agentRun',
      {},
      { id: RUN_ID, services: servicesFor(emitter, false) },
    );
    await waitForCondition(
      () => spies[1]!.mock.calls.length > 0,
      'expected the non-marker record to reach the console',
    );
    await engine.signal(RUN_ID, PARK_SIGNAL, { approved: true });
    await handle.result();

    expect(emitter.events).toHaveLength(0);
    expect(markerReachedConsole(spies)).toBe(false);
  });
});

describe('human-wait park marker across a second engine over the same storage (COR-121)', () => {
  async function crashedEngineParkedOn(storage: Storage, deliverSignal: boolean) {
    const loggedMessages: string[] = [];
    const first = await createRunEngine({
      storage,
      // The first engine is a simulated crash and is never released, so the second must not be fenced out.
      ownership: 'none',
      runWorkflow: makeParkWorkflow(storage, { hangAfterPark: true }),
      recover: false,
      onLog: (record) => {
        loggedMessages.push(record.message);
      },
    });
    cleanups.push(() => first.engine[Symbol.dispose]());
    const emitter = capturingEmitter();
    const handle = await first.engine.start(
      'agentRun',
      {},
      { id: RUN_ID, services: servicesFor(emitter, true) },
    );
    void handle.result().catch(() => {});
    await waitForCondition(() => emitter.events.length === 1, 'expected the first engine to park');
    if (deliverSignal) {
      await first.engine.signal(RUN_ID, PARK_SIGNAL, { approved: true });
      await waitForCondition(
        () => loggedMessages.includes('past the park'),
        'expected the first engine to pass the park',
      );
    }
  }

  async function recoverOn(
    storage: Storage,
  ): Promise<{ emitter: CapturedEmitter; loggedMessages: string[] }> {
    const emitter = capturingEmitter();
    const loggedMessages: string[] = [];
    const second = await createRunEngine({
      storage,
      // The first engine is a simulated crash and is never released, so the second must not be fenced out.
      ownership: 'none',
      runWorkflow: makeParkWorkflow(storage, { hangAfterPark: true }),
      recover: false,
      onLog: (record) => {
        loggedMessages.push(record.message);
      },
      resolveWorkflowServices: () => ({
        status: 'available',
        services: servicesFor(emitter, true),
      }),
    });
    cleanups.push(() => second.engine[Symbol.dispose]());
    const handles = await second.engine.recoverAll();
    expect(handles).toHaveLength(1);
    void handles[0]?.result().catch(() => {});
    return { emitter, loggedMessages };
  }

  it('dispatches exactly once for a park that is still pending', async () => {
    const storage = new MemoryStorage();
    await crashedEngineParkedOn(storage, false);
    const { emitter } = await recoverOn(storage);
    await waitForCondition(
      () => emitter.events.length === 1,
      'expected the pending park to re-announce',
    );
    // Give any (incorrect) further dispatch a chance to land.
    for (let turn = 0; turn < 5; turn++) await Promise.resolve();
    expect(emitter.events).toHaveLength(1);
  });

  it('dispatches nothing for a park whose signal was already delivered', async () => {
    const storage = new MemoryStorage();
    await crashedEngineParkedOn(storage, true);
    const { emitter, loggedMessages } = await recoverOn(storage);
    // The 'past the park' record sits at the HANG_SIGNAL frontier, so it re-fires on
    // recovery only after replay has passed the delivered park.
    await waitForCondition(
      () => loggedMessages.includes('past the park'),
      'expected the recovered replay to pass the delivered park',
    );
    expect(emitter.events).toHaveLength(0);
  });
});

describe('createRecoveredRunEventSurface (COR-121)', () => {
  it('is the site that marks a reattached run as recovered', () => {
    const services = { options: {}, toolbox: createToolbox([]) } as unknown as DurableRunDeps;
    expect(services.recoveredRun).toBeUndefined();
    const surface = createRecoveredRunEventSurface(services, RUN_ID, 'agent');
    try {
      expect(services.recoveredRun).toBe(true);
      expect(services.emitter).toBe(surface.emitter);
    } finally {
      surface.stopToolboxForward();
    }
  });
});
