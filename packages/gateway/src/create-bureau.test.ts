import { createToolbox } from 'armorer';
import { createMockTool, createTestToolbox } from 'armorer/test';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';
import type { GenerateFunction, GenerateResponse, Toolbox } from 'operative';
import { createMockGenerate as createSequentialGenerate } from 'operative/test';
import { createStore } from 'sentinel';
import { createMemoryKeyValueStore, type KeyValueStore } from 'storage';

import { BureauError, createBureau } from './create-bureau';
import { drainMicrotasks, waitForCondition, waitForRunState } from './test';
import {
  type Bureau,
  type ConfigurationResponse,
  DEFAULT_MAXIMUM_STEPS,
  type ServerFrame,
} from './types';

type HasApiKey<T> = 'apiKey' extends keyof T ? true : false;

function createMockGenerate(content = 'Done.'): GenerateFunction {
  return async () => ({ content, toolCalls: [] });
}

function createEmptyToolbox(): Toolbox {
  return createToolbox([]) as unknown as Toolbox;
}

function createBlockingGenerate(): {
  generate: GenerateFunction;
  resolve: (response: GenerateResponse) => void;
} {
  let resolveResponse: ((response: GenerateResponse) => void) | undefined;
  const pendingResponse = new Promise<GenerateResponse>((resolve) => {
    resolveResponse = resolve;
  });

  const generate: GenerateFunction = async (context) => {
    if (context.signal?.aborted) {
      return { content: 'aborted', toolCalls: [] };
    }

    return Promise.race([
      pendingResponse,
      new Promise<GenerateResponse>((resolve) => {
        context.signal?.addEventListener(
          'abort',
          () => resolve({ content: 'aborted', toolCalls: [] }),
          { once: true },
        );
      }),
    ]);
  };

  return { generate, resolve: resolveResponse! };
}

async function waitForRunCompletion(bureau: Bureau, runId: string) {
  await waitForRunState(bureau, runId);
  await drainMicrotasks(10);
}

describe('createBureau', () => {
  it('is not ready when no generate function is configured', async () => {
    const bureau = await createBureau();
    expect(bureau.ready).toBe(false);
  });

  it('is ready when a generate function is configured', async () => {
    const bureau = await createBureau({ generate: createMockGenerate() });
    expect(bureau.ready).toBe(true);
  });

  it('uses a provided store when one is supplied', async () => {
    const store = createStore();
    const bureau = await createBureau({ store });
    expect(bureau.store).toBe(store);
  });

  it('throws NOT_CONFIGURED when createRun is called without a generate function', async () => {
    const bureau = await createBureau();

    const error = await bureau.createRun({ message: 'Hello' }).then(
      () => undefined,
      (rejection) => rejection,
    );

    expect(error).toMatchObject({
      code: 'NOT_CONFIGURED',
    });
  });

  it('throws BAD_REQUEST when createRun is called with an empty message', async () => {
    const bureau = await createBureau({ generate: createMockGenerate() });

    const error = await bureau.createRun({ message: '' }).then(
      () => undefined,
      (rejection) => rejection,
    );

    expect(error).toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  it('throws BAD_REQUEST when createRun is called with a blank session identifier', async () => {
    const bureau = await createBureau({ generate: createMockGenerate() });

    const error = await bureau.createRun({ message: 'Hello', sessionId: '   ' }).then(
      () => undefined,
      (rejection) => rejection,
    );

    expect(error).toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  it('creates runs with a session identifier and registers them in the store', async () => {
    const bureau = await createBureau({
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
    });

    const summary = await bureau.createRun({ message: 'Hello' });

    expect(summary.id).toBeString();
    expect(summary.sessionId).toBeString();
    expect(summary.status).toBe('running');
    expect(bureau.store.getRun(summary.id)).toBeDefined();
  });

  it('persists and resumes sessions through the session store', async () => {
    const bureau = await createBureau({
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
      persistence: createMemoryKeyValueStore(),
    });

    const firstRun = await bureau.createRun({ message: 'First message' });
    await waitForRunCompletion(bureau, firstRun.id);

    const secondRun = await bureau.createRun({
      message: 'Second message',
      sessionId: firstRun.sessionId,
    });
    await waitForRunCompletion(bureau, secondRun.id);

    expect(secondRun.sessionId).toBe(firstRun.sessionId);

    const session = await bureau.getSession(firstRun.sessionId);
    expect(session).toBeDefined();
    expect(session?.conversationHistory.ids.length).toBeGreaterThanOrEqual(4);
  });

  it('aligns a new session history identifier with the requested session identifier', async () => {
    const bureau = await createBureau({
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
      persistence: createMemoryKeyValueStore(),
    });
    const sessionId = 'session-aligned';

    const run = await bureau.createRun({
      message: 'First message',
      sessionId,
    });
    await waitForRunCompletion(bureau, run.id);

    const session = await bureau.getSession(sessionId);
    expect(session?.id).toBe(sessionId);
    expect(session?.conversationHistory.id).toBe(sessionId);
  });

  it('persists completed session metadata for fast runs', async () => {
    const bureau = await createBureau({
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
      persistence: createMemoryKeyValueStore(),
    });

    const run = await bureau.createRun({ message: 'Fast completion' });
    await waitForRunCompletion(bureau, run.id);

    const session = await bureau.getSession(run.sessionId);
    expect(session?.metadata['lastRunId']).toBe(run.id);
    expect(session?.metadata['lastRunStatus']).toBe('completed');
  });

  it('retries terminal session persistence after a transient save failure', async () => {
    const backingStore = createMemoryKeyValueStore();
    let sessionSaveCount = 0;

    const flakyStore: KeyValueStore = {
      async get(key) {
        return backingStore.get(key);
      },
      async set(key, value) {
        if (key.startsWith('agent-session:')) {
          sessionSaveCount += 1;
          if (sessionSaveCount === 2) {
            throw new Error('temporary persistence failure');
          }
        }

        await backingStore.set(key, value);
      },
      async delete(key) {
        await backingStore.delete(key);
      },
      async list(prefix) {
        return backingStore.list(prefix);
      },
    };

    const bureau = await createBureau({
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
      persistence: flakyStore,
      sessionPersistenceSleep: async () => {},
    });

    const run = await bureau.createRun({ message: 'Retry completion' });
    await waitForRunCompletion(bureau, run.id);
    await waitForCondition(async () => {
      const session = await bureau.getSession(run.sessionId);
      return session?.metadata['lastRunStatus'] === 'completed';
    }, 'completed session metadata was not persisted after retry');

    const session = await bureau.getSession(run.sessionId);
    expect(sessionSaveCount).toBe(3);
    expect(session?.metadata['lastRunId']).toBe(run.id);
    expect(session?.metadata['lastRunStatus']).toBe('completed');
  });

  it('does not register a run when initial session persistence fails', async () => {
    const backingStore = createMemoryKeyValueStore();
    const failingStore: KeyValueStore = {
      async get(key) {
        return backingStore.get(key);
      },
      async set(key, value) {
        if (key.startsWith('agent-session:')) {
          throw new Error('persistence failed');
        }

        await backingStore.set(key, value);
      },
      async delete(key) {
        await backingStore.delete(key);
      },
      async list(prefix) {
        return backingStore.list(prefix);
      },
    };

    const bureau = await createBureau({
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
      persistence: failingStore,
    });

    const error = await bureau.createRun({ message: 'Ghost run?' }).then(
      () => undefined,
      (rejection) => rejection,
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('persistence failed');
    expect(bureau.listRuns()).toHaveLength(0);
  });

  it('persists error session metadata when runs finish with an error', async () => {
    const generate: GenerateFunction = async () => {
      throw new Error('Explode');
    };

    const bureau = await createBureau({
      generate,
      toolbox: createEmptyToolbox(),
      persistence: createMemoryKeyValueStore(),
    });

    const run = await bureau.createRun({ message: 'Explode' });
    await waitForRunCompletion(bureau, run.id);

    const session = await bureau.getSession(run.sessionId);
    expect(session?.metadata['lastRunId']).toBe(run.id);
    expect(session?.metadata['lastRunStatus']).toBe('error');
    expect(session?.metadata['lastError']).toBe('Explode');
  });

  it('persists error session state once after the initial running save', async () => {
    const backingStore = createMemoryKeyValueStore();
    let sessionSaveCount = 0;

    const trackingStore: KeyValueStore = {
      async get(key) {
        return backingStore.get(key);
      },
      async set(key, value) {
        if (key.startsWith('agent-session:')) {
          sessionSaveCount += 1;
        }

        await backingStore.set(key, value);
      },
      async delete(key) {
        await backingStore.delete(key);
      },
      async list(prefix) {
        return backingStore.list(prefix);
      },
    };

    const generate: GenerateFunction = async () => {
      throw new Error('Explode once');
    };

    const bureau = await createBureau({
      generate,
      toolbox: createEmptyToolbox(),
      persistence: trackingStore,
    });

    const run = await bureau.createRun({ message: 'Explode once' });
    await waitForRunCompletion(bureau, run.id);

    expect(sessionSaveCount).toBe(2);
  });

  it('fails runs when the model emits tool calls without a configured toolbox', async () => {
    const generate: GenerateFunction = async () => ({
      content: '',
      toolCalls: [{ name: 'missing_tool', arguments: {} }],
    });

    const bureau = await createBureau({ generate });

    const run = await bureau.createRun({ message: 'Need a tool' });
    await waitForRunCompletion(bureau, run.id);

    const detail = bureau.getRun(run.id);
    expect(detail?.status).toBe('error');
    expect(detail?.error).toContain('No toolbox configured but tool calls were received');
  });

  it('lists runs and filters them by status', async () => {
    const bureau = await createBureau({
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
    });

    const run = await bureau.createRun({ message: 'Hello' });
    await waitForRunCompletion(bureau, run.id);

    const allRuns = bureau.listRuns();
    const completedRuns = bureau.listRuns('completed');

    expect(allRuns.length).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(completedRuns)).toBe(true);
  });

  it('retains session identifiers for completed run summaries and details', async () => {
    const bureau = await createBureau({
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
    });

    const run = await bureau.createRun({ message: 'Hello' });
    await waitForRunCompletion(bureau, run.id);

    const summary = bureau.listRuns().find((entry) => entry.id === run.id);
    const detail = bureau.getRun(run.id);

    expect(summary?.sessionId).toBe(run.sessionId);
    expect(detail?.sessionId).toBe(run.sessionId);
  });

  it('returns a run detail payload with events and step details', async () => {
    const bureau = await createBureau({
      generate: createMockGenerate('Detailed response'),
      toolbox: createEmptyToolbox(),
    });

    const run = await bureau.createRun({ message: 'Hello' });
    await waitForRunCompletion(bureau, run.id);

    const detail = bureau.getRun(run.id);

    expect(detail).toBeDefined();
    expect(detail?.sessionId).toBe(run.sessionId);
    expect(detail?.events.length).toBeGreaterThan(0);
    expect(detail?.stepDetails.length).toBeGreaterThan(0);
  });

  it('aborts a running run', async () => {
    const generate: GenerateFunction = () => new Promise(() => {});
    const bureau = await createBureau({ generate, toolbox: createEmptyToolbox() });

    const run = await bureau.createRun({ message: 'Hello' });

    const aborted = bureau.abortRun(run.id);
    expect(aborted.status).toBe('aborted');
  });

  it('throws CONFLICT when deleting a running run', async () => {
    const generate: GenerateFunction = () => new Promise(() => {});
    const bureau = await createBureau({ generate, toolbox: createEmptyToolbox() });

    const run = await bureau.createRun({ message: 'Hello' });
    expect(bureau.getRun(run.id)?.status).toBe('running');

    expect(() => bureau.deleteRun(run.id)).toThrow(BureauError);
  });

  it('throws NOT_IMPLEMENTED for session APIs when persistence is not configured', async () => {
    const bureau = await createBureau();

    const error = await bureau.listSessions().then(
      () => undefined,
      (rejection) => rejection,
    );

    expect(error).toMatchObject({
      code: 'NOT_IMPLEMENTED',
    });
  });

  it('lists, loads, and deletes sessions from the canonical session store', async () => {
    const bureau = await createBureau({
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
      persistence: createMemoryKeyValueStore(),
    });

    const run = await bureau.createRun({ message: 'Hello' });
    await waitForRunCompletion(bureau, run.id);

    const sessions = await bureau.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.id).toBe(run.sessionId);

    const session = await bureau.getSession(run.sessionId);
    expect(session?.id).toBe(run.sessionId);

    await bureau.deleteSession(run.sessionId);
    const deleted = await bureau.getSession(run.sessionId);
    expect(deleted).toBeUndefined();
  });

  it('returns configuration data with provider and tool summaries', async () => {
    const bureau = await createBureau({
      provider: {
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        apiKey: 'secret-value',
      },
    });

    const configuration = bureau.getConfiguration();
    const configurationProviderHasNoApiKey: HasApiKey<
      NonNullable<ConfigurationResponse['provider']>
    > = false;
    const routedConfigurationProviderHasNoApiKey: HasApiKey<
      ConfigurationResponse['providers'][number]['provider']
    > = false;

    expect(configuration.maximumSteps).toBe(DEFAULT_MAXIMUM_STEPS);
    expect(configuration.provider?.provider).toBe('anthropic');
    expect(configuration.providers).toHaveLength(1);
    expect(configuration.provider).not.toHaveProperty('apiKey');
    expect(configuration.providers[0]?.provider).not.toHaveProperty('apiKey');
    expect(configurationProviderHasNoApiKey).toBeFalse();
    expect(routedConfigurationProviderHasNoApiKey).toBeFalse();
  });

  it('configures a scheduler for routed multi-provider runtimes', async () => {
    const bureau = await createBureau({
      providers: [
        {
          name: 'fast',
          provider: { provider: 'openai', model: 'gpt-4.1-mini' },
        },
        {
          name: 'deep',
          provider: { provider: 'anthropic', model: 'claude-sonnet-4-20250514' },
        },
      ],
      routing: {
        type: 'step-based',
        first: 'fast',
        middle: 'deep',
      },
      scheduler: { enabled: true, idleDelay: 1 },
      toolbox: createEmptyToolbox(),
    });

    expect(bureau.scheduler).toBeDefined();
    bureau.dispose();
  });

  it('does not configure a scheduler unless it is explicitly enabled', async () => {
    const bureau = await createBureau({
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
    });

    expect(bureau.scheduler).toBeUndefined();
    bureau.dispose();
  });

  it('submits scheduler tasks with the configured runtime toolbox', async () => {
    const echoTool = createMockTool({
      name: 'echo',
      impl: () => 'echoed',
    });

    const bureau = await createBureau({
      generate: createSequentialGenerate([
        {
          content: '',
          toolCalls: [{ name: 'echo', arguments: {} }],
        },
        {
          content: 'done',
          toolCalls: [],
        },
      ]),
      scheduler: { enabled: true, idleDelay: 1 },
      toolbox: createTestToolbox([echoTool]),
    });

    const response = await bureau.submitSchedulerTask({
      message: 'Run a scheduled tool task',
      priority: 'background',
    });

    await waitForCondition(
      () => bureau.scheduler?.getState().completedCount === 1,
      'scheduled task did not complete',
    );

    expect(response.status).toBe('queued');
    expect(echoTool.calls).toHaveLength(1);
    expect(bureau.scheduler?.getState().completedCount).toBe(1);

    bureau.dispose();
  });

  it('throws BAD_REQUEST when submitSchedulerTask receives invalid scheduler-specific fields', async () => {
    const bureau = await createBureau({
      generate: createMockGenerate(),
      scheduler: { enabled: true, idleDelay: 1 },
      toolbox: createEmptyToolbox(),
    });

    const invalidRequest = {
      message: 'Run a scheduled task',
      priority: 'urgent',
    } as unknown as Parameters<typeof bureau.submitSchedulerTask>[0];

    const error = await Promise.resolve()
      .then(() => bureau.submitSchedulerTask(invalidRequest))
      .then(
        () => undefined,
        (rejection) => rejection,
      );

    expect(error).toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect((error as Error).message).toBe(
      '"priority" must be one of: immediate, scheduled, background, ambient',
    );

    bureau.dispose();
  });

  it('returns tool summaries', async () => {
    const bureau = await createBureau({
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
    });

    expect(bureau.getTools()).toEqual([]);
  });

  it('emits one scheduler preempted frame with current state', async () => {
    const { generate: slowGenerate, resolve } = createBlockingGenerate();
    const schedulerFrames: Extract<
      ServerFrame,
      { type: 'scheduler.state' | 'scheduler.task.preempted' }
    >[] = [];

    const bureau = await createBureau({
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
      scheduler: { enabled: true, idleDelay: 1 },
    });

    const unsubscribe = bureau.subscribeLiveFrames((frame) => {
      if (frame.type === 'scheduler.state' || frame.type === 'scheduler.task.preempted') {
        schedulerFrames.push(frame);
      }
    });

    const backgroundResult = bureau.scheduler!.submit({
      id: 'background-task',
      priority: 'background',
      requeue: false,
      createRun: () => ({
        generate: slowGenerate,
        toolbox: createEmptyToolbox(),
        conversation: new Conversation(),
        maximumSteps: 5,
      }),
    });

    await waitForCondition(
      () => bureau.scheduler?.getState().activeTask?.id === 'background-task',
      'background task was not dispatched',
    );
    schedulerFrames.length = 0;

    const immediateResult = bureau.scheduler!.submitImmediate(() => ({
      generate: createMockGenerate('immediate-done'),
      toolbox: createEmptyToolbox(),
      conversation: new Conversation(),
      maximumSteps: 1,
    }));

    resolve({ content: 'background-step', toolCalls: [] });

    await immediateResult;
    await backgroundResult;
    await waitForCondition(
      () => schedulerFrames.some((frame) => frame.type === 'scheduler.task.preempted'),
      'scheduler preempted frame was not emitted',
    );

    const preemptedFrames = schedulerFrames.filter(
      (frame): frame is Extract<ServerFrame, { type: 'scheduler.task.preempted' }> =>
        frame.type === 'scheduler.task.preempted',
    );

    expect(preemptedFrames).toHaveLength(1);
    expect(preemptedFrames[0]?.taskId).toBe('background-task');
    expect(preemptedFrames[0]?.state.preemptedCount).toBeGreaterThanOrEqual(1);

    unsubscribe();
    bureau.dispose();
  });

  it('emits action events from live runs', async () => {
    const bureau = await createBureau({
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
    });

    const actions: string[] = [];
    bureau.addEventListener('action', (event) => {
      actions.push(event.action.type);
    });

    const run = await bureau.createRun({ message: 'Hello' });
    await waitForRunCompletion(bureau, run.id);

    expect(actions.length).toBeGreaterThan(0);
  });

  it('disposes cleanly more than once', async () => {
    const bureau = await createBureau();
    bureau.dispose();
    bureau.dispose();
  });
});
