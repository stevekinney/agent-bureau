import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { createTool, createToolCall } from '../src/create-tool';
import {
  ToolboxCancelledEvent,
  ToolboxLogEvent,
  ToolboxLoopBlockedEvent,
  ToolboxLoopWarningEvent,
  ToolboxProgressEvent,
  ToolboxStatusUpdateEvent,
  ToolboxStreamErrorEvent,
  ToolboxToolFinishedEvent,
  ToolboxToolStartedEvent,
  ToolCancelledEvent,
  ToolProgressEvent,
  ToolStatusUpdateEvent,
} from '../src/events';

function createFixtures() {
  const tool = createTool({
    name: 'event-tool',
    description: 'Event coverage tool.',
    input: z.object({ value: z.string() }),
    execute: async ({ value }: { value: string }) => value,
  });
  const toolCall = createToolCall('event-tool', { value: 'ok' });
  const typedToolCall = { ...toolCall, arguments: { value: 'ok' } };

  return {
    call: toolCall,
    configuration: tool.configuration,
    tool,
    toolCall: typedToolCall,
  };
}

describe('event classes', () => {
  it('constructs tool-level event classes that are only used via emit helpers', () => {
    const statusUpdate = new ToolStatusUpdateEvent({ status: 'working' });
    expect(statusUpdate.type).toBe(ToolStatusUpdateEvent.type);
    expect(statusUpdate.status).toBe('working');

    const progress = new ToolProgressEvent({ percent: 50, message: 'Halfway there' });
    expect(progress.type).toBe(ToolProgressEvent.type);
    expect(progress.percent).toBe(50);
    expect(progress.message).toBe('Halfway there');

    const cancelled = new ToolCancelledEvent({ reason: 'user cancelled' });
    expect(cancelled.type).toBe(ToolCancelledEvent.type);
    expect(cancelled.reason).toBe('user cancelled');
  });

  it('constructs toolbox-level event classes that are otherwise only exercised indirectly', () => {
    const { call, configuration, tool, toolCall } = createFixtures();

    const statusUpdate = new ToolboxStatusUpdateEvent({
      callId: call.id,
      name: call.name,
      status: 'running',
      percent: 25,
      eta: 42,
      message: 'Quarter complete',
    });
    expect(statusUpdate.type).toBe(ToolboxStatusUpdateEvent.type);
    expect(statusUpdate.callId).toBe(call.id);
    expect(statusUpdate.name).toBe(call.name);
    expect(statusUpdate.percent).toBe(25);
    expect(statusUpdate.eta).toBe(42);
    expect(statusUpdate.message).toBe('Quarter complete');

    const started = new ToolboxToolStartedEvent({
      tool,
      call,
      toolCall,
      configuration,
      params: toolCall.arguments,
      startedAt: 100,
      inputDigest: 'input-digest',
    });
    expect(started.type).toBe(ToolboxToolStartedEvent.type);
    expect(started.tool).toBe(tool);
    expect(started.call).toBe(call);
    expect(started.toolCall).toEqual(toolCall);
    expect(started.configuration).toBe(configuration);
    expect(started.params).toEqual(toolCall.arguments);
    expect(started.startedAt).toBe(100);
    expect(started.inputDigest).toBe('input-digest');

    const finished = new ToolboxToolFinishedEvent({
      tool,
      call,
      toolCall,
      configuration,
      status: 'success',
      durationMs: 25,
      startedAt: 100,
      finishedAt: 125,
      result: { value: 'ok' },
      error: undefined,
      reason: 'complete',
      errorCategory: 'internal',
      inputDigest: 'input-digest',
      outputDigest: 'output-digest',
    });
    expect(finished.type).toBe(ToolboxToolFinishedEvent.type);
    expect(finished.status).toBe('success');
    expect(finished.durationMs).toBe(25);
    expect(finished.finishedAt).toBe(125);
    expect(finished.result).toEqual({ value: 'ok' });
    expect(finished.reason).toBe('complete');
    expect(finished.errorCategory).toBe('internal');
    expect(finished.outputDigest).toBe('output-digest');

    const progress = new ToolboxProgressEvent({
      tool,
      call,
      percent: 60,
      message: 'Almost done',
    });
    expect(progress.type).toBe(ToolboxProgressEvent.type);
    expect(progress.tool).toBe(tool);
    expect(progress.call).toBe(call);
    expect(progress.percent).toBe(60);
    expect(progress.message).toBe('Almost done');

    const streamError = new ToolboxStreamErrorEvent({
      tool,
      call,
      error: new Error('stream failed'),
      index: 2,
    });
    expect(streamError.type).toBe(ToolboxStreamErrorEvent.type);
    expect(streamError.tool).toBe(tool);
    expect(streamError.call).toBe(call);
    expect(streamError.error).toBeInstanceOf(Error);
    expect(streamError.index).toBe(2);

    const logEvent = new ToolboxLogEvent({
      tool,
      call,
      level: 'warn',
      message: 'Heads up',
      data: { retry: true },
    });
    expect(logEvent.type).toBe(ToolboxLogEvent.type);
    expect(logEvent.tool).toBe(tool);
    expect(logEvent.call).toBe(call);
    expect(logEvent.level).toBe('warn');
    expect(logEvent.message).toBe('Heads up');
    expect(logEvent.data).toEqual({ retry: true });

    const cancelled = new ToolboxCancelledEvent({
      tool,
      call,
      reason: 'timeout',
    });
    expect(cancelled.type).toBe(ToolboxCancelledEvent.type);
    expect(cancelled.tool).toBe(tool);
    expect(cancelled.call).toBe(call);
    expect(cancelled.reason).toBe('timeout');

    const warning = new ToolboxLoopWarningEvent({
      tool,
      call,
      detector: 'simple-repeat',
      count: 3,
      message: 'Potential loop detected',
    });
    expect(warning.type).toBe(ToolboxLoopWarningEvent.type);
    expect(warning.detector).toBe('simple-repeat');
    expect(warning.count).toBe(3);
    expect(warning.message).toBe('Potential loop detected');

    const blocked = new ToolboxLoopBlockedEvent({
      tool,
      call,
      detector: 'simple-repeat',
      count: 5,
      message: 'Loop blocked',
    });
    expect(blocked.type).toBe(ToolboxLoopBlockedEvent.type);
    expect(blocked.detector).toBe('simple-repeat');
    expect(blocked.count).toBe(5);
    expect(blocked.message).toBe('Loop blocked');
  });
});
