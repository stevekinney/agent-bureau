import { describe, expect, it } from 'bun:test';

import type { AnyRunEngine } from '../durable/create-run-engine';
import {
  createManualCheckpointStore,
  createManualDurableEngine,
  spyEngine,
} from './durable-engine';

describe('durable engine test helpers', () => {
  it('spies on suspend, resume, and cancel while delegating to the wrapped engine', async () => {
    const delegated: string[] = [];
    const engine = {
      suspend: async (id: string) => {
        delegated.push(`suspend:${id}`);
      },
      resume: async (id: string) => {
        delegated.push(`resume:${id}`);
      },
      cancel: async (id: string) => {
        delegated.push(`cancel:${id}`);
      },
    } as unknown as AnyRunEngine;

    const spy = spyEngine(engine);

    await spy.engine.suspend('run-1');
    await spy.engine.resume('run-2');
    await spy.engine.cancel('run-3');

    expect(spy.suspends).toEqual(['run-1']);
    expect(spy.resumes).toEqual(['run-2']);
    expect(spy.cancels).toEqual(['run-3']);
    expect(delegated).toEqual(['suspend:run-1', 'resume:run-2', 'cancel:run-3']);
  });

  it('creates a manual durable engine whose result can be resolved or cancelled', async () => {
    const manual = createManualDurableEngine();
    const started = await manual.engine.start('agentRun', {}, { id: 'manual-run' });
    const result = started.result();

    manual.resolveResult();

    expect(await result).toMatchObject({
      runId: 'manual-run',
      content: 'manual',
      finishReason: 'stop-condition',
    });

    const cancelled = createManualDurableEngine();
    const resumed = await cancelled.engine.resume('manual-run');
    const cancelledResult = resumed.result();

    await cancelled.engine.cancel('manual-run');

    try {
      await cancelledResult;
      throw new Error('expected cancelled result to reject');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('Workflow cancelled');
    }
  });

  it('creates a manual durable engine whose result can be rejected directly', async () => {
    const manual = createManualDurableEngine();
    const started = await manual.engine.start('agentRun', {}, { id: 'manual-run' });
    const result = started.result();

    manual.rejectResult(new Error('manual failure'));

    try {
      await result;
      throw new Error('expected manual result to reject');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('manual failure');
    }
  });

  it('creates a checkpoint store stub with no-op persistence methods', async () => {
    const store = createManualCheckpointStore();

    expect(await store.loadCheckpoint('run-1')).toMatchObject({
      runId: 'run-1',
      cursor: {
        step: 0,
        lastContent: '',
        schemaAttempts: 0,
      },
      conversation: null,
      steps: [],
    });
    expect(await store.saveCursor('run-1', {} as never)).toBeUndefined();
    expect(await store.loadCursor('run-1')).toBeNull();
    expect(
      await store.saveConversation('run-1', {
        root: {
          conversation: {
            schemaVersion: 1,
            id: 'conversation-1',
            status: 'active',
            metadata: {},
            ids: [],
            messages: {},
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
          children: [],
        },
        currentPath: [],
      }),
    ).toBeUndefined();
    expect(await store.loadConversation('run-1')).toBeNull();
    expect(await store.saveStep('run-1', {} as never)).toBeUndefined();
    expect(await store.loadSteps('run-1')).toEqual([]);
    expect(await store.clear('run-1')).toBe(0);
  });
});
