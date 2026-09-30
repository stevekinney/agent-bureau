import {
  Engine,
  MemoryStorage,
  textValueStore,
  yieldToPortableEventLoop,
} from '@lostgradient/weft';
import { createTool, createToolbox } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';
import { createConversationHistory } from 'conversationalist';
import { z } from 'zod';

import { noToolCalls } from '../conditions/predicates';
import { createCheckpointStore } from './checkpoint-store';
import { createRunWorkflow } from './run-workflow';
import { createStorageActivities } from './storage-activities';
import type { DurableRunDeps } from './types';

/**
 * Weft encodes every checkpoint with msgpack, which refuses values nested more
 * than 100 levels deep. A durable run persists its conversation snapshot, cursor
 * and step records in that checkpoint, so none of them may nest one level
 * deeper per step. This drives a run well past 100 steps and asserts both that
 * it completes and that the nesting of the persisted state stays constant.
 */
const MSGPACK_DEPTH_LIMIT = 100;

const nextTool = createTool({
  name: 'next',
  description: 'continue',
  input: z.object({}),
  execute: async () => 'ok',
});

function depthOf(value: unknown): number {
  if (typeof value !== 'object' || value === null) return 0;
  let deepest = 0;
  for (const child of Object.values(value)) deepest = Math.max(deepest, depthOf(child));
  return 1 + deepest;
}

function makeServices(): DurableRunDeps {
  const toolbox = createToolbox([nextTool]);
  return {
    toolbox,
    options: {
      generate: async ({ step }) => ({
        content: `step ${step}`,
        toolCalls: [{ name: 'next', arguments: {} }],
      }),
      toolbox,
      conversation: createConversationHistory(),
      stopWhen: noToolCalls(),
    },
  };
}

async function runSteps(runId: string, maximumSteps: number) {
  const storage = new MemoryStorage();
  const checkpointStore = createCheckpointStore(
    textValueStore(storage, { disposeUnderlyingStorage: false }),
  );
  const activities = createStorageActivities(checkpointStore);
  const engine = await Engine.create({
    storage,
    recover: false,
    workflows: { agentRun: createRunWorkflow(checkpointStore) },
    activities: {
      saveCursor: activities.saveCursor,
      saveConversation: activities.saveConversation,
      recordStep: activities.recordStep,
    },
  });
  try {
    const handle = await engine.start(
      'agentRun',
      { runId, sessionId: runId, agentName: '', prompt: 'Loop', maximumSteps },
      { id: runId, services: makeServices() },
    );
    const result = await handle.result();
    return { result, checkpoint: await checkpointStore.loadCheckpoint(runId) };
  } finally {
    engine[Symbol.dispose]();
  }
}

afterEach(async () => {
  await yieldToPortableEventLoop();
});

describe('durable agentRun checkpoint nesting', () => {
  it('keeps persisted run state at constant depth across more than 100 steps', async () => {
    const short = await runSteps('depth-short', 20);
    const long = await runSteps('depth-long', 120);

    expect(long.result.steps).toBe(120);
    expect(long.checkpoint.steps).toHaveLength(120);

    const shortDepth = depthOf(short.checkpoint);
    const longDepth = depthOf(long.checkpoint);
    // More steps must not add nesting, and the state stays far from the limit.
    expect(longDepth).toBe(shortDepth);
    expect(longDepth).toBeLessThan(MSGPACK_DEPTH_LIMIT / 4);
    expect(depthOf(long.checkpoint.conversation)).toBeLessThan(MSGPACK_DEPTH_LIMIT / 4);
    expect(depthOf(long.checkpoint.cursor)).toBeLessThan(10);
  }, 60_000);
});
