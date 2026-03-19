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
    expect(result.steps).toHaveLength(0);
    void originalExecute;
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
    // The step where the hook threw is still partially recorded
    expect(result.steps).toHaveLength(0);
  });
});
