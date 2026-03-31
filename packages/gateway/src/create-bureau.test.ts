import { createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import type { GenerateFunction, Toolbox } from 'operative';
import { createStore } from 'sentinel';
import { createMemoryKeyValueStore } from 'storage';

import { BureauError, createBureau } from './create-bureau';
import { DEFAULT_MAXIMUM_STEPS } from './types';

function createMockGenerate(content = 'Done.'): GenerateFunction {
  return async () => ({ content, toolCalls: [] });
}

function createEmptyToolbox(): Toolbox {
  return createToolbox([]) as unknown as Toolbox;
}

async function waitForRunCompletion() {
  await new Promise((resolve) => setTimeout(resolve, 50));
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
    await waitForRunCompletion();

    const secondRun = await bureau.createRun({
      message: 'Second message',
      sessionId: firstRun.sessionId,
    });
    await waitForRunCompletion();

    expect(secondRun.sessionId).toBe(firstRun.sessionId);

    const session = await bureau.getSession(firstRun.sessionId);
    expect(session).toBeDefined();
    expect(session?.conversationHistory.ids.length).toBeGreaterThanOrEqual(4);
  });

  it('lists runs and filters them by status', async () => {
    const bureau = await createBureau({
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
    });

    await bureau.createRun({ message: 'Hello' });
    await waitForRunCompletion();

    const allRuns = bureau.listRuns();
    const completedRuns = bureau.listRuns('completed');

    expect(allRuns.length).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(completedRuns)).toBe(true);
  });

  it('returns a run detail payload with events and step details', async () => {
    const bureau = await createBureau({
      generate: createMockGenerate('Detailed response'),
      toolbox: createEmptyToolbox(),
    });

    const run = await bureau.createRun({ message: 'Hello' });
    await waitForRunCompletion();

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
    await new Promise((resolve) => setTimeout(resolve, 10));

    const aborted = bureau.abortRun(run.id);
    expect(aborted.status).toBe('aborted');
  });

  it('throws CONFLICT when deleting a running run', async () => {
    const generate: GenerateFunction = () => new Promise(() => {});
    const bureau = await createBureau({ generate, toolbox: createEmptyToolbox() });

    const run = await bureau.createRun({ message: 'Hello' });
    await new Promise((resolve) => setTimeout(resolve, 10));

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
    await waitForRunCompletion();

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
      provider: { provider: 'anthropic', model: 'claude-sonnet-4-20250514' },
    });

    const configuration = bureau.getConfiguration();

    expect(configuration.maximumSteps).toBe(DEFAULT_MAXIMUM_STEPS);
    expect(configuration.provider?.provider).toBe('anthropic');
    expect(configuration.providers).toHaveLength(1);
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

  it('returns tool summaries', async () => {
    const bureau = await createBureau({
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
    });

    expect(bureau.getTools()).toEqual([]);
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

    await bureau.createRun({ message: 'Hello' });
    await waitForRunCompletion();

    expect(actions.length).toBeGreaterThan(0);
  });

  it('disposes cleanly more than once', async () => {
    const bureau = await createBureau();
    bureau.dispose();
    bureau.dispose();
  });
});
