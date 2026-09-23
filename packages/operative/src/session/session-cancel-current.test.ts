import { MemoryStorage, textValueStore, yieldToPortableEventLoop } from '@lostgradient/weft';
import { createToolbox } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';
import { createConversationHistory } from 'conversationalist';

import { createAgentSession } from '../agent-session';
import type { GenerateFunction } from '../types';
import { createSessionStore } from './create-session-store';
import { createSessionEngine } from './session-engine-test-fixture';
import { createSessionHandle } from './session-handle';
import {
  createTestRunOptions,
  createUpdateGate,
  fixtureRuntime,
} from './session-handle-test-support';

// Drain Weft's deferred inline-launch queue between tests — prevents one test's
// pending macrotask from interfering with the next under bun test concurrency.
afterEach(async () => {
  await yieldToPortableEventLoop();
});

describe('session.cancel() — handle ownership', () => {
  it('cancels the current handle run instead of the last session run', async () => {
    const cancelledIds: string[] = [];
    const fakeEngine = createSessionEngine({
      cancel: async (id: string) => {
        cancelledIds.push(id);
      },
      signal: async () => {},
      update: async () => {},
      query: async () => {},
    });

    const generateStartedResolvers: Array<() => void> = [];
    const generateStarted = [0, 1].map(
      (index) =>
        new Promise<void>((resolve) => {
          generateStartedResolvers[index] = resolve;
        }),
    );
    const resolveGenerate: Array<() => void> = [];
    let generateCallIndex = 0;
    const blockingGenerate: GenerateFunction = () => {
      const index = generateCallIndex++;
      return new Promise<{ content: string; toolCalls: [] }>((resolve) => {
        resolveGenerate[index] = () => resolve({ content: `done ${index}`, toolCalls: [] });
        generateStartedResolvers[index]?.();
      });
    };

    const kv = textValueStore(new MemoryStorage());
    const store = createSessionStore(kv);
    const runOptions = {
      generate: blockingGenerate,
      toolbox: createToolbox([]),
      maximumSteps: 1,
    };
    const firstHandle = createSessionHandle('shared-cancel-session', {
      store,
      agentName: 'cancel-agent',
      engine: fakeEngine,
      runOptions,
    });
    const secondHandle = createSessionHandle('shared-cancel-session', {
      store,
      agentName: 'cancel-agent',
      engine: fakeEngine,
      runOptions,
    });

    const firstRun = firstHandle.run('first');
    const secondRun = secondHandle.run('second');
    void firstRun.result().catch(() => {});
    void secondRun.result().catch(() => {});
    await Promise.all(generateStarted);

    await firstHandle.cancel();

    expect(cancelledIds).toEqual(['shared-cancel-session:0']);
    const updated = await store.load('shared-cancel-session');
    expect(updated!.runs.map((run) => [run.runId, run.status])).toEqual([
      ['shared-cancel-session:0', 'running'],
      ['shared-cancel-session:1', 'running'],
    ]);

    resolveGenerate[0]?.();
    resolveGenerate[1]?.();
    await Promise.allSettled([firstRun.result(), secondRun.result()]);

    const settled = await store.load('shared-cancel-session');
    expect(settled!.runs.map((run) => [run.runId, run.status])).toEqual([
      ['shared-cancel-session:0', 'aborted'],
      ['shared-cancel-session:1', 'completed'],
    ]);
    expect(settled!.runs[0]!.outcome?.finishReason).toBe('aborted');
    expect(settled!.runs[1]!.outcome?.finishReason).toBe('maximum-steps');
  });

  it('keeps a newer same-handle run current while an older cancel is pending', async () => {
    const cancelStarted = Promise.withResolvers<void>();
    const releaseCancel = Promise.withResolvers<void>();
    const generateStarted = [0, 1].map(() => Promise.withResolvers<void>());
    const releaseGenerate = [0, 1].map(() => Promise.withResolvers<void>());
    let generateIndex = 0;
    const generate: GenerateFunction = async ({ signal }) => {
      const index = generateIndex++;
      generateStarted[index]!.resolve();
      await Promise.race([
        releaseGenerate[index]!.promise,
        new Promise<never>((_resolve, reject) =>
          signal?.addEventListener('abort', () => reject(new Error('cancelled')), {
            once: true,
          }),
        ),
      ]);
      return { content: `done ${index}`, toolCalls: [] };
    };
    const engine = createSessionEngine({
      cancel: async () => {
        cancelStarted.resolve();
        await releaseCancel.promise;
      },
    });
    const store = createSessionStore(textValueStore(new MemoryStorage()));
    const handle = createSessionHandle('same-handle-cancel-race', {
      store,
      agentName: 'agent',
      engine,
      runOptions: { ...createTestRunOptions(generate), maximumSteps: 1 },
    });

    const oldRun = handle.run('old');
    await generateStarted[0]!.promise;
    const cancelPromise = handle.cancel();
    await cancelStarted.promise;

    const newRun = handle.run('new');
    await generateStarted[1]!.promise;
    releaseCancel.resolve();
    await cancelPromise;

    expect(await handle.recover()).toBe(newRun);
    const during = await store.load('same-handle-cancel-race');
    expect(during?.runs.map((run) => [run.runId, run.status])).toEqual([
      ['same-handle-cancel-race:0', 'running'],
      ['same-handle-cancel-race:1', 'running'],
    ]);

    releaseGenerate[1]!.resolve();
    await Promise.allSettled([oldRun.result(), newRun.result()]);
    const settled = await store.load('same-handle-cancel-race');
    expect(settled?.runs[0]?.status).toBe('aborted');
    expect(settled?.runs[1]?.status).toBe('completed');
    expect(settled?.runs[1]?.outcome?.finishReason).not.toBe('aborted');
  });

  it('does not cancel another run while this handle is reserving a run id', async () => {
    const cancelledIds: string[] = [];
    const fakeEngine = createSessionEngine({
      cancel: async (id: string) => {
        cancelledIds.push(id);
      },
      signal: async () => {},
      update: async () => {},
      query: async () => {},
    });

    const baseStore = createSessionStore(textValueStore(new MemoryStorage()));
    const session = createAgentSession({
      agentName: 'agent',
      conversationHistory: createConversationHistory(),
      id: 'pending-reservation-cancel-session',
      runs: [
        {
          runId: 'pending-reservation-cancel-session:0',
          sequence: 0,
          status: 'running',
          startedAt: fixtureRuntime.clock.nowISO(),
          agentName: 'agent',
        },
      ],
    });
    await baseStore.save(session);
    const gate = createUpdateGate(baseStore);
    const handle = createSessionHandle('pending-reservation-cancel-session', {
      store: gate.store,
      agentName: 'agent',
      engine: fakeEngine,
      runOptions: createTestRunOptions(),
    });

    const run = handle.run('new run');
    void run.result().catch(() => {});

    await handle.cancel();

    expect(cancelledIds).toEqual([]);
    const loadedBeforeRelease = await baseStore.load('pending-reservation-cancel-session');
    expect(loadedBeforeRelease!.runs[0]!.status).toBe('running');

    gate.release();
    await Promise.allSettled([run.result()]);
  });
});
