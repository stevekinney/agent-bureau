import { createTool, createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';
import { z } from 'zod';

import { noToolCalls } from '../src/conditions/predicates';
import { createRun } from '../src/create-run';
import type { OperativeEventType } from '../src/events';
import { createMockGenerate, createRunRecorder } from '../src/test/index';
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

describe('events', () => {
  it('every event type fires at the correct point during a two-step loop', async () => {
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

    const recorder = createRunRecorder(activeRun);
    const result = await activeRun.result;

    expect(result.finishReason).toBe('stop-condition');
    expect(result.steps).toHaveLength(2);

    const types = recorder.events.map((event) => event.type);

    expect(types[0]).toBe('run.started');

    // Step 0: tool call turn
    expect(types[1]).toBe('step.started');
    expect(types[2]).toBe('generate.started');
    expect(types[3]).toBe('generate.completed');
    expect(types[4]).toBe('usage.accumulated');
    expect(types[5]).toBe('tools.executing');
    expect(types[6]).toBe('tools.executed');
    expect(types[7]).toBe('step.generated');
    expect(types[8]).toBe('step.completed');

    // Step 1: text-only turn
    expect(types[9]).toBe('step.started');
    expect(types[10]).toBe('generate.started');
    expect(types[11]).toBe('generate.completed');
    expect(types[12]).toBe('usage.accumulated');
    expect(types[13]).toBe('step.generated');
    expect(types[14]).toBe('step.completed');

    // Run completed
    expect(types[15]).toBe('run.completed');
    expect(types).toHaveLength(16);
  });

  it('chronological ordering across a multi-turn loop', async () => {
    const generate = createMockGenerate([
      toolCallResponse([weatherToolCall('Denver')]),
      toolCallResponse([weatherToolCall('Seattle')]),
      textResponse('Both cities are warm.'),
    ]);

    const toolbox = createToolbox([weatherTool]);
    const conversation = new Conversation();

    const activeRun = createRun({
      generate,
      toolbox,
      conversation,
      stopWhen: noToolCalls(),
    });

    const recorder = createRunRecorder(activeRun);
    await activeRun.result;

    const types = recorder.events.map((event) => event.type);

    const expectedSequence: OperativeEventType[] = [
      'run.started',
      // Step 0
      'step.started',
      'generate.started',
      'generate.completed',
      'usage.accumulated',
      'tools.executing',
      'tools.executed',
      'step.generated',
      'step.completed',
      // Step 1
      'step.started',
      'generate.started',
      'generate.completed',
      'usage.accumulated',
      'tools.executing',
      'tools.executed',
      'step.generated',
      'step.completed',
      // Step 2 (text-only)
      'step.started',
      'generate.started',
      'generate.completed',
      'usage.accumulated',
      'step.generated',
      'step.completed',
      // Done
      'run.completed',
    ];

    expect(types).toEqual(expectedSequence);
  });

  it('no tools.* events on text-only turns', async () => {
    const generate = createMockGenerate([textResponse('Just text.')]);

    const toolbox = createToolbox([]);
    const conversation = new Conversation();

    const activeRun = createRun({
      generate,
      toolbox,
      conversation,
      stopWhen: noToolCalls(),
    });

    const recorder = createRunRecorder(activeRun);
    await activeRun.result;

    const types = recorder.events.map((event) => event.type);

    expect(types).not.toContain('tools.executing');
    expect(types).not.toContain('tools.executed');
    expect(types).toEqual([
      'run.started',
      'step.started',
      'generate.started',
      'generate.completed',
      'usage.accumulated',
      'step.generated',
      'step.completed',
      'run.completed',
    ]);
  });

  it('event details contain correct conversation snapshots', async () => {
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

    const recorder = createRunRecorder(activeRun);
    await activeRun.result;

    // run.started detail has conversation
    const runStarted = recorder.events.find((event) => event.type === 'run.started');
    expect(runStarted).toBeDefined();
    expect(runStarted!.detail).toHaveProperty('conversation');
    expect((runStarted!.detail as { conversation: Conversation }).conversation).toBeInstanceOf(
      Conversation,
    );

    // step.started details have step numbers
    const stepStartedEvents = recorder.events.filter((event) => event.type === 'step.started');
    expect(stepStartedEvents).toHaveLength(2);
    expect((stepStartedEvents[0].detail as { step: number }).step).toBe(0);
    expect((stepStartedEvents[1].detail as { step: number }).step).toBe(1);

    // step.generated details have step and content
    const stepGenerated = recorder.events.filter((event) => event.type === 'step.generated');
    expect(stepGenerated).toHaveLength(2);
    expect((stepGenerated[0].detail as { step: number; content: string }).step).toBe(0);
    expect((stepGenerated[1].detail as { step: number; content: string }).content).toBe('Done.');

    // run.completed detail has finishReason and steps
    const runCompleted = recorder.events.find((event) => event.type === 'run.completed');
    expect(runCompleted).toBeDefined();
    expect((runCompleted!.detail as { finishReason: string }).finishReason).toBe('stop-condition');
    expect((runCompleted!.detail as { steps: readonly unknown[] }).steps).toHaveLength(2);
  });
});
