/**
 * Tests for AB-96's bureau-side run envelope wiring:
 * `createRunFrameForwarder`, `buildTerminalReportFromCompletedEvent`,
 * `buildTerminalReportFromAbortedEvent`, `buildPartialRunReport`, and the
 * `Bureau.getRunReport` / `run-envelope` `ServerFrame` surface they feed.
 */
import { createTool, createToolbox } from 'armorer';
import { createTestToolbox } from 'armorer/test';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';
import {
  type ActiveRun,
  createActiveRun,
  type GenerateFunction,
  type RunFrame,
  runFrameSchema,
  type Toolbox,
} from 'operative';
import { z } from 'zod';

import { createBureau } from './create-bureau';
import {
  buildPartialRunReport,
  buildTerminalReportFromAbortedEvent,
  buildTerminalReportFromCompletedEvent,
  createRunFrameForwarder,
} from './run-envelope';
import type { ServerFrame } from './types';

function createEmptyToolbox(): Toolbox {
  return createToolbox([]) as unknown as Toolbox;
}

function roundTrip<T>(value: T): unknown {
  return JSON.parse(JSON.stringify(value));
}

describe('createRunFrameForwarder', () => {
  it('forwards run-started through tool-pre/tool-post to run-finished frames, all JSON round-trip-safe', async () => {
    const addTool = createTool({
      name: 'add',
      description: 'add two numbers',
      input: z.object({ a: z.number(), b: z.number(), apiKey: z.string().optional() }),
      execute: async ({ a, b }) => ({ total: a + b }),
    });

    const generate: GenerateFunction = async ({ step }) =>
      step === 0
        ? {
            content: '',
            toolCalls: [{ name: 'add', arguments: { a: 2, b: 2, apiKey: 'sk-secret' } }],
          }
        : { content: 'The answer is 4.', toolCalls: [] };

    const activeRun: ActiveRun = createActiveRun({
      generate,
      toolbox: createTestToolbox([addTool]),
      conversation: new Conversation(),
      maximumSteps: 5,
      agentName: 'test-agent',
      runId: 'run-forwarder-1',
    });

    const frames: RunFrame[] = [];
    const dispose = createRunFrameForwarder('run-forwarder-1', activeRun, (frame) => {
      frames.push(frame);
    });

    await activeRun.result;
    dispose();

    // Every frame is JSON-safe and validates against the exported schema.
    for (const frame of frames) {
      const roundTripped = roundTrip(frame);
      expect(roundTripped).toEqual(JSON.parse(JSON.stringify(frame)));
      expect(() => runFrameSchema.parse(roundTripped)).not.toThrow();
    }

    const types = frames.map((frame) => frame.type);
    expect(types).toContain('step');
    expect(types).toContain('tool-pre');
    expect(types).toContain('tool-post');
    expect(types).toContain('assistant-final');

    const toolPre = frames.find((frame) => frame.type === 'tool-pre');
    expect(toolPre?.type).toBe('tool-pre');
    if (toolPre?.type === 'tool-pre') {
      expect(toolPre.toolName).toBe('add');
      // The apiKey argument is redacted, never leaked into the frame.
      expect(toolPre.inputSummary).toMatchObject({ apiKey: '[redacted]', a: 2, b: 2 });
    }

    const toolPost = frames.find((frame) => frame.type === 'tool-post');
    expect(toolPost?.type).toBe('tool-post');
    if (toolPost?.type === 'tool-post') {
      expect(toolPost.status).toBe('success');
      expect(toolPost.resultSummary).toMatchObject({ total: 4 });
    }

    // Disposing removes every listener — no more frames after dispose.
    const countAfterDispose = frames.length;
    await activeRun.result;
    expect(frames.length).toBe(countAfterDispose);
  });

  it('stops emitting frames once disposed', async () => {
    const generate: GenerateFunction = async () => ({ content: 'done', toolCalls: [] });
    const activeRun = createActiveRun({
      generate,
      toolbox: createEmptyToolbox(),
      conversation: new Conversation(),
      maximumSteps: 1,
      runId: 'run-forwarder-2',
    });

    const frames: RunFrame[] = [];
    const dispose = createRunFrameForwarder('run-forwarder-2', activeRun, (frame) =>
      frames.push(frame),
    );
    dispose();

    await activeRun.result;
    expect(frames.length).toBe(0);
  });
});

describe('buildTerminalReportFromCompletedEvent / buildTerminalReportFromAbortedEvent', () => {
  it('builds a succeeded report with usage, costEstimate, and effectiveModel from a completed run', async () => {
    const generate: GenerateFunction = async () => ({
      content: 'Done.',
      toolCalls: [],
      usage: { prompt: 10, completion: 5, total: 15 },
      metadata: { effectiveModel: 'claude-sonnet-5', effectiveEffort: 'medium' },
    });

    const activeRun = createActiveRun({
      generate,
      toolbox: createEmptyToolbox(),
      conversation: new Conversation(),
      maximumSteps: 1,
      runId: 'run-completed-1',
      costEstimation: { model: 'claude-sonnet-5' },
    });

    let captured: Parameters<typeof buildTerminalReportFromCompletedEvent>[1] | undefined;
    activeRun.once('run.completed', (event) => {
      captured = event;
    });

    const result = await activeRun.result;
    expect(result.finishReason).toBe('maximum-steps');
    expect(captured).toBeDefined();

    const report = buildTerminalReportFromCompletedEvent('run-completed-1', captured!);
    expect(report.status).toBe('succeeded');
    expect(report.usage).toEqual({ prompt: 10, completion: 5, total: 15 });
    expect(report.effectiveModel).toBe('claude-sonnet-5');
    expect(report.effectiveEffort).toBe('medium');
    expect(report.transcript?.ids.length).toBeGreaterThan(0);

    const roundTripped = roundTrip(report);
    expect(roundTripped).toEqual(JSON.parse(JSON.stringify(report)));
  });

  it('builds a budget_stopped report when the run finishes on budget-exceeded', () => {
    // Exercises the mapping/build helper directly against a hand-built event
    // shape (the same fields RunCompletedEvent carries) rather than wiring a
    // full budget monitor through a real run.
    const conversation = new Conversation();
    conversation.appendUserMessage('hi');

    const report = buildTerminalReportFromCompletedEvent('run-budget-1', {
      finishReason: 'budget-exceeded',
      usage: { prompt: 3, completion: 1, total: 4 },
      steps: [],
      conversation,
      error: new Error('budget exceeded'),
    });

    expect(report.status).toBe('budget_stopped');
    expect(report.error).toBe('budget exceeded');
  });

  it('builds an aborted report from a run.aborted event, pulling steps from the store', async () => {
    const conversation = new Conversation();
    conversation.appendUserMessage('hi');
    conversation.appendAssistantMessage('partial');

    const report = buildTerminalReportFromAbortedEvent('run-aborted-1', {
      usage: { prompt: 4, completion: 2, total: 6 },
      reason: 'user cancelled',
      steps: [],
      conversation,
    });

    expect(report.status).toBe('aborted');
    expect(report.finishReason).toBe('aborted');
    expect(report.error).toBe('user cancelled');
    expect(report.usage).toEqual({ prompt: 4, completion: 2, total: 6 });
    expect(report.transcript?.ids.length).toBeGreaterThan(0);
  });
});

describe('buildPartialRunReport', () => {
  it('synchronously builds a partial aborted report from a live RunState', () => {
    const conversation = new Conversation();
    conversation.appendUserMessage('hi');
    conversation.appendAssistantMessage('working on it', {
      effectiveModel: 'claude-sonnet-5',
      effectiveEffort: 'low',
    });

    const runState = {
      id: 'run-partial-1',
      status: 'running' as const,
      steps: [
        {
          step: 0,
          conversation,
          content: 'working on it',
          toolCalls: [],
          results: [],
          usage: { prompt: 6, completion: 3, total: 9 },
          metadata: { effectiveModel: 'claude-sonnet-5', effectiveEffort: 'low' },
          final: false,
        },
      ],
      usage: { prompt: 6, completion: 3, total: 9 },
      finishReason: undefined,
      error: undefined,
      snapshots: [],
      actions: [],
      activeRun: {} as ActiveRun,
    };

    const report = buildPartialRunReport('run-partial-1', runState, 'process shutdown');
    expect(report.status).toBe('aborted');
    expect(report.usage).toEqual({ prompt: 6, completion: 3, total: 9 });
    expect(report.effectiveModel).toBe('claude-sonnet-5');
    expect(report.error).toBe('process shutdown');
    expect(report.transcript?.ids.length).toBeGreaterThan(0);
  });
});

describe('Bureau.getRunReport', () => {
  it('returns a cached succeeded report once the run completes, and emits a run-finished frame', async () => {
    const bureau = await createBureau({
      generate: async () => ({ content: 'Done.', toolCalls: [] }),
      toolbox: createEmptyToolbox(),
    });

    const runEnvelopeFrames: Extract<ServerFrame, { type: 'run-envelope' }>[] = [];
    const unsubscribe = bureau.subscribeLiveFrames((frame) => {
      if (frame.type === 'run-envelope') runEnvelopeFrames.push(frame);
    });

    const run = await bureau.createRun({ message: 'Hello' });

    await new Promise<void>((resolve) => {
      const check = () => {
        const report = bureau.getRunReport(run.id);
        if (report && report.status !== undefined && bureau.getRun(run.id)?.status !== 'running') {
          resolve();
        } else {
          setTimeout(check, 0);
        }
      };
      check();
    });

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
      const roundTripped = roundTrip(frame);
      expect(roundTripped).toEqual(JSON.parse(JSON.stringify(frame)));
    }

    unsubscribe();
    bureau.dispose();
  });

  it('returns undefined for an unknown run id', async () => {
    const bureau = await createBureau({
      generate: async () => ({ content: 'Done.', toolCalls: [] }),
      toolbox: createEmptyToolbox(),
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
      generate,
      toolbox: createTestToolbox([addTool]) as unknown as Toolbox,
    });

    const run = await bureau.createRun({ message: 'Add 2 and 3, then keep going' });

    // Wait until step 0 (the tool call) has been recorded in the store before
    // killing the run — this is what makes the report "partial but non-empty".
    await new Promise<void>((resolve) => {
      const check = () => {
        const runState = bureau.store.getRun(run.id);
        if (runState && runState.steps.length > 0) resolve();
        else setTimeout(check, 0);
      };
      check();
    });

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
