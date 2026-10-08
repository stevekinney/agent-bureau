/**
 * COR-851 — reading how a durable run ended without driving it.
 */
import { createDefaultRuntimeServices } from '@lostgradient/lifecycle';
import { MemoryStorage, textValueStore } from '@lostgradient/weft';
import { createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { createConversationHistory } from 'conversationalist';

import { stopWhen } from '../conditions/index';
import { createActiveRun } from '../create-run';
import { waitForCondition } from '../test/index';
import type { RunOptions } from '../types';
import { startDurableRunResult } from './active-run-result-entrypoints';
import { createCheckpointStore } from './checkpoint-store';
import { createRunEngine } from './create-run-engine';
import { readDurableRunResult } from './read-run-result';
import { createRunWorkflow } from './run-workflow';

async function buildContext() {
  const storage = new MemoryStorage();
  const checkpointStore = createCheckpointStore(
    textValueStore(storage, { disposeUnderlyingStorage: false }),
  );
  const { engine } = await createRunEngine({
    storage,
    runWorkflow: createRunWorkflow(checkpointStore),
    recover: false,
  });
  return { engine, checkpointStore };
}

function runOptions(generate: RunOptions['generate']): RunOptions {
  return {
    generate,
    toolbox: createToolbox([]),
    conversation: createConversationHistory(),
    stopWhen: stopWhen.noToolCalls(),
  };
}

const runtime = createDefaultRuntimeServices();

describe('readDurableRunResult', () => {
  it('rebuilds the result of a completed run from its summary and checkpoint', async () => {
    const context = await buildContext();
    try {
      const original = await startDurableRunResult(context, {
        runId: 'completed-run',
        sessionId: 'completed-run',
        options: runOptions(async () => ({
          content: 'all done',
          toolCalls: [],
          usage: { prompt: 100, completion: 50, total: 150 },
        })),
        prompt: 'go',
      });

      const reading = await readDurableRunResult(context, 'completed-run', { runtime });

      expect(reading.status).toBe('completed');
      if (reading.status !== 'completed') return;
      expect(reading.result.content).toBe('all done');
      expect(reading.result.finishReason).toBe('stop-condition');
      expect(reading.result.steps).toHaveLength(original.steps.length);
      expect(reading.result.usage).toEqual(original.usage);
      expect(reading.result.costEstimate).toBeUndefined();
    } finally {
      context.engine[Symbol.dispose]();
    }
  });

  it('folds in the cost estimate the run was configured with', async () => {
    const context = await buildContext();
    try {
      await startDurableRunResult(context, {
        runId: 'costed-run',
        sessionId: 'costed-run',
        options: runOptions(async () => ({
          content: 'priced',
          toolCalls: [],
          usage: { prompt: 100, completion: 50, total: 150 },
        })),
        prompt: 'go',
      });

      const reading = await readDurableRunResult(context, 'costed-run', {
        runtime,
        costEstimation: { model: 'gpt-4o' },
      });

      expect(reading.status).toBe('completed');
      if (reading.status !== 'completed') return;
      expect(reading.result.costEstimate?.totalCost).toBeGreaterThan(0);
    } finally {
      context.engine[Symbol.dispose]();
    }
  });

  it('says so when there is no such workflow', async () => {
    const context = await buildContext();
    try {
      expect(await readDurableRunResult(context, 'nobody', { runtime })).toEqual({
        status: 'missing',
      });
    } finally {
      context.engine[Symbol.dispose]();
    }
  });

  it('reports a run that is still going as not terminal, and a cancelled one as ended', async () => {
    const context = await buildContext();
    try {
      const hanging = createActiveRun(
        runOptions(() => new Promise(() => {})),
        { ...context, runId: 'hanging-run', prompt: 'go' },
      );
      void hanging;
      await waitForCondition(
        async () => (await context.engine.get('hanging-run')) !== null,
        'the hanging run never started',
      );

      expect(await readDurableRunResult(context, 'hanging-run', { runtime })).toEqual({
        status: 'not-terminal',
      });

      await context.engine.cancel('hanging-run');
      const reading = await readDurableRunResult(context, 'hanging-run', { runtime });
      expect(reading).toMatchObject({
        status: 'ended',
        workflowStatus: 'cancelled',
        finishReason: 'aborted',
      });
    } finally {
      context.engine[Symbol.dispose]();
    }
  });
  it('rejects instead of fabricating an empty run when the checkpoint cannot be read', async () => {
    const context = await buildContext();
    try {
      await startDurableRunResult(context, {
        runId: 'unreadable-checkpoint-run',
        sessionId: 'unreadable-checkpoint-run',
        options: runOptions(async () => ({
          content: 'finished',
          toolCalls: [],
          usage: { prompt: 10, completion: 5, total: 15 },
        })),
        prompt: 'go',
      });
      const failing = {
        ...context,
        checkpointStore: {
          ...context.checkpointStore,
          loadCheckpoint: async () => {
            throw new Error('checkpoint store unavailable');
          },
        },
      };

      let caught: unknown;
      try {
        await readDurableRunResult(failing, 'unreadable-checkpoint-run', { runtime });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toBe('checkpoint store unavailable');
    } finally {
      context.engine[Symbol.dispose]();
    }
  });

  it('rejects for an ended run whose checkpoint cannot be read', async () => {
    const context = await buildContext();
    try {
      const hanging = createActiveRun(
        runOptions(() => new Promise(() => {})),
        { ...context, runId: 'ended-unreadable-run', prompt: 'go' },
      );
      void hanging;
      await waitForCondition(
        async () => (await context.engine.get('ended-unreadable-run')) !== null,
        'the hanging run never started',
      );
      await context.engine.cancel('ended-unreadable-run');
      const failing = {
        ...context,
        checkpointStore: {
          ...context.checkpointStore,
          loadCheckpoint: async () => {
            throw new Error('checkpoint store unavailable');
          },
        },
      };
      let caught: unknown;
      try {
        await readDurableRunResult(failing, 'ended-unreadable-run', { runtime });
      } catch (error) {
        caught = error;
      }
      expect((caught as Error | undefined)?.message).toBe('checkpoint store unavailable');
    } finally {
      context.engine[Symbol.dispose]();
    }
  });

  it('rebuilds a session run whose checkpoint was persisted in the Operative 0.15.x key layout', async () => {
    const storage = new MemoryStorage();
    const context = await (async () => {
      const checkpointStore = createCheckpointStore(
        textValueStore(storage, { disposeUnderlyingStorage: false }),
      );
      const { engine } = await createRunEngine({
        storage,
        runWorkflow: createRunWorkflow(checkpointStore),
        recover: false,
      });
      return { engine, checkpointStore };
    })();
    try {
      // A session run id is `${sessionId}:${sequence}`, so it contains `:`.
      const runId = 'user-123:2';
      const original = await startDurableRunResult(context, {
        runId,
        sessionId: 'user-123',
        options: runOptions(async () => ({
          content: 'from 0.15.x',
          toolCalls: [],
          usage: { prompt: 10, completion: 5, total: 15 },
        })),
        prompt: 'go',
      });

      // Rewrite the checkpoint keys into the exact 0.15.x layout: the run id
      // verbatim, with no escaping.
      const raw = textValueStore(storage, { disposeUnderlyingStorage: false });
      const escapedPrefix = 'durable-run:user-123%3A2:';
      const checkpointKeys = await raw.list(escapedPrefix);
      expect(checkpointKeys.length).toBeGreaterThan(0);
      for (const key of checkpointKeys) {
        const value = await raw.get(key);
        await raw.delete(key);
        await raw.set(`durable-run:${runId}:${key.slice(escapedPrefix.length)}`, value as string);
      }

      const reading = await readDurableRunResult(context, runId, { runtime });

      expect(reading.status).toBe('completed');
      if (reading.status !== 'completed') return;
      expect(reading.result.content).toBe('from 0.15.x');
      expect(reading.result.steps).toHaveLength(original.steps.length);
      expect(reading.result.steps.length).toBeGreaterThan(0);
      expect(reading.result.usage).toEqual(original.usage);
    } finally {
      context.engine[Symbol.dispose]();
    }
  });
});
