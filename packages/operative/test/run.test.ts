import { createTool } from 'armorer';
import { createTestToolbox } from 'armorer/test';
import { describe, expect, it } from 'bun:test';
import { Conversation, createConversationHistory } from 'conversationalist';
import { z } from 'zod';

import { noToolCalls } from '../src/conditions/predicates';
import { run } from '../src/run';
import { createMockGenerate } from '../src/test/index';
import type { GenerateResponse } from '../src/types';

const weatherTool = createTool({
  name: 'get_weather',
  description: 'Get weather',
  input: z.object({ location: z.string() }),
  execute: async ({ location }) => ({ temperature: 72, location }),
});

function createWeatherToolbox() {
  return createTestToolbox([weatherTool]);
}

function weatherToolCall(location = 'Denver') {
  return { name: 'get_weather', arguments: { location } };
}

function textResponse(content: string, usage?: GenerateResponse['usage']): GenerateResponse {
  return { content, toolCalls: [], usage };
}

function toolCallResponse(
  toolCalls: GenerateResponse['toolCalls'],
  content = '',
  usage?: GenerateResponse['usage'],
): GenerateResponse {
  return { content, toolCalls, usage };
}

describe('run', () => {
  it('stops immediately when generate returns text with no tool calls', async () => {
    const generate = createMockGenerate([textResponse('Hello')]);
    const toolbox = createWeatherToolbox();
    const conversation = new Conversation();

    const result = await run({
      generate,
      toolbox,
      conversation,
      stopWhen: noToolCalls(),
    });

    expect(result.finishReason).toBe('stop-condition');
    expect(result.steps).toHaveLength(1);
    expect(result.content).toBe('Hello');
  });

  it('executes multiple tool calls before stopping on text response', async () => {
    const generate = createMockGenerate([
      toolCallResponse([weatherToolCall('Denver')]),
      toolCallResponse([weatherToolCall('Seattle')]),
      textResponse('The weather is nice in both cities.'),
    ]);
    const toolbox = createWeatherToolbox();
    const conversation = new Conversation();

    const result = await run({
      generate,
      toolbox,
      conversation,
      stopWhen: noToolCalls(),
    });

    expect(result.finishReason).toBe('stop-condition');
    expect(result.steps).toHaveLength(3);
    expect(result.content).toBe('The weather is nice in both cities.');
  });

  it('appends both content and tool calls when returned in the same response', async () => {
    const generate = createMockGenerate([
      toolCallResponse([weatherToolCall('Denver')], 'Checking weather...'),
      textResponse('Done.'),
    ]);
    const toolbox = createWeatherToolbox();
    const conversation = new Conversation();

    const result = await run({
      generate,
      toolbox,
      conversation,
      stopWhen: noToolCalls(),
    });

    expect(result.steps).toHaveLength(2);
    expect(result.steps[0].content).toBe('Checking weather...');
    expect(result.steps[0].toolCalls).toHaveLength(1);
    expect(result.steps[0].toolCalls[0].name).toBe('get_weather');

    const messages = result.conversation.getMessages();
    const assistantMessages = messages.filter((m) => m.role === 'assistant');
    expect(assistantMessages.length).toBeGreaterThanOrEqual(1);
  });

  it('accepts a raw ConversationHistory instead of a Conversation instance', async () => {
    const generate = createMockGenerate([textResponse('Works')]);
    const toolbox = createWeatherToolbox();
    const history = createConversationHistory();

    const result = await run({
      generate,
      toolbox,
      conversation: history,
      stopWhen: noToolCalls(),
    });

    expect(result.finishReason).toBe('stop-condition');
    expect(result.content).toBe('Works');
    expect(result.conversation).toBeInstanceOf(Conversation);
  });

  it('stops when content is empty and there are no tool calls', async () => {
    const generate = createMockGenerate([textResponse('')]);
    const toolbox = createWeatherToolbox();
    const conversation = new Conversation();

    const result = await run({
      generate,
      toolbox,
      conversation,
      stopWhen: noToolCalls(),
    });

    expect(result.finishReason).toBe('stop-condition');
    expect(result.steps).toHaveLength(1);
    expect(result.content).toBe('');
  });

  it('stops at the default maximum of 25 steps when no stop condition is met', async () => {
    const responses = Array.from({ length: 30 }, () =>
      toolCallResponse([weatherToolCall('Denver')]),
    );
    const generate = createMockGenerate(responses);
    const toolbox = createWeatherToolbox();
    const conversation = new Conversation();

    const result = await run({
      generate,
      toolbox,
      conversation,
    });

    expect(result.finishReason).toBe('maximum-steps');
    expect(result.steps).toHaveLength(25);
  });

  it('respects a custom maximumSteps limit', async () => {
    const responses = Array.from({ length: 10 }, () =>
      toolCallResponse([weatherToolCall('Denver')]),
    );
    const generate = createMockGenerate(responses);
    const toolbox = createWeatherToolbox();
    const conversation = new Conversation();

    const result = await run({
      generate,
      toolbox,
      conversation,
      maximumSteps: 3,
    });

    expect(result.finishReason).toBe('maximum-steps');
    expect(result.steps).toHaveLength(3);
  });

  it('accumulates usage across all steps', async () => {
    const usage = { prompt: 10, completion: 5, total: 15 };
    const generate = createMockGenerate([
      toolCallResponse([weatherToolCall('Denver')], '', usage),
      toolCallResponse([weatherToolCall('Seattle')], '', usage),
      textResponse('Done.', usage),
    ]);
    const toolbox = createWeatherToolbox();
    const conversation = new Conversation();

    const result = await run({
      generate,
      toolbox,
      conversation,
      stopWhen: noToolCalls(),
    });

    expect(result.usage).toEqual({
      prompt: 30,
      completion: 15,
      total: 45,
    });
  });
});
