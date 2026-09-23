import { type GenerateFunction, stopWhen, waitForCondition } from '@lostgradient/operative';
import { createTestToolbox, createTool, createToolbox, type Tool } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { createBureau } from './create-bureau';
import type { ServerFrame } from './types';

describe('Bureau.getRunReport', () => {
  it('returns a cached succeeded report once the run completes, and emits a run-finished frame', async () => {
    const bureau = await createBureau({
      agents: {},
      generate: async () => ({ content: 'Done.', toolCalls: [] }),
      toolbox: createToolbox<readonly Tool[]>([]),
      stopWhen: stopWhen.noToolCalls(),
    });

    const runEnvelopeFrames: Extract<ServerFrame, { type: 'run-envelope' }>[] = [];
    const unsubscribe = bureau.subscribeLiveFrames((frame) => {
      if (frame.type === 'run-envelope') runEnvelopeFrames.push(frame);
    });

    const run = await bureau.createRun({ message: 'Hello' });

    await waitForCondition(() => {
      const report = bureau.getRunReport(run.id);
      return Boolean(
        report && report.status !== undefined && bureau.getRun(run.id)?.status !== 'running',
      );
    }, `Run ${run.id} did not reach a terminal report`);

    const report = bureau.getRunReport(run.id);
    expect(report?.status).toBe('succeeded');
    expect(report?.runId).toBe(run.id);

    const runStartedFrame = runEnvelopeFrames.find((f) => f.frame.type === 'run-started');
    expect(runStartedFrame).toBeDefined();
    const runFinishedFrame = runEnvelopeFrames.find((f) => f.frame.type === 'run-finished');
    expect(runFinishedFrame).toBeDefined();
    if (runFinishedFrame?.frame.type === 'run-finished') {
      expect(runFinishedFrame.frame.report.status).toBe('succeeded');
    }

    // Every emitted run-envelope frame round-trips JSON.parse(JSON.stringify(x)).
    for (const { frame } of runEnvelopeFrames) {
      const roundTripped: unknown = JSON.parse(JSON.stringify(frame));
      expect(roundTripped).toEqual(JSON.parse(JSON.stringify(frame)));
    }

    unsubscribe();
    bureau.dispose();
  });

  it('returns undefined for an unknown run id', async () => {
    const bureau = await createBureau({
      agents: {},
      generate: async () => ({ content: 'Done.', toolCalls: [] }),
      toolbox: createToolbox<readonly Tool[]>([]),
    });

    expect(bureau.getRunReport('does-not-exist')).toBeUndefined();

    bureau.dispose();
  });

  it('graceful shutdown: synchronously returns a partial report with accumulated usage and transcript when a run is killed mid-step (regression)', async () => {
    // REGRESSION (AB-96): the embedder must be able to call abortRun() then
    // IMMEDIATELY (no await) call getRunReport() and get back the usage +
    // transcript accumulated through the last completed step — not an
    // undefined/empty report, and not something that requires waiting for
    // the abort to fully settle.
    const addTool = createTool({
      name: 'add',
      description: 'add two numbers',
      input: z.object({ a: z.number(), b: z.number() }),
      execute: async ({ a, b }) => a + b,
    });

    let resolveSecondStep: ((response: { content: string; toolCalls: [] }) => void) | undefined;
    const secondStepPending = new Promise<{ content: string; toolCalls: [] }>((resolve) => {
      resolveSecondStep = resolve;
    });

    const generate: GenerateFunction = async ({ step, signal }) => {
      if (step === 0) {
        return {
          content: '',
          toolCalls: [{ name: 'add', arguments: { a: 2, b: 3 } }],
          usage: { prompt: 5, completion: 2, total: 7 },
        };
      }
      // Step 1 hangs until the test resolves it (never, in the abort case) or
      // the run is aborted, in which case the loop's own abort handling wins.
      return Promise.race([
        secondStepPending,
        new Promise<{ content: string; toolCalls: [] }>((resolve) => {
          signal?.addEventListener('abort', () => resolve({ content: '', toolCalls: [] }), {
            once: true,
          });
        }),
      ]);
    };

    const bureau = await createBureau({
      agents: {},
      generate,
      toolbox: createTestToolbox([addTool]),
    });

    const run = await bureau.createRun({ message: 'Add 2 and 3, then keep going' });

    // Wait until step 0 (the tool call) has been recorded in the store before
    // killing the run — this is what makes the report "partial but non-empty".
    await waitForCondition(() => {
      const runState = bureau.store.getRun(run.id);
      return Boolean(runState && runState.steps.length > 0);
    }, `Run ${run.id} never recorded a step`);

    bureau.abortRun(run.id);
    // NO await here — this is the synchronous graceful-shutdown call.
    const partialReport = bureau.getRunReport(run.id);

    expect(partialReport).toBeDefined();
    expect(partialReport?.status).toBe('aborted');
    expect(partialReport?.usage.total).toBeGreaterThan(0);
    expect(partialReport?.transcript).toBeDefined();
    const toolCallMessage = Object.values(partialReport!.transcript!.messages).find(
      (m) => m.toolCall,
    );
    expect(toolCallMessage?.toolCall?.name).toBe('add');

    resolveSecondStep?.({ content: 'unused', toolCalls: [] });
    bureau.dispose();
  });
});
