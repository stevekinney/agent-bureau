import { createTool, createToolbox } from 'armorer';
import { createTestToolbox } from 'armorer/test';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';
import { z } from 'zod';

import { noToolCalls } from '../src/conditions/predicates';
import { createActiveRun } from '../src/create-run';
import { createMockGenerate } from '../src/test/index';
import type { GenerateResponse } from '../src/types';
const run = (options: Parameters<typeof createActiveRun>[0]) => createActiveRun(options).result;

const weatherTool = createTool({
  name: 'get_weather',
  description: 'Get weather',
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

describe('error handling', () => {
  it('terminates with error finish reason when generate throws', async () => {
    const generate = async () => {
      throw new Error('API rate limit exceeded');
    };

    const toolbox = createTestToolbox([weatherTool]);
    const conversation = new Conversation();

    const result = await run({
      generate,
      toolbox,
      conversation,
      stopWhen: noToolCalls(),
    });

    expect(result.finishReason).toBe('error');
    expect(result.error).toBeInstanceOf(Error);
    expect((result.error as Error).message).toBe('API rate limit exceeded');
    expect(result.steps).toHaveLength(0);
  });

  it('continues the loop when a tool returns an error outcome', async () => {
    const failingTool = createTool({
      name: 'failing_lookup',
      description: 'A tool that fails',
      input: z.object({ query: z.string() }),
      execute: async () => {
        throw new Error('Database connection refused');
      },
    });

    const toolbox = createTestToolbox([failingTool, weatherTool]);
    const conversation = new Conversation();

    const generate = createMockGenerate([
      toolCallResponse([{ name: 'failing_lookup', arguments: { query: 'test' } }]),
      textResponse('The lookup failed, but I can still help.'),
    ]);

    const result = await run({
      generate,
      toolbox,
      conversation,
      stopWhen: noToolCalls(),
    });

    // The loop should continue past the tool error and finish normally
    expect(result.finishReason).toBe('stop-condition');
    expect(result.steps).toHaveLength(2);
    expect(result.content).toBe('The lookup failed, but I can still help.');

    // The first step should have an error result from the tool
    const firstStepResults = result.steps[0].results;
    expect(firstStepResults).toHaveLength(1);
    expect(firstStepResults[0].outcome).toBe('error');
  });

  it('terminates with error finish reason when toolbox.execute throws', async () => {
    const generate = createMockGenerate([
      toolCallResponse([{ name: 'get_weather', arguments: { location: 'Denver' } }]),
      textResponse('Done'),
    ]);

    const toolbox = createTestToolbox([weatherTool]);
    const originalExecute = toolbox.execute.bind(toolbox);
    (toolbox as any).execute = async () => {
      throw new Error('Toolbox execute failed catastrophically');
    };

    const conversation = new Conversation();

    const result = await run({
      generate,
      toolbox,
      conversation,
      stopWhen: noToolCalls(),
    });

    expect(result.finishReason).toBe('error');
    expect(result.error).toBeInstanceOf(Error);
    expect((result.error as Error).message).toBe('Toolbox execute failed catastrophically');
    expect(result.steps).toHaveLength(0);
    void originalExecute;
  });

  it('seals the dangling tool-call with an error result when toolbox.execute throws (tool-pair integrity)', async () => {
    // The tool-call message is appended to the conversation BEFORE execution
    // runs. If execution then throws and the error is not recovered, the
    // conversation must not be left with a tool-call that has no matching
    // tool-result — a killed/errored run's history would otherwise be unsafe
    // to replay against a provider (every tool_use requires a paired
    // tool_result).
    const generate = createMockGenerate([
      toolCallResponse([{ name: 'get_weather', arguments: { location: 'Denver' } }]),
    ]);

    const toolbox = createTestToolbox([weatherTool]);
    (toolbox as any).execute = async () => {
      throw new Error('Toolbox execute failed catastrophically');
    };

    const conversation = new Conversation();

    const result = await run({
      generate,
      toolbox,
      conversation,
      stopWhen: noToolCalls(),
    });

    expect(result.finishReason).toBe('error');
    expect(conversation.getPendingToolCalls()).toHaveLength(0);

    const messages = conversation.getMessages({ includeHidden: true });
    const toolCallMessage = messages.find((m) => m.role === 'tool-call');
    const toolResultMessage = messages.find((m) => m.role === 'tool-result');
    expect(toolCallMessage).toBeDefined();
    expect(toolResultMessage).toBeDefined();
    expect(toolResultMessage?.toolResult?.callId).toBe(toolCallMessage?.toolCall?.id);
    expect(toolResultMessage?.toolResult?.outcome).toBe('error');
  });

  it('terminates with error finish reason when onStep hook throws', async () => {
    const generate = createMockGenerate([
      toolCallResponse([{ name: 'get_weather', arguments: { location: 'Denver' } }]),
      textResponse('Done'),
    ]);
    const toolbox = createTestToolbox([weatherTool]);
    const conversation = new Conversation();

    const result = await run({
      generate,
      toolbox,
      conversation,
      stopWhen: noToolCalls(),
      onStep: async () => {
        throw new Error('Hook crashed');
      },
    });

    expect(result.finishReason).toBe('error');
    expect(result.error).toBeInstanceOf(Error);
    expect((result.error as Error).message).toBe('Hook crashed');
    // The step where the hook threw is still partially recorded
    expect(result.steps).toHaveLength(0);
  });

  it('emits both run.error and run.completed for generic errors via createRun', async () => {
    const generate = async () => {
      throw new Error('Generic network error');
    };

    const toolbox = createToolbox([]);
    const conversation = new Conversation();

    const activeRun = createActiveRun({
      generate,
      toolbox,
      conversation,
      stopWhen: noToolCalls(),
    });

    const receivedEvents: string[] = [];

    activeRun.addEventListener('run.error', () => {
      receivedEvents.push('run.error');
    });

    activeRun.addEventListener('run.completed', () => {
      receivedEvents.push('run.completed');
    });

    const result = await activeRun.result;

    expect(result.finishReason).toBe('error');
    expect(receivedEvents).toContain('run.error');
    expect(receivedEvents).toContain('run.completed');
  });
});
