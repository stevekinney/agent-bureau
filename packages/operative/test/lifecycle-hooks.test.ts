import { createTool } from 'armorer';
import { createTestToolbox } from 'armorer/test';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';
import { HookRegistry } from 'lifecycle';
import { z } from 'zod';

import { noToolCalls } from '../src/conditions/predicates';
import type { OperativeHookMap } from '../src/hooks';
import type {
  AfterGenerateContext,
  BeforeGenerateContext,
  ErrorContext,
  LLMInputContext,
  LLMOutputContext,
  RunAbortContext,
  RunCompleteContext,
  RunErrorContext,
  RunStartContext,
} from '../src/hooks/types';
import { run } from '../src/run';
import { createMockGenerate } from '../src/test/index';
import type { GenerateContext, GenerateResponse } from '../src/types';

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
  return { content, toolCalls, usage: { prompt: 10, completion: 5, total: 15 } };
}

function textResponse(content: string): GenerateResponse {
  return { content, toolCalls: [], usage: { prompt: 10, completion: 5, total: 15 } };
}

describe('beforeGenerate hook', () => {
  it('receives correct context with conversation and toolbox', async () => {
    const contexts: BeforeGenerateContext[] = [];
    const hooks = new HookRegistry<OperativeHookMap>();

    hooks.on('beforeGenerate', async (context) => {
      contexts.push(context);
    });

    const generate = createMockGenerate([textResponse('Hello')]);

    await run({
      generate,
      toolbox: createTestToolbox([tool]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      hooks,
    });

    expect(contexts).toHaveLength(1);
    expect(contexts[0].conversation).toBeInstanceOf(Conversation);
    expect(contexts[0].step).toBe(0);
    expect(contexts[0].toolbox).toBeDefined();
    expect(contexts[0].signal).toBeInstanceOf(AbortSignal);
  });

  it('returning modified context passes it to generate', async () => {
    const hooks = new HookRegistry<OperativeHookMap>();
    const receivedContexts: GenerateContext[] = [];

    hooks.on('beforeGenerate', async (context) => {
      // Return a modified context with a different step
      return { ...context, step: 99 } as GenerateContext;
    });

    const generate = createMockGenerate([textResponse('Hello')]);
    const originalGenerate = generate;
    const wrappedGenerate: typeof generate = Object.assign(
      async (...args: Parameters<typeof generate>) => {
        receivedContexts.push(args[0]);
        return originalGenerate(...args);
      },
      { calls: generate.calls, callCount: generate.callCount },
    ) as typeof generate;

    await run({
      generate: wrappedGenerate,
      toolbox: createTestToolbox([tool]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      hooks,
    });

    expect(receivedContexts).toHaveLength(1);
    expect(receivedContexts[0].step).toBe(99);
  });

  it('returning void uses original context', async () => {
    const hooks = new HookRegistry<OperativeHookMap>();
    const receivedContexts: GenerateContext[] = [];

    hooks.on('beforeGenerate', async () => {
      // Return void
    });

    const generate = createMockGenerate([textResponse('Hello')]);
    const originalGenerate = generate;
    const wrappedGenerate: typeof generate = Object.assign(
      async (...args: Parameters<typeof generate>) => {
        receivedContexts.push(args[0]);
        return originalGenerate(...args);
      },
      { calls: generate.calls, callCount: generate.callCount },
    ) as typeof generate;

    await run({
      generate: wrappedGenerate,
      toolbox: createTestToolbox([tool]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      hooks,
    });

    expect(receivedContexts).toHaveLength(1);
    expect(receivedContexts[0].step).toBe(0);
  });

  it('multiple hooks chain as waterfall', async () => {
    const hooks = new HookRegistry<OperativeHookMap>();
    const receivedContexts: GenerateContext[] = [];

    hooks.on(
      'beforeGenerate',
      async (context) => {
        return { ...context, step: 42 } as GenerateContext;
      },
      { priority: 10 },
    );

    hooks.on(
      'beforeGenerate',
      async (context) => {
        // This should receive step=42 from the first hook
        return { ...context, step: context.step + 1 } as GenerateContext;
      },
      { priority: 5 },
    );

    const generate = createMockGenerate([textResponse('Hello')]);
    const originalGenerate = generate;
    const wrappedGenerate: typeof generate = Object.assign(
      async (...args: Parameters<typeof generate>) => {
        receivedContexts.push(args[0]);
        return originalGenerate(...args);
      },
      { calls: generate.calls, callCount: generate.callCount },
    ) as typeof generate;

    await run({
      generate: wrappedGenerate,
      toolbox: createTestToolbox([tool]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      hooks,
    });

    expect(receivedContexts).toHaveLength(1);
    // Waterfall: first sets step=42, second adds 1 = 43
    expect(receivedContexts[0].step).toBe(43);
  });
});

describe('afterGenerate hook', () => {
  it('receives response and duration', async () => {
    const contexts: AfterGenerateContext[] = [];
    const hooks = new HookRegistry<OperativeHookMap>();

    hooks.on('afterGenerate', async (context) => {
      contexts.push(context);
    });

    const generate = createMockGenerate([textResponse('Hello')]);

    await run({
      generate,
      toolbox: createTestToolbox([tool]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      hooks,
    });

    expect(contexts).toHaveLength(1);
    expect(contexts[0].response.content).toBe('Hello');
    expect(contexts[0].step).toBe(0);
    expect(typeof contexts[0].duration).toBe('number');
    expect(contexts[0].duration).toBeGreaterThanOrEqual(0);
    expect(contexts[0].conversation).toBeInstanceOf(Conversation);
  });

  it('returning modified response passes it downstream', async () => {
    const hooks = new HookRegistry<OperativeHookMap>();

    hooks.on('afterGenerate', async (context) => {
      return { ...context.response, content: context.response.content + ' [modified]' };
    });

    const generate = createMockGenerate([textResponse('Original')]);

    const result = await run({
      generate,
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      hooks,
    });

    expect(result.content).toBe('Original [modified]');
  });

  it('returning void uses original response', async () => {
    const hooks = new HookRegistry<OperativeHookMap>();

    hooks.on('afterGenerate', async () => {
      // Return void
    });

    const generate = createMockGenerate([textResponse('Original')]);

    const result = await run({
      generate,
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      hooks,
    });

    expect(result.content).toBe('Original');
  });
});

describe('onLLMInput hook', () => {
  it('fires with conversation and step info', async () => {
    const contexts: LLMInputContext[] = [];
    const hooks = new HookRegistry<OperativeHookMap>();

    hooks.on('onLLMInput', async (context) => {
      contexts.push(context);
    });

    const generate = createMockGenerate([textResponse('Hello')]);

    await run({
      generate,
      toolbox: createTestToolbox([tool]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      hooks,
    });

    expect(contexts).toHaveLength(1);
    expect(contexts[0].step).toBe(0);
    expect(contexts[0].conversation).toBeInstanceOf(Conversation);
    expect(typeof contexts[0].messageCount).toBe('number');
  });

  it('errors do not block the generate call', async () => {
    const hooks = new HookRegistry<OperativeHookMap>({
      onError: () => 'continue',
    });

    hooks.on('onLLMInput', async () => {
      throw new Error('monitoring failure');
    });

    const generate = createMockGenerate([textResponse('Hello')]);

    const result = await run({
      generate,
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      hooks,
    });

    // Should complete normally despite monitoring hook error
    expect(result.finishReason).toBe('stop-condition');
    expect(result.content).toBe('Hello');
  });
});

describe('onLLMOutput hook', () => {
  it('fires with response and duration', async () => {
    const contexts: LLMOutputContext[] = [];
    const hooks = new HookRegistry<OperativeHookMap>();

    hooks.on('onLLMOutput', async (context) => {
      contexts.push(context);
    });

    const generate = createMockGenerate([textResponse('Hello')]);

    await run({
      generate,
      toolbox: createTestToolbox([tool]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      hooks,
    });

    expect(contexts).toHaveLength(1);
    expect(contexts[0].step).toBe(0);
    expect(contexts[0].response.content).toBe('Hello');
    expect(typeof contexts[0].duration).toBe('number');
    expect(contexts[0].duration).toBeGreaterThanOrEqual(0);
    expect(contexts[0].conversation).toBeInstanceOf(Conversation);
  });

  it('errors do not block response processing', async () => {
    const hooks = new HookRegistry<OperativeHookMap>({
      onError: () => 'continue',
    });

    hooks.on('onLLMOutput', async () => {
      throw new Error('monitoring failure');
    });

    const generate = createMockGenerate([textResponse('Hello')]);

    const result = await run({
      generate,
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      hooks,
    });

    expect(result.finishReason).toBe('stop-condition');
    expect(result.content).toBe('Hello');
  });
});

describe('onRunStart hook', () => {
  it('fires before first step with conversation and toolbox', async () => {
    const contexts: RunStartContext[] = [];
    const hooks = new HookRegistry<OperativeHookMap>();
    const log: string[] = [];

    hooks.on('onRunStart', async (context) => {
      log.push('onRunStart');
      contexts.push(context);
    });

    hooks.on('onStep', async () => {
      log.push('onStep');
    });

    const generate = createMockGenerate([textResponse('Hello')]);

    await run({
      generate,
      toolbox: createTestToolbox([tool]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      hooks,
    });

    expect(contexts).toHaveLength(1);
    expect(contexts[0].conversation).toBeInstanceOf(Conversation);
    expect(contexts[0].toolbox).toBeDefined();
    expect(contexts[0].maximumSteps).toBe(25); // default
    expect(log[0]).toBe('onRunStart');
    expect(log[1]).toBe('onStep');
  });

  it('error in onRunStart aborts the run', async () => {
    const hooks = new HookRegistry<OperativeHookMap>();

    hooks.on('onRunStart', async () => {
      throw new Error('startup failure');
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
    expect(result.steps).toHaveLength(0);
  });
});

describe('onRunComplete hook', () => {
  it('fires after last step with result and duration', async () => {
    const contexts: RunCompleteContext[] = [];
    const hooks = new HookRegistry<OperativeHookMap>();

    hooks.on('onRunComplete', async (context) => {
      contexts.push(context);
    });

    const generate = createMockGenerate([textResponse('Hello')]);

    await run({
      generate,
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      hooks,
    });

    expect(contexts).toHaveLength(1);
    expect(contexts[0].result.content).toBe('Hello');
    expect(contexts[0].result.finishReason).toBe('stop-condition');
    expect(typeof contexts[0].totalDuration).toBe('number');
    expect(contexts[0].totalDuration).toBeGreaterThanOrEqual(0);
  });

  it('error in onRunComplete does not lose the result', async () => {
    const hooks = new HookRegistry<OperativeHookMap>({
      onError: () => 'continue',
    });

    hooks.on('onRunComplete', async () => {
      throw new Error('completion hook failure');
    });

    const generate = createMockGenerate([textResponse('Hello')]);

    const result = await run({
      generate,
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      hooks,
    });

    // Result should still be returned despite the hook error
    expect(result.content).toBe('Hello');
    expect(result.finishReason).toBe('stop-condition');
  });
});

describe('onRunError hook', () => {
  it('fires on error with partial steps', async () => {
    const contexts: RunErrorContext[] = [];
    const hooks = new HookRegistry<OperativeHookMap>();

    hooks.on('onRunError', async (context) => {
      contexts.push(context);
    });

    // Generate throws on first call to trigger an error
    const generate = async () => {
      throw new Error('deliberate failure');
    };

    const result = await run({
      generate,
      toolbox: createTestToolbox([tool]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      hooks,
    });

    expect(result.finishReason).toBe('error');
    expect(contexts).toHaveLength(1);
    expect(contexts[0].error).toBeInstanceOf(Error);
    expect(contexts[0].conversation).toBeInstanceOf(Conversation);
    expect(contexts[0].partialSteps).toBeDefined();
  });
});

describe('onRunAbort hook', () => {
  it('fires on abort with partial steps', async () => {
    const contexts: RunAbortContext[] = [];
    const hooks = new HookRegistry<OperativeHookMap>({
      onError: () => 'continue',
    });

    hooks.on('onRunAbort', async (context) => {
      contexts.push(context);
    });

    const abortController = new AbortController();

    // Abort after a short delay
    const generate = createMockGenerate([
      toolCallResponse([weatherToolCall('Denver')]),
      textResponse('Should not reach'),
    ]);

    const originalGenerate = generate;
    const wrappedGenerate: typeof generate = Object.assign(
      async (...args: Parameters<typeof generate>) => {
        const result = await originalGenerate(...args);
        // Abort after first step completes
        abortController.abort('test abort');
        return result;
      },
      { calls: generate.calls, callCount: generate.callCount },
    ) as typeof generate;

    const result = await run({
      generate: wrappedGenerate,
      toolbox: createTestToolbox([tool]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      hooks,
      signal: abortController.signal,
    });

    expect(result.finishReason).toBe('aborted');
    expect(contexts).toHaveLength(1);
    expect(contexts[0].reason).toBe('test abort');
    expect(contexts[0].conversation).toBeInstanceOf(Conversation);
    expect(contexts[0].partialSteps).toBeDefined();
  });
});

describe('onError hook (error recovery)', () => {
  it('returning retry retries the current step', async () => {
    const hooks = new HookRegistry<OperativeHookMap>();
    let retryCount = 0;

    hooks.on('onError', async (context: ErrorContext) => {
      retryCount++;
      if (context.retryCount < context.maxRetries) {
        return 'retry';
      }
      return undefined;
    });

    let callCount = 0;
    const generate = async () => {
      callCount++;
      if (callCount === 1) {
        throw new Error('transient error');
      }
      return textResponse('Recovered');
    };

    const result = await run({
      generate,
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      hooks,
    });

    expect(result.content).toBe('Recovered');
    expect(result.finishReason).toBe('stop-condition');
    expect(retryCount).toBe(1);
  });

  it('returning skip skips to next step', async () => {
    const hooks = new HookRegistry<OperativeHookMap>();

    hooks.on('onError', async () => {
      return 'skip';
    });

    let callCount = 0;
    const generate = async () => {
      callCount++;
      if (callCount === 1) {
        throw new Error('skip this step');
      }
      return textResponse('Step 2');
    };

    const result = await run({
      generate,
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      hooks,
    });

    expect(result.content).toBe('Step 2');
    expect(result.finishReason).toBe('stop-condition');
  });

  it('returning abort terminates the run', async () => {
    const hooks = new HookRegistry<OperativeHookMap>();

    hooks.on('onError', async () => {
      return 'abort';
    });

    const generate = async () => {
      throw new Error('fatal error');
    };

    const result = await run({
      generate,
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      hooks,
    });

    expect(result.finishReason).toBe('error');
  });

  it('returning void lets error propagate normally', async () => {
    const hooks = new HookRegistry<OperativeHookMap>();

    hooks.on('onError', async () => {
      // Return void
    });

    const generate = async () => {
      throw new Error('propagated error');
    };

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

  it('retry respects maxRetries to prevent infinite loops', async () => {
    const hooks = new HookRegistry<OperativeHookMap>();
    const errorContexts: ErrorContext[] = [];

    hooks.on('onError', async (context: ErrorContext) => {
      errorContexts.push({ ...context });
      return 'retry';
    });

    const generate = async () => {
      throw new Error('always fails');
    };

    const result = await run({
      generate,
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      hooks,
    });

    // Should eventually exhaust retries and error
    expect(result.finishReason).toBe('error');
    // The maxRetries default is 3, so we get 3 retry attempts
    expect(errorContexts.length).toBeGreaterThanOrEqual(1);
    // Each context should have incrementing retryCount
    for (let i = 0; i < errorContexts.length; i++) {
      expect(errorContexts[i].retryCount).toBe(i);
    }
  });
});

describe('existing hooks still work unchanged (regression)', () => {
  it('prepareStep, beforeToolExecution, afterToolExecution, onStep all fire correctly', async () => {
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

    await run({
      generate,
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
      'beforeToolExecution',
      'execute',
      'afterToolExecution',
      'onStep',
      'prepareStep',
      'onStep',
    ]);
  });

  it('HookRegistry-based hooks still work', async () => {
    const hooks = new HookRegistry<OperativeHookMap>();
    const steps: number[] = [];

    hooks.on('onStep', async (result) => {
      steps.push(result.step);
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

    expect(steps).toEqual([0, 1]);
  });

  it('validateResponse hook still works', async () => {
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

  it('selectTools hook still works', async () => {
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
});
