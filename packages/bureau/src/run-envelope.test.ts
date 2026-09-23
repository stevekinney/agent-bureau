import { TypedEventTarget } from '@lostgradient/lifecycle';
import {
  type ActiveRun,
  BudgetExceededEvent,
  BudgetThresholdEvent,
  type CombinedOperativeEventMap,
  ContextBudgetWarningEvent,
  createActiveRun,
  ElicitationRequestedEvent,
  type GenerateFunction,
  type RunFrame,
  runFrameSchema,
  StreamCustomEvent,
  type StreamEventMap,
} from '@lostgradient/operative';
import { createTestToolbox, createTool, createToolbox, type Tool } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';
import { z } from 'zod';

import { createRunFrameForwarder } from './run-envelope';

function createEventDrivenActiveRun() {
  const activeRun = new TypedEventTarget<CombinedOperativeEventMap>();
  return { activeRun, dispatch: (event: Event) => activeRun.dispatchEvent(event) };
}

const generateAddThenAnswer: GenerateFunction = async ({ step }) =>
  step === 0
    ? {
        content: '',
        toolCalls: [{ name: 'add', arguments: { a: 2, b: 2, apiKey: 'sk-secret' } }],
      }
    : { content: 'The answer is 4.', toolCalls: [] };

const generateDone: GenerateFunction = async () => ({ content: 'done', toolCalls: [] });

const generateFailureThenRecovery: GenerateFunction = async ({ step }) =>
  step === 0
    ? { content: '', toolCalls: [{ name: 'explode', arguments: {} }] }
    : { content: 'recovered', toolCalls: [] };

const generateRestrictedThenContinuation: GenerateFunction = async ({ step }) =>
  step === 0
    ? { content: '', toolCalls: [{ name: 'restricted', arguments: {} }] }
    : { content: 'moving on', toolCalls: [] };

describe('createRunFrameForwarder', () => {
  it('forwards run-started through tool-pre/tool-post to run-finished frames, all JSON round-trip-safe', async () => {
    const addTool = createTool({
      name: 'add',
      description: 'add two numbers',
      input: z.object({ a: z.number(), b: z.number(), apiKey: z.string().optional() }),
      execute: async ({ a, b }) => ({ total: a + b }),
    });

    const activeRun: ActiveRun = createActiveRun({
      generate: generateAddThenAnswer,
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
      const roundTripped: unknown = JSON.parse(JSON.stringify(frame));
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
    const activeRun = createActiveRun({
      generate: generateDone,
      toolbox: createToolbox<readonly Tool[]>([]),
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

  it('emits exactly one tool-post frame for a failing tool call (regression: create-run.ts fires both tool.settled AND tool.error for the same failure)', async () => {
    const failingTool = createTool({
      name: 'explode',
      description: 'always fails',
      input: z.object({}),
      execute: async () => {
        throw new Error('kaboom');
      },
    });

    const activeRun = createActiveRun({
      generate: generateFailureThenRecovery,
      toolbox: createTestToolbox([failingTool]),
      conversation: new Conversation(),
      maximumSteps: 5,
      runId: 'run-forwarder-3',
    });

    const frames: RunFrame[] = [];
    const dispose = createRunFrameForwarder('run-forwarder-3', activeRun, (frame) =>
      frames.push(frame),
    );

    await activeRun.result;
    dispose();

    const toolPostFrames = frames.filter((frame) => frame.type === 'tool-post');
    expect(toolPostFrames.length).toBe(1);
    expect(toolPostFrames[0]?.status).toBe('error');
    expect(toolPostFrames[0]?.error).toBe('kaboom');
  });

  it('emits exactly one tool-post frame for a policy-denied tool call (regression: create-tool.ts fires policy-denied AND settled for the same denial)', async () => {
    const deniedTool = createTool({
      name: 'restricted',
      description: 'never allowed',
      input: z.object({}),
      policy: {
        beforeExecute: () => ({ allow: false, reason: 'not permitted' }),
      },
      execute: async () => 'unreachable',
    });

    const activeRun = createActiveRun({
      generate: generateRestrictedThenContinuation,
      toolbox: createTestToolbox([deniedTool]),
      conversation: new Conversation(),
      maximumSteps: 5,
      runId: 'run-forwarder-4',
    });

    const frames: RunFrame[] = [];
    const dispose = createRunFrameForwarder('run-forwarder-4', activeRun, (frame) =>
      frames.push(frame),
    );

    await activeRun.result;
    dispose();

    const toolPostFrames = frames.filter((frame) => frame.type === 'tool-post');
    expect(toolPostFrames.length).toBe(1);
    expect(toolPostFrames[0]?.status).toBe('denied');
    expect(toolPostFrames[0]?.error).toBe('not permitted');
  });

  it('emits a warning notification frame when the cost budget threshold is crossed', () => {
    const { activeRun, dispatch } = createEventDrivenActiveRun();
    const frames: RunFrame[] = [];
    const dispose = createRunFrameForwarder('run-budget-threshold', activeRun, (frame) =>
      frames.push(frame),
    );

    dispatch(
      new BudgetThresholdEvent({
        threshold: 0.8,
        currentCost: 4,
        budget: 5,
        model: 'claude-sonnet-5',
      }),
    );
    dispose();

    const notification = frames.find((frame) => frame.type === 'notification');
    expect(notification?.type).toBe('notification');
    if (notification?.type === 'notification') {
      expect(notification.level).toBe('warning');
      expect(notification.code).toBe('budget.threshold');
      expect(notification.message).toBe('Cost budget at 80% (4 of 5)');
    }
  });

  it('emits an error notification frame when the cost budget is exceeded', () => {
    const { activeRun, dispatch } = createEventDrivenActiveRun();
    const frames: RunFrame[] = [];
    const dispose = createRunFrameForwarder('run-budget-exceeded', activeRun, (frame) =>
      frames.push(frame),
    );

    dispatch(new BudgetExceededEvent({ currentCost: 6, budget: 5, model: 'claude-sonnet-5' }));
    dispose();

    const notification = frames.find((frame) => frame.type === 'notification');
    expect(notification?.type).toBe('notification');
    if (notification?.type === 'notification') {
      expect(notification.level).toBe('error');
      expect(notification.code).toBe('budget.exceeded');
      expect(notification.message).toBe('Cost budget exceeded (6 of 5)');
    }
  });

  it('emits a warning notification frame when the context window budget is running low', () => {
    const { activeRun, dispatch } = createEventDrivenActiveRun();
    const frames: RunFrame[] = [];
    const dispose = createRunFrameForwarder('run-context-budget', activeRun, (frame) =>
      frames.push(frame),
    );

    dispatch(new ContextBudgetWarningEvent(2, 7_500, 500, 8_000));
    dispose();

    const notification = frames.find((frame) => frame.type === 'notification');
    expect(notification?.type).toBe('notification');
    if (notification?.type === 'notification') {
      expect(notification.step).toBe(2);
      expect(notification.level).toBe('warning');
      expect(notification.code).toBe('context.budget-warning');
      expect(notification.message).toBe('Context budget: 500 of 8000 tokens remaining');
    }
  });

  it('emits an info notification frame for an elicitation request', () => {
    const { activeRun, dispatch } = createEventDrivenActiveRun();
    const frames: RunFrame[] = [];
    const dispose = createRunFrameForwarder('run-elicitation', activeRun, (frame) =>
      frames.push(frame),
    );

    dispatch(new ElicitationRequestedEvent(1, 'Do you want to proceed?', 'elicitation:test'));
    dispose();

    const notification = frames.find((frame) => frame.type === 'notification');
    expect(notification?.type).toBe('notification');
    if (notification?.type === 'notification') {
      expect(notification.step).toBe(1);
      expect(notification.level).toBe('info');
      expect(notification.code).toBe('elicitation.requested');
      expect(notification.message).toBe('Do you want to proceed?');
    }
  });

  it('forwards stream:text-delta events from an optional streamEventTarget into assistant-chunk frames', () => {
    const { activeRun } = createEventDrivenActiveRun();
    const streamEventTarget = new TypedEventTarget<StreamEventMap>();
    const frames: RunFrame[] = [];
    const dispose = createRunFrameForwarder(
      'run-stream-chunk',
      activeRun,
      (frame) => frames.push(frame),
      { streamEventTarget },
    );

    streamEventTarget.dispatchEvent(
      new StreamCustomEvent('stream:text-delta', {
        type: 'stream:text-delta',
        content: 'Hel',
        accumulated: 'Hel',
      }),
    );

    const chunk = frames.find((frame) => frame.type === 'assistant-chunk');
    expect(chunk?.type).toBe('assistant-chunk');
    if (chunk?.type === 'assistant-chunk') {
      expect(chunk.delta).toBe('Hel');
      expect(chunk.accumulated).toBe('Hel');
    }

    // Disposing removes the streamEventTarget listener too — no more chunks after.
    dispose();
    streamEventTarget.dispatchEvent(
      new StreamCustomEvent('stream:text-delta', {
        type: 'stream:text-delta',
        content: 'lo',
        accumulated: 'Hello',
      }),
    );
    expect(frames.filter((frame) => frame.type === 'assistant-chunk')).toHaveLength(1);
  });
});
