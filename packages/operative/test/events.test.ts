import { createTool, createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';
import { z } from 'zod';

import { noToolCalls } from '../src/conditions/predicates';
import { createActiveRun } from '../src/create-run';
import type { SteeringCommandFailure, SteeringEffectiveState } from '../src/durable/types';
import {
  AgentScheduledEvent,
  BudgetExceededEvent,
  BudgetThresholdEvent,
  type OperativeEventType,
  SessionCreatedEvent,
  SessionDeletedEvent,
  SessionLoadedEvent,
  SessionSavedEvent,
  SteeringAcceptedEvent,
  SteeringAppliedEvent,
  SteeringFailedEvent,
  SteeringRejectedEvent,
  SteeringSupersededEvent,
  WakeupScheduledEvent,
} from '../src/events';
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

    const activeRun = createActiveRun({
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

    const activeRun = createActiveRun({
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

    const activeRun = createActiveRun({
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

    const activeRun = createActiveRun({
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

  it('constructs budget and session events with the expected payload', () => {
    const threshold = new BudgetThresholdEvent({
      threshold: 0.8,
      currentCost: 0.81,
      budget: 1,
      model: 'gpt-test',
    });
    const exceeded = new BudgetExceededEvent({
      currentCost: 1.2,
      budget: 1,
      model: 'gpt-test',
    });
    const saved = new SessionSavedEvent('session-1', 'agent-a');
    const loaded = new SessionLoadedEvent('session-1', 'agent-a');
    const created = new SessionCreatedEvent('session-1', 'agent-a');
    const deleted = new SessionDeletedEvent('session-1');

    expect(threshold.type).toBe('budget.threshold');
    expect(threshold.threshold).toBe(0.8);
    expect(exceeded.type).toBe('budget.exceeded');
    expect(exceeded.currentCost).toBe(1.2);
    expect(saved.agentName).toBe('agent-a');
    expect(loaded.sessionId).toBe('session-1');
    expect(created.type).toBe('session.created');
    expect(deleted.type).toBe('session.deleted');
  });

  it('constructs scheduling events with the expected payload', () => {
    const scheduled = new AgentScheduledEvent({
      agentName: 'assistant',
      scheduleId: 'schedule-1',
      spec: { every: '1h' },
      sessionId: 'session-1',
    });
    const wakeup = new WakeupScheduledEvent(5000, 'resume work');

    expect(scheduled.type).toBe('schedule.created');
    expect(scheduled.agentName).toBe('assistant');
    expect(scheduled.scheduleId).toBe('schedule-1');
    expect(scheduled.spec).toEqual({ every: '1h' });
    expect(scheduled.sessionId).toBe('session-1');
    expect(wakeup.type).toBe('schedule.wakeup');
    expect(wakeup.duration).toBe(5000);
    expect(wakeup.note).toBe('resume work');
  });

  describe('steering events (AB-90 child ab90-01 / AB-221, AB-67 decision record)', () => {
    const effective: SteeringEffectiveState = {
      paused: false,
      configVersion: 3,
      model: 'gpt-5',
      appliedAtStep: 2,
      appliedAtRunId: 'run-1',
      appliedAt: '2026-09-02T00:00:00.000Z',
    };
    const sessionTerminalFailure: SteeringCommandFailure = {
      failedAt: '2026-09-02T00:00:01.000Z',
      reason: 'session-terminal',
    };
    const runTerminalFailure: SteeringCommandFailure = {
      failedAt: '2026-09-02T00:00:02.000Z',
      reason: 'run-terminal',
    };

    it('constructs SteeringAcceptedEvent with the exact type name and payload', () => {
      const event = new SteeringAcceptedEvent('session-1', 'command-1', 3);

      expect(event.type).toBe('steering.accepted');
      expect(event.sessionId).toBe('session-1');
      expect(event.commandId).toBe('command-1');
      expect(event.configVersion).toBe(3);
    });

    it('constructs SteeringAppliedEvent with the exact type name and the SteeringEffectiveState payload verbatim', () => {
      const event = new SteeringAppliedEvent('session-1', effective);

      expect(event.type).toBe('steering.applied');
      expect(event.sessionId).toBe('session-1');
      expect(event.effective).toEqual(effective);
    });

    it('constructs SteeringRejectedEvent carrying a SteeringCommandFailure', () => {
      const event = new SteeringRejectedEvent('session-1', 'command-1', sessionTerminalFailure);

      expect(event.type).toBe('steering.rejected');
      expect(event.sessionId).toBe('session-1');
      expect(event.commandId).toBe('command-1');
      expect(event.failure).toEqual(sessionTerminalFailure);
    });

    it('constructs SteeringSupersededEvent carrying a SteeringCommandFailure', () => {
      const event = new SteeringSupersededEvent('session-1', 'command-1', {
        failedAt: '2026-09-02T00:00:03.000Z',
        reason: 'superseded-by',
      });

      expect(event.type).toBe('steering.superseded');
      expect(event.failure.reason).toBe('superseded-by');
    });

    it('constructs SteeringFailedEvent restricted to session-terminal/run-terminal reasons for pause/resume', () => {
      const sessionTerminal = new SteeringFailedEvent(
        'session-1',
        'command-1',
        sessionTerminalFailure,
      );
      const runTerminal = new SteeringFailedEvent('session-1', 'command-2', runTerminalFailure);

      expect(sessionTerminal.type).toBe('steering.failed');
      expect(sessionTerminal.failure.reason).toBe('session-terminal');
      expect(runTerminal.failure.reason).toBe('run-terminal');
    });

    it('exercises every steering event type as a valid OperativeEventType', () => {
      const types: OperativeEventType[] = [
        SteeringAcceptedEvent.type,
        SteeringAppliedEvent.type,
        SteeringRejectedEvent.type,
        SteeringSupersededEvent.type,
        SteeringFailedEvent.type,
      ];

      expect(types).toEqual([
        'steering.accepted',
        'steering.applied',
        'steering.rejected',
        'steering.superseded',
        'steering.failed',
      ]);
    });
  });
});
