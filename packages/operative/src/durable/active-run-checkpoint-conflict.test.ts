import { CompletableEventTarget } from '@lostgradient/lifecycle';
import { WorkflowCheckpointConflictError } from '@lostgradient/weft';
import { createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { createConversationHistory } from 'conversationalist';

import { stopWhen } from '../conditions/index';
import {
  type CombinedOperativeEventMap,
  RunAbortedEvent,
  RunCompletedEvent,
  RunErrorEvent,
} from '../events';
import type { RunOptions } from '../types';
import { createDurableActiveRun } from './active-run-create';
import { reattachDurableActiveRun } from './active-run-reattach';
import type { RegistryAgnosticEngine } from './create-run-engine';

/**
 * COR-1408: two live engines over one store; the one that loses a checkpoint
 * compare-and-swap rejects its `handle.result()` with
 * `WorkflowCheckpointConflictError`. The winning engine owns the run's durable
 * state, so the losing side must treat the rejection like a crashed engine —
 * resolve quietly, fire no terminal lifecycle, read no checkpoint — and
 * classify the run unresolved/unreachable for `closed()`.
 */

function runOptions(): RunOptions {
  return {
    generate: async () => ({ content: 'unused', toolCalls: [] }),
    toolbox: createToolbox([]),
    conversation: createConversationHistory(),
    stopWhen: stopWhen.noToolCalls(),
  };
}

function observeTerminalLifecycle(emitter: CompletableEventTarget<CombinedOperativeEventMap>) {
  const terminalEvents: string[] = [];
  for (const type of [RunCompletedEvent.type, RunErrorEvent.type, RunAbortedEvent.type]) {
    emitter.addEventListener(type, () => terminalEvents.push(type));
  }
  return terminalEvents;
}

/** A checkpoint store that fails the test on any read: a losing run must not reconstruct. */
const forbiddenCheckpointStore = {
  loadCheckpoint: async () => {
    throw new Error('the losing engine must not read the winner’s checkpoint');
  },
};

describe('a run whose engine lost a checkpoint compare-and-swap', () => {
  it('resolves a fresh run quietly, fires no terminal lifecycle, and classifies it unreachable', async () => {
    const conflict = new WorkflowCheckpointConflictError('durable-checkpoint-conflict');
    const engine = {
      start: async () => ({ result: () => Promise.reject(conflict) }),
    } as unknown as RegistryAgnosticEngine;
    const emitter = new CompletableEventTarget<CombinedOperativeEventMap>();
    const terminalEvents = observeTerminalLifecycle(emitter);

    const activeRun = createDurableActiveRun(
      { engine, checkpointStore: forbiddenCheckpointStore } as never,
      {
        runId: 'durable-checkpoint-conflict',
        sessionId: 'durable-checkpoint-conflict',
        options: runOptions(),
        emitter,
      },
    );

    const result = await activeRun.result;
    await Promise.resolve();

    expect(result.finishReason).toBe('aborted');
    expect(terminalEvents).toEqual([]);
    expect(await activeRun.closed()).toEqual({ status: 'unresolved', reason: 'unreachable' });
  });

  it('resolves a reattached run quietly, fires no terminal lifecycle, and classifies it unreachable', async () => {
    const conflict = new WorkflowCheckpointConflictError('reattach-checkpoint-conflict');
    const emitter = new CompletableEventTarget<CombinedOperativeEventMap>();
    const terminalEvents = observeTerminalLifecycle(emitter);

    const recoveredRun = reattachDurableActiveRun(
      { engine: {} as RegistryAgnosticEngine, checkpointStore: forbiddenCheckpointStore as never },
      {
        runId: 'reattach-checkpoint-conflict',
        handle: { id: 'reattach-checkpoint-conflict', result: () => Promise.reject(conflict) },
        emitter,
      },
    );

    const result = await recoveredRun.result;

    expect(result.finishReason).toBe('aborted');
    expect(terminalEvents).toEqual([]);
    expect(await recoveredRun.closed()).toEqual({ status: 'unresolved', reason: 'unreachable' });
  });
});
