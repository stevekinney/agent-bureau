import { createTool } from 'armorer';
import { createTestToolbox } from 'armorer/test';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';
import { HookRegistry } from 'lifecycle';
import { z } from 'zod';

import { noToolCalls } from '../src/conditions/predicates';
import { createActiveRun } from '../src/create-run';
import type {
  OperativeHookMap,
  SessionCancelHookContext,
  SessionForkHookContext,
  SessionQueryHookContext,
  SessionRecoverHookContext,
  SessionSignalHookContext,
  SessionSleepHookContext,
  SessionUpdateHookContext,
  ToolErrorHookContext,
  ToolPolicyDeniedHookContext,
  ToolProgressHookContext,
  ToolSettledHookContext,
  ToolStartedHookContext,
} from '../src/hooks';
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

describe('HookRegistry integration', () => {
  it('prepareStep hook runs before each step', async () => {
    const prepareStepCalls: number[] = [];
    const hooks = new HookRegistry<OperativeHookMap>();

    hooks.on('prepareStep', async ({ step }) => {
      prepareStepCalls.push(step);
    });

    const generate = createMockGenerate([
      toolCallResponse([weatherToolCall('Denver')]),
      textResponse('Done'),
    ]);

    await run({
      generate,
      toolbox: createTestToolbox([tool]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      hooks,
    });

    expect(prepareStepCalls).toEqual([0, 1]);
    expect(generate.callCount).toBe(2);
  });

  it('prepareStep hook can return a GenerateResponse to skip generate', async () => {
    const hooks = new HookRegistry<OperativeHookMap>();

    hooks.on('prepareStep', async () => {
      return { content: 'Intercepted by registry', toolCalls: [] } as GenerateResponse;
    });

    const generate = createMockGenerate([textResponse('Should not be called')]);

    const result = await run({
      generate,
      toolbox: createTestToolbox([tool]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      hooks,
    });

    expect(generate.callCount).toBe(0);
    expect(result.content).toBe('Intercepted by registry');
  });

  it('beforeToolExecution hook can filter tool calls', async () => {
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

    const hooks = new HookRegistry<OperativeHookMap>();

    hooks.on('beforeToolExecution', async ({ toolCalls }) => {
      return toolCalls.filter((call) => {
        const args = call.arguments as { location: string };
        return args.location === 'Denver';
      });
    });

    const generate = createMockGenerate([
      toolCallResponse([weatherToolCall('Denver'), weatherToolCall('Seattle')]),
      textResponse('Done'),
    ]);

    await run({
      generate,
      toolbox: createTestToolbox([trackingTool]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      hooks,
    });

    expect(executedLocations).toEqual(['Denver']);
  });

  it('afterToolExecution hook receives results', async () => {
    const afterCalls: Array<{
      step: number;
      toolCallNames: string[];
      resultCount: number;
    }> = [];

    const hooks = new HookRegistry<OperativeHookMap>();

    hooks.on('afterToolExecution', async ({ step, toolCalls, results }) => {
      afterCalls.push({
        step,
        toolCallNames: toolCalls.map((call) => call.name),
        resultCount: results.length,
      });
    });

    const generate = createMockGenerate([
      toolCallResponse([weatherToolCall('Denver')]),
      textResponse('Done'),
    ]);

    await run({
      generate,
      toolbox: createTestToolbox([tool]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      hooks,
    });

    expect(afterCalls).toHaveLength(1);
    expect(afterCalls[0].step).toBe(0);
    expect(afterCalls[0].toolCallNames).toEqual(['get_weather']);
    expect(afterCalls[0].resultCount).toBe(1);
  });

  it('onStep hook is called after each step', async () => {
    const stepNumbers: number[] = [];
    const hooks = new HookRegistry<OperativeHookMap>();

    hooks.on('onStep', async (result) => {
      stepNumbers.push(result.step);
    });

    const generate = createMockGenerate([
      toolCallResponse([weatherToolCall('Denver')], 'Checking...'),
      textResponse('Done'),
    ]);

    await run({
      generate,
      toolbox: createTestToolbox([tool]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      hooks,
    });

    expect(stepNumbers).toEqual([0, 1]);
  });

  it('validateResponse hook can transform the response', async () => {
    const hooks = new HookRegistry<OperativeHookMap>();

    hooks.on('validateResponse', async (response) => {
      return { ...response, content: response.content + ' [validated]' };
    });

    const generate = createMockGenerate([textResponse('Original')]);

    const result = await run({
      generate,
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      hooks,
    });

    expect(result.content).toBe('Original [validated]');
  });

  it('validateResponse registry hook errors terminate the run', async () => {
    const hooks = new HookRegistry<OperativeHookMap>();

    hooks.on('validateResponse', async () => {
      throw new Error('registry validateResponse failed');
    });

    const result = await run({
      generate: createMockGenerate([textResponse('Original')]),
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      hooks,
    });

    expect(result.finishReason).toBe('error');
  });

  it('selectTools hook can replace the toolbox', async () => {
    const hooks = new HookRegistry<OperativeHookMap>();
    const emptyToolbox = createTestToolbox([]);

    hooks.on('selectTools', async () => {
      return emptyToolbox;
    });

    const generate = createMockGenerate([textResponse('Done')]);

    const result = await run({
      generate,
      toolbox: createTestToolbox([tool]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      hooks,
    });

    expect(result.finishReason).toBe('stop-condition');
  });

  it('beforeToolExecution registry hook errors terminate the run', async () => {
    const hooks = new HookRegistry<OperativeHookMap>();

    hooks.on('beforeToolExecution', async () => {
      throw new Error('registry beforeToolExecution failed');
    });

    const result = await run({
      generate: createMockGenerate([toolCallResponse([weatherToolCall('Denver')])]),
      toolbox: createTestToolbox([tool]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      hooks,
    });

    expect(result.finishReason).toBe('error');
  });

  it('afterToolExecution registry hook errors terminate the run', async () => {
    const hooks = new HookRegistry<OperativeHookMap>();

    hooks.on('afterToolExecution', async () => {
      throw new Error('registry afterToolExecution failed');
    });

    const result = await run({
      generate: createMockGenerate([
        toolCallResponse([weatherToolCall('Denver')]),
        textResponse('Done'),
      ]),
      toolbox: createTestToolbox([tool]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      hooks,
    });

    expect(result.finishReason).toBe('error');
  });

  describe('backward compatibility with old-style hook arrays', () => {
    it('hooks from HookRegistry run alongside old-style hook arrays', async () => {
      const log: string[] = [];

      const hooks = new HookRegistry<OperativeHookMap>();

      hooks.on('onStep', async () => {
        log.push('registry-onStep');
      });

      const generate = createMockGenerate([
        toolCallResponse([weatherToolCall('Denver')]),
        textResponse('Done'),
      ]);

      await run({
        generate,
        toolbox: createTestToolbox([tool]),
        conversation: new Conversation(),
        stopWhen: noToolCalls(),
        hooks,
        onStep: async () => {
          log.push('array-onStep');
        },
      });

      // Old-style runs first, then registry
      expect(log).toEqual(['array-onStep', 'registry-onStep', 'array-onStep', 'registry-onStep']);
    });

    it('both prepareStep sources run; old-style first', async () => {
      const log: string[] = [];

      const hooks = new HookRegistry<OperativeHookMap>();
      hooks.on('prepareStep', async () => {
        log.push('registry-prepareStep');
      });

      const generate = createMockGenerate([textResponse('Done')]);

      await run({
        generate,
        toolbox: createTestToolbox([]),
        conversation: new Conversation(),
        stopWhen: noToolCalls(),
        hooks,
        prepareStep: async () => {
          log.push('array-prepareStep');
          return undefined;
        },
      });

      expect(log).toEqual(['array-prepareStep', 'registry-prepareStep']);
    });

    it('old-style prepareStep returning GenerateResponse skips registry prepareStep', async () => {
      const log: string[] = [];

      const hooks = new HookRegistry<OperativeHookMap>();
      hooks.on('prepareStep', async () => {
        log.push('registry-prepareStep');
      });

      const generate = createMockGenerate([textResponse('Should not be called')]);

      const result = await run({
        generate,
        toolbox: createTestToolbox([]),
        conversation: new Conversation(),
        stopWhen: noToolCalls(),
        hooks,
        prepareStep: async () => {
          log.push('array-prepareStep');
          return { content: 'Intercepted by array', toolCalls: [] };
        },
      });

      expect(log).toEqual(['array-prepareStep']);
      expect(result.content).toBe('Intercepted by array');
      expect(generate.callCount).toBe(0);
    });

    it('both beforeToolExecution sources chain: old-style then registry', async () => {
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

      const hooks = new HookRegistry<OperativeHookMap>();

      // Registry removes Seattle
      hooks.on('beforeToolExecution', async ({ toolCalls }) => {
        return toolCalls.filter(
          (tc) => (tc.arguments as { location: string }).location !== 'Seattle',
        );
      });

      const generate = createMockGenerate([
        toolCallResponse([
          weatherToolCall('Denver'),
          weatherToolCall('Seattle'),
          weatherToolCall('Portland'),
        ]),
        textResponse('Done'),
      ]);

      await run({
        generate,
        toolbox: createTestToolbox([trackingTool]),
        conversation: new Conversation(),
        stopWhen: noToolCalls(),
        hooks,
        // Old-style removes Portland
        beforeToolExecution: async ({ toolCalls }) =>
          toolCalls.filter((tc) => (tc.arguments as { location: string }).location !== 'Portland'),
      });

      // Portland removed by old-style, then Seattle removed by registry
      expect(executedLocations).toEqual(['Denver']);
    });

    it('both afterToolExecution sources run: old-style then registry', async () => {
      const log: string[] = [];

      const hooks = new HookRegistry<OperativeHookMap>();
      hooks.on('afterToolExecution', async () => {
        log.push('registry-afterToolExecution');
      });

      const generate = createMockGenerate([
        toolCallResponse([weatherToolCall('Denver')]),
        textResponse('Done'),
      ]);

      await run({
        generate,
        toolbox: createTestToolbox([tool]),
        conversation: new Conversation(),
        stopWhen: noToolCalls(),
        hooks,
        afterToolExecution: async () => {
          log.push('array-afterToolExecution');
        },
      });

      expect(log).toEqual(['array-afterToolExecution', 'registry-afterToolExecution']);
    });
  });

  describe('priority ordering', () => {
    it('higher priority handlers run first within the registry', async () => {
      const log: string[] = [];

      const hooks = new HookRegistry<OperativeHookMap>();

      hooks.on(
        'onStep',
        async () => {
          log.push('low-priority');
        },
        { priority: 1 },
      );

      hooks.on(
        'onStep',
        async () => {
          log.push('high-priority');
        },
        { priority: 10 },
      );

      hooks.on(
        'onStep',
        async () => {
          log.push('medium-priority');
        },
        { priority: 5 },
      );

      const generate = createMockGenerate([textResponse('Done')]);

      await run({
        generate,
        toolbox: createTestToolbox([]),
        conversation: new Conversation(),
        stopWhen: noToolCalls(),
        hooks,
      });

      expect(log).toEqual(['high-priority', 'medium-priority', 'low-priority']);
    });

    it('higher priority beforeToolExecution runs first and chains', async () => {
      const log: string[] = [];

      const hooks = new HookRegistry<OperativeHookMap>();

      hooks.on(
        'beforeToolExecution',
        async ({ toolCalls }) => {
          log.push('low-priority');
          return toolCalls;
        },
        { priority: 1 },
      );

      hooks.on(
        'beforeToolExecution',
        async ({ toolCalls }) => {
          log.push('high-priority');
          return toolCalls;
        },
        { priority: 10 },
      );

      const generate = createMockGenerate([
        toolCallResponse([weatherToolCall('Denver')]),
        textResponse('Done'),
      ]);

      await run({
        generate,
        toolbox: createTestToolbox([tool]),
        conversation: new Conversation(),
        stopWhen: noToolCalls(),
        hooks,
      });

      expect(log).toEqual(['high-priority', 'low-priority']);
    });
  });

  describe('validateToolResult via registry', () => {
    it('validateToolResult hook can transform results', async () => {
      const hooks = new HookRegistry<OperativeHookMap>();

      hooks.on('validateToolResult', async (result) => {
        return { ...result, output: '[redacted]' };
      });

      const generate = createMockGenerate([
        toolCallResponse([weatherToolCall('Denver')]),
        textResponse('Done'),
      ]);

      const runResult = await run({
        generate,
        toolbox: createTestToolbox([tool]),
        conversation: new Conversation(),
        stopWhen: noToolCalls(),
        hooks,
      });

      expect(runResult.steps[0].results[0].output).toBe('[redacted]');
    });
  });

  describe('error handling', () => {
    it('registry hook error terminates the loop', async () => {
      const hooks = new HookRegistry<OperativeHookMap>();

      hooks.on('onStep', async () => {
        throw new Error('registry hook failed');
      });

      const generate = createMockGenerate([textResponse('Hello')]);

      const result = await run({
        generate,
        toolbox: createTestToolbox([]),
        conversation: new Conversation(),
        stopWhen: noToolCalls(),
        hooks,
      });

      expect(result.finishReason).toBe('error');
      expect(result.error).toBeInstanceOf(Error);
    });
  });
});

// ---------------------------------------------------------------------------
// C3 hook map completeness — verify every new hook key is registerable on
// OperativeHookMap. These are structural type checks: if the key doesn't exist
// in OperativeHookMap, HookRegistry.on() would throw at runtime (unknown key).
// ---------------------------------------------------------------------------

describe('OperativeHookMap completeness (C3)', () => {
  describe('curated tool.* bubble event hooks', () => {
    it('onToolStarted is a valid hook key accepting ToolStartedHookContext', () => {
      const hooks = new HookRegistry<OperativeHookMap>();
      const calls: ToolStartedHookContext[] = [];
      hooks.on('onToolStarted', async (ctx) => {
        calls.push(ctx);
      });
      expect(typeof hooks.run).toBe('function');
    });

    it('onToolSettled is a valid hook key accepting ToolSettledHookContext', () => {
      const hooks = new HookRegistry<OperativeHookMap>();
      const calls: ToolSettledHookContext[] = [];
      hooks.on('onToolSettled', async (ctx) => {
        calls.push(ctx);
      });
      expect(typeof hooks.run).toBe('function');
    });

    it('onToolError is a valid hook key accepting ToolErrorHookContext', () => {
      const hooks = new HookRegistry<OperativeHookMap>();
      const calls: ToolErrorHookContext[] = [];
      hooks.on('onToolError', async (ctx) => {
        calls.push(ctx);
      });
      expect(typeof hooks.run).toBe('function');
    });

    it('onToolProgress is a valid hook key accepting ToolProgressHookContext', () => {
      const hooks = new HookRegistry<OperativeHookMap>();
      const calls: ToolProgressHookContext[] = [];
      hooks.on('onToolProgress', async (ctx) => {
        calls.push(ctx);
      });
      expect(typeof hooks.run).toBe('function');
    });

    it('onToolPolicyDenied is a valid hook key accepting ToolPolicyDeniedHookContext', () => {
      const hooks = new HookRegistry<OperativeHookMap>();
      const calls: ToolPolicyDeniedHookContext[] = [];
      hooks.on('onToolPolicyDenied', async (ctx) => {
        calls.push(ctx);
      });
      expect(typeof hooks.run).toBe('function');
    });
  });

  describe('session verb hooks', () => {
    it('onSessionRecover is a valid hook key accepting SessionRecoverHookContext', () => {
      const hooks = new HookRegistry<OperativeHookMap>();
      const calls: SessionRecoverHookContext[] = [];
      hooks.on('onSessionRecover', async (ctx) => {
        calls.push(ctx);
      });
      expect(typeof hooks.run).toBe('function');
    });

    it('onSessionCancel is a valid hook key accepting SessionCancelHookContext', () => {
      const hooks = new HookRegistry<OperativeHookMap>();
      const calls: SessionCancelHookContext[] = [];
      hooks.on('onSessionCancel', async (ctx) => {
        calls.push(ctx);
      });
      expect(typeof hooks.run).toBe('function');
    });

    it('onSessionFork is a valid hook key accepting SessionForkHookContext', () => {
      const hooks = new HookRegistry<OperativeHookMap>();
      const calls: SessionForkHookContext[] = [];
      hooks.on('onSessionFork', async (ctx) => {
        calls.push(ctx);
      });
      expect(typeof hooks.run).toBe('function');
    });

    it('onSessionSleep is a valid hook key accepting SessionSleepHookContext', () => {
      const hooks = new HookRegistry<OperativeHookMap>();
      const calls: SessionSleepHookContext[] = [];
      hooks.on('onSessionSleep', async (ctx) => {
        calls.push(ctx);
      });
      expect(typeof hooks.run).toBe('function');
    });

    it('onSessionSignal is a valid hook key accepting SessionSignalHookContext', () => {
      const hooks = new HookRegistry<OperativeHookMap>();
      const calls: SessionSignalHookContext[] = [];
      hooks.on('onSessionSignal', async (ctx) => {
        calls.push(ctx);
      });
      expect(typeof hooks.run).toBe('function');
    });

    it('onSessionUpdate is a valid hook key accepting SessionUpdateHookContext', () => {
      const hooks = new HookRegistry<OperativeHookMap>();
      const calls: SessionUpdateHookContext[] = [];
      hooks.on('onSessionUpdate', async (ctx) => {
        calls.push(ctx);
      });
      expect(typeof hooks.run).toBe('function');
    });

    it('onSessionQuery is a valid hook key accepting SessionQueryHookContext', () => {
      const hooks = new HookRegistry<OperativeHookMap>();
      const calls: SessionQueryHookContext[] = [];
      hooks.on('onSessionQuery', async (ctx) => {
        calls.push(ctx);
      });
      expect(typeof hooks.run).toBe('function');
    });
  });
});
