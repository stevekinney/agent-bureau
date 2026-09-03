import { createTool, createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';
import { z } from 'zod';

import { noToolCalls } from '../src/conditions/predicates';
import { createActiveRun } from '../src/create-run';
import type {
  CombinedOperativeEventType,
  ToolPolicyDeniedBubbleEvent,
  ToolProgressBubbleEvent,
  ToolSettledBubbleEvent,
  ToolStartedBubbleEvent,
} from '../src/events';
import { createMockGenerate } from '../src/test/index';
import type { GenerateResponse } from '../src/types';

const weatherTool = createTool({
  name: 'get_weather',
  description: 'Get weather for a location',
  input: z.object({ location: z.string() }),
  execute: async ({ location }) => ({ temperature: 72, location }),
});

function textResponse(content: string): GenerateResponse {
  return { content, toolCalls: [] };
}

function toolCallResponse(
  toolCalls: GenerateResponse['toolCalls'],
  content = '',
): GenerateResponse {
  return { content, toolCalls };
}

function weatherToolCall(location = 'Denver') {
  return { name: 'get_weather', arguments: { location } };
}

describe('event forwarding', () => {
  it('forwards toolbox events with toolbox. prefix during tool execution', async () => {
    const generate = createMockGenerate([
      toolCallResponse([weatherToolCall('Denver')]),
      textResponse('The weather is 72 degrees.'),
    ]);

    const toolbox = createToolbox([weatherTool]);
    const conversation = new Conversation();

    const activeRun = createActiveRun({
      generate,
      toolbox,
      conversation,
      stopWhen: noToolCalls(),
    });

    const forwardedEvents: CombinedOperativeEventType[] = [];
    activeRun.toObservable().subscribe({
      next(event) {
        if (event.type.startsWith('toolbox.')) {
          forwardedEvents.push(event.type as CombinedOperativeEventType);
        }
      },
    });

    await activeRun.result;

    expect(forwardedEvents).toContain('toolbox.call');
    expect(forwardedEvents).toContain('toolbox.complete');
    expect(forwardedEvents).toContain('toolbox.execute-start');
    expect(forwardedEvents).toContain('toolbox.execute-success');
    expect(forwardedEvents).toContain('toolbox.settled');
  });

  it('forwards conversation events with conversation. prefix', async () => {
    const generate = createMockGenerate([
      toolCallResponse([weatherToolCall('Denver')]),
      textResponse('Done.'),
    ]);

    const toolbox = createToolbox([weatherTool]);
    const conversation = new Conversation();

    const activeRun = createActiveRun({
      generate,
      toolbox,
      conversation,
      stopWhen: noToolCalls(),
    });

    const forwardedEvents: CombinedOperativeEventType[] = [];
    activeRun.toObservable().subscribe({
      next(event) {
        if (event.type.startsWith('conversation.')) {
          forwardedEvents.push(event.type as CombinedOperativeEventType);
        }
      },
    });

    await activeRun.result;

    expect(forwardedEvents).toContain('conversation.messages.appended');
    expect(forwardedEvents).toContain('conversation.tool-calls.appended');
    expect(forwardedEvents).toContain('conversation.tool-results.appended');
  });

  it('emits no toolbox. events on text-only turns', async () => {
    const generate = createMockGenerate([textResponse('Just text.')]);

    const toolbox = createToolbox([]);
    const conversation = new Conversation();

    const activeRun = createActiveRun({
      generate,
      toolbox,
      conversation,
      stopWhen: noToolCalls(),
    });

    const forwardedToolboxEvents: string[] = [];
    activeRun.toObservable().subscribe({
      next(event) {
        if (event.type.startsWith('toolbox.')) {
          forwardedToolboxEvents.push(event.type);
        }
      },
    });

    await activeRun.result;

    expect(forwardedToolboxEvents).toHaveLength(0);
  });

  it('stops forwarding after dispose', async () => {
    const generate = createMockGenerate([
      toolCallResponse([weatherToolCall('Denver')]),
      textResponse('Done.'),
    ]);

    const toolbox = createToolbox([weatherTool]);
    const conversation = new Conversation();

    const activeRun = createActiveRun({
      generate,
      toolbox,
      conversation,
      stopWhen: noToolCalls(),
    });

    // Wait for the run to complete, then dispose.
    await activeRun.result;
    activeRun[Symbol.dispose]();

    // After dispose, new toolbox events should not be forwarded.
    const postDisposeEvents: string[] = [];
    activeRun.toObservable().subscribe({
      next(event) {
        postDisposeEvents.push(event.type);
      },
    });

    // Trigger a toolbox event after dispose — it should not appear on the run.
    toolbox.emit('call' as any, {} as any);

    // Give a microtask for any possible delivery.
    await Promise.resolve();

    expect(postDisposeEvents).toHaveLength(0);
  });

  it('interleaves forwarded events between operative events', async () => {
    const generate = createMockGenerate([
      toolCallResponse([weatherToolCall('Denver')]),
      textResponse('Done.'),
    ]);

    const toolbox = createToolbox([weatherTool]);
    const conversation = new Conversation();

    const activeRun = createActiveRun({
      generate,
      toolbox,
      conversation,
      stopWhen: noToolCalls(),
    });

    const allEvents: string[] = [];
    activeRun.toObservable().subscribe({
      next(event) {
        allEvents.push(event.type);
      },
    });

    await activeRun.result;

    // toolbox.call should appear after tools.executing
    const toolsExecutingIndex = allEvents.indexOf('tools.executing');
    const toolboxCallIndex = allEvents.indexOf('toolbox.call');
    const toolsExecutedIndex = allEvents.indexOf('tools.executed');

    expect(toolsExecutingIndex).toBeGreaterThanOrEqual(0);
    expect(toolboxCallIndex).toBeGreaterThanOrEqual(0);
    expect(toolsExecutedIndex).toBeGreaterThanOrEqual(0);

    // toolbox events happen between tools.executing and tools.executed
    expect(toolboxCallIndex).toBeGreaterThan(toolsExecutingIndex);
    expect(toolboxCallIndex).toBeLessThan(toolsExecutedIndex);
  });

  it('can listen to specific forwarded event types via addEventListener', async () => {
    const generate = createMockGenerate([
      toolCallResponse([weatherToolCall('Denver')]),
      textResponse('Done.'),
    ]);

    const toolbox = createToolbox([weatherTool]);
    const conversation = new Conversation();

    const activeRun = createActiveRun({
      generate,
      toolbox,
      conversation,
      stopWhen: noToolCalls(),
    });

    const callEvents: unknown[] = [];
    activeRun.addEventListener('toolbox.call', (event) => {
      callEvents.push(event);
    });

    await activeRun.result;

    expect(callEvents).toHaveLength(1);
    // Forwarded events wrap the original; properties are directly on the original event
    const forwarded = callEvents[0] as { originalEvent: Event };
    expect(forwarded.originalEvent).toHaveProperty('tool');
    expect(forwarded.originalEvent).toHaveProperty('call');
  });

  it('forwards manual toolbox progress and policy-denied events while a run is active', async () => {
    let resolveGenerate: ((response: GenerateResponse) => void) | undefined;
    let markGenerateStarted: (() => void) | undefined;
    const generateStarted = new Promise<void>((resolve) => {
      markGenerateStarted = resolve;
    });
    const generate = () =>
      new Promise<GenerateResponse>((resolve) => {
        resolveGenerate = resolve;
        markGenerateStarted?.();
      });
    const toolbox = createToolbox([weatherTool]);
    const conversation = new Conversation();
    const activeRun = createActiveRun({
      agentName: 'agent-a',
      runId: 'run-a',
      generate,
      toolbox,
      conversation,
      stopWhen: noToolCalls(),
    });
    const events: string[] = [];

    activeRun.toObservable().subscribe({
      next(event) {
        events.push(event.type);
      },
    });

    await generateStarted;
    toolbox.emit(
      'progress' as never,
      {
        call: { id: 'call-1', name: 'get_weather' },
        percent: 50,
        message: 'halfway',
        // AB-290: matches this run's own `runId` above — the curated
        // `tool.progress` bubble now requires it before forwarding.
        ownerId: 'run-a',
      } as never,
    );
    toolbox.emit(
      'policy-denied' as never,
      {
        call: { id: 'call-1', name: 'get_weather' },
        reason: 'blocked',
      } as never,
    );
    resolveGenerate?.(textResponse('Done.'));

    await activeRun.result;

    expect(events).toContain('tool.progress');
    expect(events).toContain('tool.policy-denied');
  });

  it('forwards a loop-blocked rejection to the run layer as a non-silent toolbox.error signal (AB-231)', async () => {
    const responses: GenerateResponse[] = [];
    for (let i = 0; i < 5; i++) {
      responses.push(toolCallResponse([weatherToolCall('Denver')]));
    }
    responses.push(textResponse('Done.'));
    const generate = createMockGenerate(responses);

    const toolbox = createToolbox([weatherTool], {
      loopDetection: { warningThreshold: 2, blockThreshold: 4, maxWindowSize: 30 },
    });
    const conversation = new Conversation();

    const activeRun = createActiveRun({
      generate,
      toolbox,
      conversation,
      stopWhen: noToolCalls(),
    });

    const forwardedErrorEvents: Array<{ originalEvent: unknown }> = [];
    activeRun.addEventListener('toolbox.error', (event) => {
      forwardedErrorEvents.push(event as { originalEvent: unknown });
    });

    await activeRun.result;

    expect(forwardedErrorEvents.length).toBeGreaterThan(0);
    const loopBlockedError = forwardedErrorEvents.find((e) => {
      const original = e.originalEvent as {
        result?: { error?: { code?: string; category?: string } };
      };
      return (
        original.result?.error?.code === 'LOOP_BLOCKED' &&
        original.result?.error?.category === 'conflict'
      );
    });
    expect(loopBlockedError).toBeDefined();
  });
});

describe('event forwarding — selectTools-swapped step toolbox (AB-239)', () => {
  it('forwards a budget-exceeded event from a swapped step toolbox with the toolbox prefix', async () => {
    const baseToolbox = createToolbox([weatherTool]);
    const swappedToolbox = createToolbox([weatherTool], { budget: { maxCalls: 1 } });
    const conversation = new Conversation();

    const generate = createMockGenerate([
      toolCallResponse([weatherToolCall('Denver')]),
      toolCallResponse([weatherToolCall('Denver')]),
      textResponse('Done.'),
    ]);

    const activeRun = createActiveRun({
      generate,
      toolbox: baseToolbox,
      conversation,
      stopWhen: noToolCalls(),
      // Every step uses the swapped toolbox, never the base one.
      selectTools: () => swappedToolbox,
    });

    const forwardedEvents: string[] = [];
    activeRun.toObservable().subscribe({
      next(event) {
        if (event.type.startsWith('toolbox.')) forwardedEvents.push(event.type);
      },
    });

    await activeRun.result;

    // The first call passes the budget; the second (same swapped toolbox,
    // second step) trips `maxCalls: 1`.
    expect(forwardedEvents).toContain('toolbox.budget-exceeded');
    expect(forwardedEvents).toContain('toolbox.error');
    // Exactly two `toolbox.call`s, both from the swapped toolbox (the base
    // toolbox is never used, so it never contributes a duplicate).
    expect(forwardedEvents.filter((type) => type === 'toolbox.call')).toHaveLength(2);
  });

  it('forwards a loop-blocked companion error from a swapped step toolbox with the toolbox prefix', async () => {
    const baseToolbox = createToolbox([weatherTool]);
    const swappedToolbox = createToolbox([weatherTool], {
      loopDetection: { warningThreshold: 2, blockThreshold: 4, maxWindowSize: 30 },
    });
    const conversation = new Conversation();

    const responses: GenerateResponse[] = [];
    for (let i = 0; i < 5; i++) {
      responses.push(toolCallResponse([weatherToolCall('Denver')]));
    }
    responses.push(textResponse('Done.'));
    const generate = createMockGenerate(responses);

    const activeRun = createActiveRun({
      generate,
      toolbox: baseToolbox,
      conversation,
      stopWhen: noToolCalls(),
      selectTools: () => swappedToolbox,
    });

    const forwardedErrorEvents: Array<{ originalEvent: unknown }> = [];
    activeRun.addEventListener('toolbox.error', (event) => {
      forwardedErrorEvents.push(event as { originalEvent: unknown });
    });

    await activeRun.result;

    const loopBlockedError = forwardedErrorEvents.find((e) => {
      const original = e.originalEvent as {
        result?: { error?: { code?: string; category?: string } };
      };
      return (
        original.result?.error?.code === 'LOOP_BLOCKED' &&
        original.result?.error?.category === 'conflict'
      );
    });
    expect(loopBlockedError).toBeDefined();
  });

  it('does not duplicate toolbox events when selectTools returns the original toolbox instance', async () => {
    const toolbox = createToolbox([weatherTool]);
    const conversation = new Conversation();

    const generate = createMockGenerate([
      toolCallResponse([weatherToolCall('Denver')]),
      textResponse('Done.'),
    ]);

    const activeRun = createActiveRun({
      generate,
      toolbox,
      conversation,
      stopWhen: noToolCalls(),
      // Explicitly returns the SAME instance as `options.toolbox` — this is
      // the "no swap" case the forwarder must not double-subscribe for.
      selectTools: () => toolbox,
    });

    const callEvents: unknown[] = [];
    activeRun.addEventListener('toolbox.call', (event) => callEvents.push(event));

    await activeRun.result;

    expect(callEvents).toHaveLength(1);
  });
});

describe('curated tool.* bubble events — selectTools-swapped step toolbox (AB-294)', () => {
  const echoTool = createTool({
    name: 'echo',
    description: 'Echo the input',
    input: z.object({ message: z.string() }),
    execute: async ({ message }) => message,
  });

  it('forwards tool.started, tool.settled, tool.progress, and tool.policy-denied from a swapped step toolbox', async () => {
    const baseToolbox = createToolbox([echoTool]);
    const swappedToolbox = createToolbox([echoTool]);
    const conversation = new Conversation();

    let resolveGenerate: ((response: GenerateResponse) => void) | undefined;
    let markGenerateStarted: (() => void) | undefined;
    const generateStarted = new Promise<void>((resolve) => {
      markGenerateStarted = resolve;
    });

    const activeRun = createActiveRun({
      generate: () =>
        new Promise<GenerateResponse>((resolve) => {
          resolveGenerate = resolve;
          markGenerateStarted?.();
        }),
      toolbox: baseToolbox,
      conversation,
      stopWhen: noToolCalls(),
      // Every step uses the swapped toolbox, never the base one — the base
      // toolbox's own listeners must never see these injected events.
      selectTools: () => swappedToolbox,
    });

    const started: ToolStartedBubbleEvent[] = [];
    const settled: ToolSettledBubbleEvent[] = [];
    const progress: ToolProgressBubbleEvent[] = [];
    const denied: ToolPolicyDeniedBubbleEvent[] = [];
    activeRun.addEventListener('tool.started', (e) => started.push(e));
    activeRun.addEventListener('tool.settled', (e) => settled.push(e));
    activeRun.addEventListener('tool.progress', (e) => progress.push(e));
    activeRun.addEventListener('tool.policy-denied', (e) => denied.push(e));

    // The step's toolbox is resolved (and `onStepToolbox` opens the swap
    // subscription) before `generate` is called — see `run-step.ts`. Once
    // the mock generate has started, the swap subscription is guaranteed
    // open, so events emitted directly on `swappedToolbox` here are
    // forwarded exactly as a real tool call's would be.
    await generateStarted;
    const call = { id: 'call-1', name: 'echo', arguments: { message: 'hi' } };
    swappedToolbox.emit('execute-start', { tool: echoTool, call, params: { message: 'hi' } });
    swappedToolbox.emit('progress', { tool: echoTool, call, percent: 50, message: 'halfway' });
    swappedToolbox.emit('policy-denied', {
      tool: echoTool,
      call,
      params: { message: 'hi' },
      reason: 'blocked',
    });
    swappedToolbox.emit('settled', { tool: echoTool, call, result: 'hi', error: undefined });
    resolveGenerate?.(textResponse('Done.'));

    await activeRun.result;

    expect(started).toHaveLength(1);
    expect(started[0]?.toolName).toBe('echo');
    expect(settled).toHaveLength(1);
    expect(settled[0]?.toolName).toBe('echo');
    expect(progress).toHaveLength(1);
    expect(progress[0]?.toolName).toBe('echo');
    expect(progress[0]?.percent).toBe(50);
    expect(denied).toHaveLength(1);
    expect(denied[0]?.toolName).toBe('echo');
    expect(denied[0]?.reason).toBe('blocked');
  });

  it('does not duplicate curated tool.* bubble events when selectTools returns the original toolbox instance', async () => {
    const toolbox = createToolbox([echoTool]);
    const conversation = new Conversation();

    const generate = createMockGenerate([
      toolCallResponse([{ name: 'echo', arguments: { message: 'hi' } }]),
      textResponse('Done.'),
    ]);

    const activeRun = createActiveRun({
      generate,
      toolbox,
      conversation,
      stopWhen: noToolCalls(),
      // Explicitly returns the SAME instance as `options.toolbox` — this is
      // the "no swap" case the forwarder must not double-subscribe for.
      selectTools: () => toolbox,
    });

    const started: ToolStartedBubbleEvent[] = [];
    const settled: ToolSettledBubbleEvent[] = [];
    activeRun.addEventListener('tool.started', (e) => started.push(e));
    activeRun.addEventListener('tool.settled', (e) => settled.push(e));

    await activeRun.result;

    expect(started).toHaveLength(1);
    expect(settled).toHaveLength(1);
  });
});
