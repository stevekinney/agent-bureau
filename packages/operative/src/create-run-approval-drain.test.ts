import { getEventListeners } from 'node:events';

import { createTool, createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';
import { z } from 'zod';

import { createActiveRun } from './create-run';
import type { ToolSettledBubbleEvent } from './events';
import { createMockGenerate } from './test/index';
import type { GenerateResponse } from './types';

function approvalResponse(callId: string): GenerateResponse {
  return { content: '', toolCalls: [{ id: callId, name: 'approval-tool', arguments: {} }] };
}

describe('approval drain contract', () => {
  it.each(['needs_approval', 'needs_input'] as const)(
    'disposes a %s maximum-steps run with one paused settlement',
    async (gateStatus) => {
      let callbackCount = 0;
      const tool = createTool({
        name: 'approval-tool',
        description: 'Approval drain test tool',
        input: z.object({}),
        policy: { beforeExecute: () => ({ status: gateStatus, reason: 'Approve this call' }) },
        execute: async () => {
          callbackCount += 1;
          return 'must not execute';
        },
      });
      const toolbox = createToolbox([tool]);
      const activeRun = createActiveRun({
        generate: createMockGenerate([approvalResponse('approval-call')]),
        toolbox,
        conversation: new Conversation(),
        maximumSteps: 1,
        runId: 'approval-run',
        executeOptions: { ownerId: 'approval-run' },
      });
      const curatedSettlements: ToolSettledBubbleEvent[] = [];
      activeRun.addEventListener('tool.settled', (event) => curatedSettlements.push(event));
      let executeStarts = 0;
      let settlements = 0;
      toolbox.addEventListener('execute-start', () => {
        executeStarts += 1;
      });
      toolbox.addEventListener('settled', () => {
        settlements += 1;
      });
      const closed = activeRun.closed();

      const result = await activeRun.result;

      expect(result.finishReason).toBe('maximum-steps');
      expect(result.steps[0]?.results[0]?.outcome).toBe('action_required');
      expect(callbackCount).toBe(0);
      expect(executeStarts).toBe(1);
      expect(settlements).toBe(1);
      expect(curatedSettlements).toHaveLength(1);
      expect(curatedSettlements[0]).toMatchObject({
        status: 'paused',
        toolCallId: 'approval-call',
        runId: 'approval-run',
        result: undefined,
        error: undefined,
      });
      activeRun[Symbol.dispose]();
      expect(await closed).toEqual({ status: 'completed' });
    },
  );

  it('drains three sequential and three concurrent approval runs on one toolbox', async () => {
    const callbackCounts = { value: 0 };
    const tool = createTool({
      name: 'approval-tool',
      description: 'Approval drain test tool',
      input: z.object({}),
      policy: { beforeExecute: () => ({ status: 'needs_approval', reason: 'Approve this call' }) },
      execute: async () => {
        callbackCounts.value += 1;
        return 'must not execute';
      },
    });
    const toolbox = createToolbox([tool]);
    let target: EventTarget | undefined;
    const originalAddEventListener = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function (type, listener, options) {
      // The temporary wrapper is the narrow capture needed to inspect the actual emitter.
      // eslint-disable-next-line @typescript-eslint/no-this-alias
      target ??= this;
      if (listener === null) return;
      return originalAddEventListener.call(this, type, listener, options);
    };
    try {
      const unsubscribe = toolbox.addEventListener('execute-start', () => {});
      unsubscribe();
    } finally {
      EventTarget.prototype.addEventListener = originalAddEventListener;
    }
    if (!target) throw new Error('failed to capture toolbox EventTarget');
    const listenerTypes = ['execute-start', 'settled', 'progress', 'policy-denied'] as const;
    const listenerCounts = () =>
      Object.fromEntries(
        listenerTypes.map((type) => [type, getEventListeners(target!, type).length]),
      );
    const run = (runId: string) =>
      createActiveRun({
        generate: createMockGenerate([approvalResponse(`${runId}-call`)]),
        toolbox,
        conversation: new Conversation(),
        maximumSteps: 1,
        runId,
        executeOptions: { ownerId: runId },
      });

    const baseline = listenerCounts();
    expect(baseline).toEqual({
      'execute-start': 0,
      settled: 0,
      progress: 0,
      'policy-denied': 0,
    });
    for (const runId of ['sequential-1', 'sequential-2', 'sequential-3']) {
      const activeRun = run(runId);
      const closed = activeRun.closed();
      const result = await activeRun.result;
      expect(result.finishReason).toBe('maximum-steps');
      expect(result.steps[0]?.results[0]?.outcome).toBe('action_required');
      activeRun[Symbol.dispose]();
      await closed;
      expect(listenerCounts()).toEqual(baseline);
    }

    const concurrentRuns = ['concurrent-1', 'concurrent-2', 'concurrent-3'].map(run);
    const closed = concurrentRuns.map((activeRun) => activeRun.closed());
    const results = await Promise.all(concurrentRuns.map((activeRun) => activeRun.result));
    expect(results.map((result) => result.finishReason)).toEqual([
      'maximum-steps',
      'maximum-steps',
      'maximum-steps',
    ]);
    expect(
      results.every((result) => result.steps[0]?.results[0]?.outcome === 'action_required'),
    ).toBe(true);
    expect(results.map((result) => result.steps[0]?.results[0]?.toolCallId)).toEqual([
      'concurrent-1-call',
      'concurrent-2-call',
      'concurrent-3-call',
    ]);
    concurrentRuns.forEach((activeRun) => activeRun[Symbol.dispose]());
    await Promise.all(closed);
    expect(listenerCounts()).toEqual(baseline);
    expect(callbackCounts.value).toBe(0);
  });
});
