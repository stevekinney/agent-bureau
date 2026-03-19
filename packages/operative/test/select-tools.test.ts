import { createTool } from 'armorer';
import { createTestToolbox } from 'armorer/test';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';
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

const searchTool = createTool({
  name: 'search',
  description: 'Search',
  input: z.object({ query: z.string() }),
  execute: async ({ query }) => ({ results: [query] }),
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

describe('tool selection per step', () => {
  it('filters tools available per step', async () => {
    const executedTools: string[] = [];

    const trackingWeather = createTool({
      name: 'get_weather',
      description: 'Get weather',
      input: z.object({ location: z.string() }),
      execute: async ({ location }) => {
        executedTools.push('get_weather');
        return { temperature: 72, location };
      },
    });

    const trackingSearch = createTool({
      name: 'search',
      description: 'Search',
      input: z.object({ query: z.string() }),
      execute: async ({ query }) => {
        executedTools.push('search');
        return { results: [query] };
      },
    });

    const fullToolbox = createTestToolbox([trackingWeather, trackingSearch]);
    const weatherOnlyToolbox = createTestToolbox([trackingWeather]);

    const generate = createMockGenerate([
      toolCallResponse([{ name: 'get_weather', arguments: { location: 'Denver' } }]),
      toolCallResponse([{ name: 'search', arguments: { query: 'test' } }]),
      textResponse('Done'),
    ]);

    const result = await run({
      generate,
      toolbox: fullToolbox,
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      selectTools: async ({ step }) => {
        // Step 0: only weather, Step 1+: full toolbox
        return step === 0 ? weatherOnlyToolbox : fullToolbox;
      },
    });

    expect(result.finishReason).toBe('stop-condition');
    expect(executedTools).toContain('get_weather');
    expect(executedTools).toContain('search');
  });

  it('returns error result when selected toolbox lacks the called tool', async () => {
    const emptyToolbox = createTestToolbox([]);
    const fullToolbox = createTestToolbox([weatherTool]);

    const generate = createMockGenerate([
      toolCallResponse([{ name: 'get_weather', arguments: { location: 'Denver' } }]),
      textResponse('No tool available'),
    ]);

    const result = await run({
      generate,
      toolbox: fullToolbox,
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      selectTools: async () => emptyToolbox,
    });

    expect(result.finishReason).toBe('stop-condition');
    expect(result.steps[0].results[0].outcome).toBe('error');
  });

  it('receives the correct step number in context', async () => {
    const receivedSteps: number[] = [];

    const generate = createMockGenerate([
      toolCallResponse([{ name: 'get_weather', arguments: { location: 'Denver' } }]),
      toolCallResponse([{ name: 'get_weather', arguments: { location: 'Seattle' } }]),
      textResponse('Done'),
    ]);

    const toolbox = createTestToolbox([weatherTool]);

    await run({
      generate,
      toolbox,
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      selectTools: async ({ step }) => {
        receivedSteps.push(step);
        return toolbox;
      },
    });

    expect(receivedSteps).toEqual([0, 1, 2]);
  });

  it('passes selected toolbox in generate context', async () => {
    const specialToolbox = createTestToolbox([searchTool]);
    const defaultToolbox = createTestToolbox([weatherTool]);
    let receivedToolbox: unknown;

    const generate = async (context: { toolbox: unknown }) => {
      receivedToolbox = context.toolbox;
      return textResponse('Done');
    };

    await run({
      generate,
      toolbox: defaultToolbox,
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      selectTools: async () => specialToolbox,
    });

    expect(receivedToolbox).toBe(specialToolbox);
  });
});
