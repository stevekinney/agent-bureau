import { createTool } from 'armorer';
import { createTestToolbox } from 'armorer/test';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';
import { z } from 'zod';

import { noToolCalls } from '../src/conditions/predicates';
import { run } from '../src/run';
import { createMockGenerate } from '../src/test/index';
import type { GenerateResponse } from '../src/types';

const tool = createTool({
  name: 'get_weather',
  description: 'Get weather',
  input: z.object({ location: z.string() }),
  execute: async ({ location }) => ({ temperature: 72, location }),
});

function weatherToolCall(location = 'Denver') {
  return { name: 'get_weather', arguments: { location } };
}

function toolCallResponse(
  toolCalls: GenerateResponse['toolCalls'],
  content = '',
): GenerateResponse {
  return { content, toolCalls, usage: undefined };
}

function textResponse(content: string): GenerateResponse {
  return { content, toolCalls: [], usage: undefined };
}

describe('step hooks', () => {
  it('prepareStep called before generate, receives correct context', async () => {
    const prepareStepCalls: Array<{ step: number; hasConversation: boolean; hasSignal: boolean }> =
      [];

    const generate = createMockGenerate([
      toolCallResponse([weatherToolCall('Denver')]),
      textResponse('Done'),
    ]);

    const result = await run({
      generate,
      toolbox: createTestToolbox([tool]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      prepareStep: async ({ conversation, step, signal }) => {
        prepareStepCalls.push({
          step,
          hasConversation: conversation instanceof Conversation,
          hasSignal: signal instanceof AbortSignal,
        });
        return undefined;
      },
    });

    expect(prepareStepCalls).toHaveLength(2);
    expect(prepareStepCalls[0]).toEqual({ step: 0, hasConversation: true, hasSignal: true });
    expect(prepareStepCalls[1]).toEqual({ step: 1, hasConversation: true, hasSignal: true });
    expect(generate.callCount).toBe(2);
  });

  it('prepareStep returns GenerateResponse to skip the LLM call', async () => {
    const generate = createMockGenerate([textResponse('Should not be called')]);

    const result = await run({
      generate,
      toolbox: createTestToolbox([tool]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      prepareStep: async () => {
        return { content: 'Intercepted', toolCalls: [], usage: undefined };
      },
    });

    expect(generate.callCount).toBe(0);
    expect(result.content).toBe('Intercepted');
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].content).toBe('Intercepted');
  });

  it('beforeToolExecution filters tool calls', async () => {
    const executedLocations: string[] = [];

    const trackingTool = createTool({
      name: 'get_weather',
      description: 'Get weather',
      input: z.object({ location: z.string() }),
      execute: async ({ location }) => {
        executedLocations.push(location);
        return { temperature: 72, location };
      },
    });

    const generate = createMockGenerate([
      toolCallResponse([weatherToolCall('Denver'), weatherToolCall('Seattle')]),
      textResponse('Done'),
    ]);

    const result = await run({
      generate,
      toolbox: createTestToolbox([trackingTool]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      beforeToolExecution: async ({ toolCalls }) => {
        return toolCalls.filter((call) => {
          const args = call.arguments as { location: string };
          return args.location === 'Denver';
        });
      },
    });

    expect(executedLocations).toEqual(['Denver']);
    expect(result.steps[0].results).toHaveLength(1);
  });

  it('beforeToolExecution returns [] to skip execution', async () => {
    const executedLocations: string[] = [];

    const trackingTool = createTool({
      name: 'get_weather',
      description: 'Get weather',
      input: z.object({ location: z.string() }),
      execute: async ({ location }) => {
        executedLocations.push(location);
        return { temperature: 72, location };
      },
    });

    const generate = createMockGenerate([
      toolCallResponse([weatherToolCall('Denver')]),
      textResponse('Done'),
    ]);

    const result = await run({
      generate,
      toolbox: createTestToolbox([trackingTool]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      beforeToolExecution: async () => [],
    });

    expect(executedLocations).toEqual([]);
    expect(result.steps[0].results).toHaveLength(0);
  });

  it('afterToolExecution receives correct results', async () => {
    const afterCalls: Array<{
      step: number;
      toolCallNames: string[];
      resultCount: number;
    }> = [];

    const generate = createMockGenerate([
      toolCallResponse([weatherToolCall('Denver')]),
      textResponse('Done'),
    ]);

    await run({
      generate,
      toolbox: createTestToolbox([tool]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      afterToolExecution: async ({ step, toolCalls, results }) => {
        afterCalls.push({
          step,
          toolCallNames: toolCalls.map((call) => call.name),
          resultCount: results.length,
        });
      },
    });

    expect(afterCalls).toHaveLength(1);
    expect(afterCalls[0].step).toBe(0);
    expect(afterCalls[0].toolCallNames).toEqual(['get_weather']);
    expect(afterCalls[0].resultCount).toBe(1);
  });

  it('onStep called after each step with correct StepResult', async () => {
    const stepResults: Array<{ step: number; content: string; toolCallCount: number }> = [];

    const generate = createMockGenerate([
      toolCallResponse([weatherToolCall('Denver')], 'Checking...'),
      textResponse('Done'),
    ]);

    await run({
      generate,
      toolbox: createTestToolbox([tool]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      onStep: async (result) => {
        stepResults.push({
          step: result.step,
          content: result.content,
          toolCallCount: result.toolCalls.length,
        });
      },
    });

    expect(stepResults).toHaveLength(2);
    expect(stepResults[0]).toEqual({ step: 0, content: 'Checking...', toolCallCount: 1 });
    expect(stepResults[1]).toEqual({ step: 1, content: 'Done', toolCallCount: 0 });
  });

  it('ordering: prepareStep -> generate -> beforeToolExecution -> execute -> afterToolExecution -> onStep', async () => {
    const log: string[] = [];

    const trackingTool = createTool({
      name: 'get_weather',
      description: 'Get weather',
      input: z.object({ location: z.string() }),
      execute: async ({ location }) => {
        log.push('execute');
        return { temperature: 72, location };
      },
    });

    const generate = createMockGenerate([
      toolCallResponse([weatherToolCall('Denver')]),
      textResponse('Done'),
    ]);

    const originalGenerate = generate;
    const wrappedGenerate: typeof generate = Object.assign(
      async (...args: Parameters<typeof generate>) => {
        log.push('generate');
        return originalGenerate(...args);
      },
      { calls: generate.calls, callCount: generate.callCount },
    ) as typeof generate;

    await run({
      generate: wrappedGenerate,
      toolbox: createTestToolbox([trackingTool]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      prepareStep: async () => {
        log.push('prepareStep');
        return undefined;
      },
      beforeToolExecution: async ({ toolCalls }) => {
        log.push('beforeToolExecution');
        return toolCalls;
      },
      afterToolExecution: async () => {
        log.push('afterToolExecution');
      },
      onStep: async () => {
        log.push('onStep');
      },
    });

    expect(log).toEqual([
      'prepareStep',
      'generate',
      'beforeToolExecution',
      'execute',
      'afterToolExecution',
      'onStep',
      'prepareStep',
      'generate',
      'onStep',
    ]);
  });

  it('async hooks are awaited', async () => {
    const log: string[] = [];

    const delay = (milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

    const trackingTool = createTool({
      name: 'get_weather',
      description: 'Get weather',
      input: z.object({ location: z.string() }),
      execute: async ({ location }) => {
        log.push('execute');
        return { temperature: 72, location };
      },
    });

    const generate = createMockGenerate([
      toolCallResponse([weatherToolCall('Denver')]),
      textResponse('Done'),
    ]);

    await run({
      generate,
      toolbox: createTestToolbox([trackingTool]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      prepareStep: async () => {
        await delay(10);
        log.push('prepareStep');
        return undefined;
      },
      beforeToolExecution: async ({ toolCalls }) => {
        await delay(10);
        log.push('beforeToolExecution');
        return toolCalls;
      },
      afterToolExecution: async () => {
        await delay(10);
        log.push('afterToolExecution');
      },
      onStep: async () => {
        await delay(10);
        log.push('onStep');
      },
    });

    expect(log).toEqual([
      'prepareStep',
      'beforeToolExecution',
      'execute',
      'afterToolExecution',
      'onStep',
      'prepareStep',
      'onStep',
    ]);
  });

  describe('hook errors terminate the loop', () => {
    it('prepareStep error terminates with error', async () => {
      const generate = createMockGenerate([textResponse('Hello')]);

      const result = await run({
        generate,
        toolbox: createTestToolbox([tool]),
        conversation: new Conversation(),
        stopWhen: noToolCalls(),
        prepareStep: async () => {
          throw new Error('prepareStep failed');
        },
      });

      expect(result.finishReason).toBe('error');
      expect(result.steps).toHaveLength(0);
    });

    it('beforeToolExecution error terminates with error', async () => {
      const generate = createMockGenerate([
        toolCallResponse([weatherToolCall('Denver')]),
        textResponse('Done'),
      ]);

      const result = await run({
        generate,
        toolbox: createTestToolbox([tool]),
        conversation: new Conversation(),
        stopWhen: noToolCalls(),
        beforeToolExecution: async () => {
          throw new Error('beforeToolExecution failed');
        },
      });

      expect(result.finishReason).toBe('error');
      expect(result.steps).toHaveLength(0);
    });

    it('afterToolExecution error terminates with error', async () => {
      const generate = createMockGenerate([
        toolCallResponse([weatherToolCall('Denver')]),
        textResponse('Done'),
      ]);

      const result = await run({
        generate,
        toolbox: createTestToolbox([tool]),
        conversation: new Conversation(),
        stopWhen: noToolCalls(),
        afterToolExecution: async () => {
          throw new Error('afterToolExecution failed');
        },
      });

      expect(result.finishReason).toBe('error');
      expect(result.steps).toHaveLength(0);
    });

    it('onStep error terminates with error', async () => {
      const generate = createMockGenerate([
        toolCallResponse([weatherToolCall('Denver')]),
        textResponse('Done'),
      ]);

      const result = await run({
        generate,
        toolbox: createTestToolbox([tool]),
        conversation: new Conversation(),
        stopWhen: noToolCalls(),
        onStep: async () => {
          throw new Error('onStep failed');
        },
      });

      expect(result.finishReason).toBe('error');
      expect(result.steps).toHaveLength(0);
    });
  });
});
