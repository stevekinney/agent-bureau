import { createTool } from 'armorer';
import { createTestToolbox } from 'armorer/test';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';
import { z } from 'zod';

import { noToolCalls } from '../src/conditions/predicates';
import { createActiveRun } from '../src/create-run';
import { ToolSettledBubbleEvent } from '../src/events';
import { executeLoop } from '../src/loop';
import { createMockGenerate } from '../src/test/index';
import type { GenerateResponse } from '../src/types';
const run = (options: Parameters<typeof createActiveRun>[0]) => createActiveRun(options).result;

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
    expect(result.steps[0].results).toHaveLength(2);
  });

  it('seals all-filtered, mixed, and hook-failed tool calls with exact event payload parity', async () => {
    for (const mode of ['all-filtered', 'mixed', 'hook-failure'] as const) {
      let executions = 0;
      const trackingTool = createTool({
        name: 'lookup',
        description: 'Lookup fixture',
        input: z.object({}),
        execute: async () => {
          executions += 1;
          return 'found';
        },
      });
      const conversation = new Conversation();
      const activeRun = createActiveRun({
        generate: async () => ({
          content: '',
          toolCalls: [
            { id: 'call-a', name: 'lookup', arguments: {} },
            { id: 'call-b', name: 'lookup', arguments: {} },
          ],
        }),
        toolbox: createTestToolbox([trackingTool]),
        conversation,
        maximumSteps: 1,
        beforeToolExecution: async ({ toolCalls }) => {
          if (mode === 'hook-failure') throw new Error('hook failure');
          return mode === 'mixed' ? toolCalls.slice(0, 1) : [];
        },
      });
      const settled: ToolSettledBubbleEvent[] = [];
      activeRun.addEventListener('tool.settled', (event) => {
        settled.push(event);
      });

      const result = await activeRun.result;
      const toolResults = conversation
        .getMessages({ includeHidden: true })
        .filter((message) => message.role === 'tool-result');
      expect(toolResults).toHaveLength(2);
      expect(settled).toHaveLength(2);
      expect(settled.map((event) => event.toolCallId).toSorted()).toEqual(['call-a', 'call-b']);
      for (const message of toolResults) {
        const toolResult = message.toolResult;
        expect(toolResult).toBeDefined();
        const event = settled.find((candidate) => candidate.toolCallId === toolResult?.callId);
        expect(event).toBeDefined();
        expect(event?.status).toBe(toolResult?.outcome === 'success' ? 'success' : 'error');
        expect(event?.result).toEqual(toolResult?.content);
      }
      expect(result.steps[0]?.results ?? []).toHaveLength(mode === 'mixed' ? 2 : 0);
      expect(executions).toBe(mode === 'mixed' ? 1 : 0);
    }
  });

  it('seals tool calls a beforeToolExecution hook filters out (tool-pair integrity)', async () => {
    // The Seattle call was appended to the conversation via appendToolCalls
    // before the hook ran, then filtered out of execution entirely by the
    // hook's return value (not an error/abort). It must still get a
    // tool-result so the conversation never has a dangling tool-call.
    const conversation = new Conversation();

    const generate = createMockGenerate([
      toolCallResponse([weatherToolCall('Denver'), weatherToolCall('Seattle')]),
      textResponse('Done'),
    ]);

    await run({
      generate,
      toolbox: createTestToolbox([tool]),
      conversation,
      stopWhen: noToolCalls(),
      beforeToolExecution: async ({ toolCalls }) => {
        return toolCalls.filter((call) => {
          const args = call.arguments as { location: string };
          return args.location === 'Denver';
        });
      },
    });

    expect(conversation.getPendingToolCalls()).toHaveLength(0);

    const messages = conversation.getMessages({ includeHidden: true });
    const toolCalls = messages.filter((m) => m.role === 'tool-call');
    const toolResults = messages.filter((m) => m.role === 'tool-result');
    expect(toolCalls).toHaveLength(2);
    expect(toolResults).toHaveLength(2);

    const seattleCallId = toolCalls.find(
      (m) => (m.toolCall?.arguments as { location: string }).location === 'Seattle',
    )?.toolCall?.id;
    const seattleResult = toolResults.find((m) => m.toolResult?.callId === seattleCallId);
    expect(seattleResult?.toolResult?.outcome).toBe('error');
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

  it('seals the tool call when beforeToolExecution returns [] to skip all execution (tool-pair integrity)', async () => {
    const conversation = new Conversation();

    const generate = createMockGenerate([
      toolCallResponse([weatherToolCall('Denver')]),
      textResponse('Done'),
    ]);

    await run({
      generate,
      toolbox: createTestToolbox([tool]),
      conversation,
      stopWhen: noToolCalls(),
      beforeToolExecution: async () => [],
    });

    expect(conversation.getPendingToolCalls()).toHaveLength(0);
    const messages = conversation.getMessages({ includeHidden: true });
    expect(messages.filter((m) => m.role === 'tool-call')).toHaveLength(1);
    expect(messages.filter((m) => m.role === 'tool-result')).toHaveLength(1);
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

  it('afterToolExecution pairs only executed calls with their executed results', async () => {
    const pairs: Array<{ callId: string; resultId: string }> = [];
    const generate = createMockGenerate([
      toolCallResponse([
        { id: 'denver-call', ...weatherToolCall('Denver') },
        { id: 'seattle-call', ...weatherToolCall('Seattle') },
      ]),
      textResponse('Done'),
    ]);

    await run({
      generate,
      toolbox: createTestToolbox([tool]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      beforeToolExecution: async ({ toolCalls }) => toolCalls.slice(0, 1),
      afterToolExecution: async ({ toolCalls, results }) => {
        pairs.push({
          callId: `${toolCalls.length}:${toolCalls[0]?.id ?? ''}`,
          resultId: `${results.length}:${results[0]?.toolCallId ?? ''}`,
        });
      },
    });

    expect(pairs).toHaveLength(1);
    expect(pairs[0].callId).toBe('1:denver-call');
    expect(pairs[0].resultId).toBe(pairs[0].callId);
  });

  it('low-level executeLoop still emits synthesized settlements with an explicit runId', async () => {
    const events: Event[] = [];
    const trackingTool = createTool({
      name: 'low-level-tool',
      description: 'Low-level fixture',
      input: z.object({}),
      execute: async () => {
        throw new Error('low-level failure');
      },
    });

    await executeLoop(
      {
        generate: createMockGenerate([
          toolCallResponse([{ id: 'low-level-call', name: 'low-level-tool', arguments: {} }]),
        ]),
        toolbox: createTestToolbox([trackingTool]),
        conversation: new Conversation(),
        stopWhen: noToolCalls(),
        runId: 'low-level-run',
        executeOptions: { errorMode: 'failFast' },
      },
      { dispatch: (event) => (events.push(event), true) },
    );

    expect(events.filter((event) => event instanceof ToolSettledBubbleEvent)).toHaveLength(1);
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
    );

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

    const delay = async (_milliseconds: number) => {
      await Promise.resolve();
    };

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
        collectAsync: true,
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
