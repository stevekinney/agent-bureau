import { MemoryStorage, textValueStore } from '@lostgradient/weft/storage';
import { createToolbox } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';
import { createConversationHistory } from 'conversationalist';

import { noToolCalls } from '../conditions/predicates';
import type { RunOptions } from '../types';
import { createCheckpointStore } from './checkpoint-store';
import { createDurableRun } from './create-durable-run';
import { createRunEngine } from './create-run-engine';
import { getRunDeps, resetRunDepsRegistry } from './deps-registry';
import { createRunWorkflow } from './run-workflow';

async function buildContext() {
  const storage = new MemoryStorage();
  const checkpointStore = createCheckpointStore(
    textValueStore(storage, { disposeUnderlyingStorage: false }),
  );
  const runWorkflow = createRunWorkflow(checkpointStore);
  const { engine } = await createRunEngine({ storage, runWorkflow, recover: false });
  return { engine, checkpointStore };
}

function runOptions(generate: RunOptions['generate']): RunOptions {
  return {
    generate,
    toolbox: createToolbox([]) as unknown as RunOptions['toolbox'],
    conversation: createConversationHistory(),
    // Stop on the first turn with no tool calls — the same stop condition a
    // real caller supplies. The durable driver honors RunOptions.stopWhen
    // exactly as the in-memory loop does (no hardcoded stop in the workflow).
    stopWhen: noToolCalls(),
  };
}

afterEach(() => {
  resetRunDepsRegistry();
});

describe('createDurableRun', () => {
  it('drives the durable workflow to completion and returns its result', async () => {
    const context = await buildContext();
    try {
      const result = await createDurableRun(context, {
        runId: 'durable-1',
        prompt: 'Hello',
        options: runOptions(async () => ({ content: 'all done', toolCalls: [] })),
      });

      expect(result.runId).toBe('durable-1');
      expect(result.steps).toBe(1);
      expect(result.content).toBe('all done');
      expect(result.finishReason).toBe('stop-condition');
    } finally {
      context.engine[Symbol.dispose]();
    }
  });

  it('clears the run deps after completion', async () => {
    const context = await buildContext();
    try {
      await createDurableRun(context, {
        runId: 'durable-2',
        options: runOptions(async () => ({ content: 'done', toolCalls: [] })),
      });
      // Deps must be cleared, so resolving them now throws.
      expect(() => getRunDeps('durable-2')).toThrow(/No durable run deps registered/);
    } finally {
      context.engine[Symbol.dispose]();
    }
  });

  it('surfaces a generate error as an error result and still clears the run deps', async () => {
    const context = await buildContext();
    try {
      // Parity with executeLoop: a generate failure is caught and reported as an
      // error result (finishReason 'error'), not thrown — the in-memory loop
      // returns a RunResult with finishReason 'error' for the same case.
      const result = await createDurableRun(context, {
        runId: 'durable-err',
        options: runOptions(async () => {
          throw new Error('generate exploded');
        }),
      });
      expect(result.finishReason).toBe('error');
      // The finally block must still have cleared the deps.
      expect(() => getRunDeps('durable-err')).toThrow(/No durable run deps registered/);
    } finally {
      context.engine[Symbol.dispose]();
    }
  });

  it('persists a checkpoint readable through the shared checkpoint store', async () => {
    const context = await buildContext();
    try {
      await createDurableRun(context, {
        runId: 'durable-ckpt',
        prompt: 'Hi',
        options: runOptions(async () => ({ content: 'done', toolCalls: [] })),
      });

      const checkpoint = await context.checkpointStore.loadCheckpoint('durable-ckpt');
      expect(checkpoint.cursor.step).toBe(1);
      expect(checkpoint.steps).toHaveLength(1);
      expect(checkpoint.conversation).not.toBeNull();
    } finally {
      context.engine[Symbol.dispose]();
    }
  });
});
