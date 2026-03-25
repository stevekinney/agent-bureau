import { createTool, createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';
import { z } from 'zod';

import { noToolCalls } from '../src/conditions/predicates';
import { createRun } from '../src/create-run';
import type { CombinedOperativeEventType } from '../src/events';
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

    const activeRun = createRun({
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

    const activeRun = createRun({
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

    const activeRun = createRun({
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

    const activeRun = createRun({
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

    const activeRun = createRun({
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

    const activeRun = createRun({
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
});
