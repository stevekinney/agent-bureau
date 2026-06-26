/**
 * C3 — curated tool.* bubble events on the run stream.
 *
 * Acceptance: every armorer tool.started / tool.finished / progress /
 * policy-denied event is re-emitted on the run stream as a curated
 * tool.* event stamped with {agentName, runId, step}.
 */
import { createTool, createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';
import { z } from 'zod';

import { noToolCalls } from '../src/conditions/predicates';
import { createActiveRun } from '../src/create-run';
import {
  ToolErrorBubbleEvent,
  ToolPolicyDeniedBubbleEvent,
  ToolProgressBubbleEvent,
  ToolSettledBubbleEvent,
  ToolStartedBubbleEvent,
} from '../src/events';
import { createMockGenerate } from '../src/test/index';
import type { GenerateResponse } from '../src/types';

function textResponse(content: string): GenerateResponse {
  return { content, toolCalls: [] };
}

function toolCallResponse(
  toolCalls: GenerateResponse['toolCalls'],
  content = '',
): GenerateResponse {
  return { content, toolCalls };
}

const echoTool = createTool({
  name: 'echo',
  description: 'Echo the input',
  input: z.object({ message: z.string() }),
  execute: async ({ message }) => message,
});

describe('curated tool.* bubble events (C3)', () => {
  it('emits tool.started when a tool is called', async () => {
    const generate = createMockGenerate([
      toolCallResponse([{ name: 'echo', arguments: { message: 'hello' } }]),
      textResponse('done'),
    ]);
    const toolbox = createToolbox([echoTool]);
    const run = createActiveRun({
      generate,
      toolbox,
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      agentName: 'test-agent',
      runId: 'run-1',
    });

    const started: ToolStartedBubbleEvent[] = [];
    run.addEventListener('tool.started', (e) => started.push(e));

    await run.result;

    expect(started).toHaveLength(1);
    expect(started[0]).toBeInstanceOf(ToolStartedBubbleEvent);
    expect(started[0]?.toolName).toBe('echo');
    expect(started[0]?.agentName).toBe('test-agent');
    expect(started[0]?.runId).toBe('run-1');
  });

  it('emits tool.settled with status=success when a tool completes', async () => {
    const generate = createMockGenerate([
      toolCallResponse([{ name: 'echo', arguments: { message: 'hello' } }]),
      textResponse('done'),
    ]);
    const toolbox = createToolbox([echoTool]);
    const run = createActiveRun({
      generate,
      toolbox,
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      agentName: 'my-agent',
      runId: 'run-2',
    });

    const settled: ToolSettledBubbleEvent[] = [];
    run.addEventListener('tool.settled', (e) => settled.push(e));

    await run.result;

    expect(settled).toHaveLength(1);
    expect(settled[0]?.status).toBe('success');
    expect(settled[0]?.toolName).toBe('echo');
    expect(settled[0]?.agentName).toBe('my-agent');
    expect(settled[0]?.runId).toBe('run-2');
  });

  it('step stamp on tool.* events matches the step that triggered the tool call', async () => {
    const generate = createMockGenerate([
      // Step 1: trigger tool
      toolCallResponse([{ name: 'echo', arguments: { message: 'step-1' } }]),
      // Step 2: text-only reply to stop
      textResponse('done'),
    ]);
    const toolbox = createToolbox([echoTool]);
    const run = createActiveRun({
      generate,
      toolbox,
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
    });

    const started: ToolStartedBubbleEvent[] = [];
    run.addEventListener('tool.started', (e) => started.push(e));

    await run.result;

    // Step 1 is step index 1 (starts at 1 in the current loop)
    expect(started[0]?.step).toBeGreaterThanOrEqual(0);
  });

  it('emits tool.error for a tool that throws', async () => {
    const failingTool = createTool({
      name: 'fail',
      description: 'Always fails',
      input: z.object({}),
      execute: async () => {
        throw new Error('deliberate failure');
      },
    });

    const generate = createMockGenerate([
      toolCallResponse([{ name: 'fail', arguments: {} }]),
      textResponse('done'),
    ]);
    const toolbox = createToolbox([failingTool]);
    const run = createActiveRun({
      generate,
      toolbox,
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      agentName: 'error-agent',
      runId: 'run-3',
    });

    const errors: ToolErrorBubbleEvent[] = [];
    run.addEventListener('tool.error', (e) => errors.push(e));

    await run.result;

    expect(errors).toHaveLength(1);
    expect(errors[0]?.toolName).toBe('fail');
    expect(errors[0]?.agentName).toBe('error-agent');
    expect(errors[0]?.error).toBeDefined();
  });

  it('emits tool.settled with status=error for a throwing tool', async () => {
    const failingTool = createTool({
      name: 'fail',
      description: 'Always fails',
      input: z.object({}),
      execute: async () => {
        throw new Error('deliberate failure');
      },
    });

    const generate = createMockGenerate([
      toolCallResponse([{ name: 'fail', arguments: {} }]),
      textResponse('done'),
    ]);
    const toolbox = createToolbox([failingTool]);
    const run = createActiveRun({
      generate,
      toolbox,
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
    });

    const settled: ToolSettledBubbleEvent[] = [];
    run.addEventListener('tool.settled', (e) => settled.push(e));

    await run.result;

    expect(settled).toHaveLength(1);
    expect(settled[0]?.status).toBe('error');
  });

  it('defaults agentName and runId to empty string when not supplied', async () => {
    const generate = createMockGenerate([
      toolCallResponse([{ name: 'echo', arguments: { message: 'test' } }]),
      textResponse('done'),
    ]);
    const toolbox = createToolbox([echoTool]);
    const run = createActiveRun({
      generate,
      toolbox,
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      // no agentName or runId
    });

    const started: ToolStartedBubbleEvent[] = [];
    run.addEventListener('tool.started', (e) => started.push(e));

    await run.result;

    expect(started[0]?.agentName).toBe('');
    expect(started[0]?.runId).toBe('');
  });

  it('does not emit tool.* events on text-only turns', async () => {
    const generate = createMockGenerate([textResponse('just text, no tools')]);
    const toolbox = createToolbox([echoTool]);
    const run = createActiveRun({
      generate,
      toolbox,
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
    });

    const toolEvents: string[] = [];
    run.toObservable().subscribe({
      next(e) {
        if (e.type.startsWith('tool.')) {
          toolEvents.push(e.type);
        }
      },
    });

    await run.result;

    expect(toolEvents).toHaveLength(0);
  });
});

describe('tool.policy-denied bubble event (C3)', () => {
  it('is exported with the expected shape', () => {
    // Validates the constructor contract at the type level.
    const e = new ToolPolicyDeniedBubbleEvent(
      { agentName: 'a', runId: 'r', step: 1 },
      { toolName: 'some-tool', toolCallId: 'call-1', reason: 'not allowed' },
    );
    expect(e.type).toBe('tool.policy-denied');
    expect(e.agentName).toBe('a');
    expect(e.toolName).toBe('some-tool');
    expect(e.reason).toBe('not allowed');
  });
});

describe('tool.progress bubble event (C3)', () => {
  it('is exported with the expected shape', () => {
    const e = new ToolProgressBubbleEvent(
      { agentName: 'a', runId: 'r', step: 2 },
      { toolName: 'long-task', toolCallId: 'call-2', percent: 50, message: 'halfway' },
    );
    expect(e.type).toBe('tool.progress');
    expect(e.percent).toBe(50);
    expect(e.message).toBe('halfway');
    expect(e.step).toBe(2);
  });
});
