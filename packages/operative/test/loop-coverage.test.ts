import { createTool } from 'armorer';
import { createTestToolbox } from 'armorer/test';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';
import { HookRegistry } from 'lifecycle';
import { z } from 'zod';

import { noToolCalls } from '../src/conditions/predicates';
import type { OperativeHookMap } from '../src/hooks';
import { executeLoop } from '../src/loop';
import { run } from '../src/run';
import type { GenerateResponse } from '../src/types';

function textResponse(content: string): GenerateResponse {
  return { content, toolCalls: [] };
}

describe('loop helper coverage', () => {
  it('exercises silent hooks, elicitation, tracing, and default context estimation together', async () => {
    const hooks = new HookRegistry<OperativeHookMap>();
    const hookCalls: string[] = [];

    hooks.on('onLLMInput', async () => {
      hookCalls.push('input:ok');
    });
    hooks.on('onLLMInput', async () => {
      throw new Error('ignored input hook error');
    });
    hooks.on('onLLMOutput', async () => {
      hookCalls.push('output:ok');
    });
    hooks.on('onRunComplete', async () => {
      hookCalls.push('complete:ok');
    });

    const approvalSchema = z.object({ approved: z.boolean() });
    const conversation = new Conversation();
    conversation.appendUserMessage('A'.repeat(500));

    const echoTool = createTool({
      name: 'echo_value',
      description: 'Echo a provided value.',
      input: z.object({ value: z.string() }),
      execute: async ({ value }) => ({ echoed: value }),
    });

    let generateCalls = 0;
    let traceCalls = 0;
    const result = await executeLoop({
      generate: async () => {
        generateCalls++;
        if (generateCalls === 1) {
          return {
            content: '',
            toolCalls: [{ id: 'call-1', name: 'echo_value', arguments: { value: 'hello' } }],
          };
        }

        return textResponse('done');
      },
      toolbox: createTestToolbox([echoTool]),
      conversation,
      stopWhen: noToolCalls(),
      hooks,
      onElicitation: async () => {
        return { data: { approved: true } } as never;
      },
      prepareStep: async ({ elicit }) => {
        if (!elicit) return;
        const response = await elicit('Approve execution?', approvalSchema);
        expect(response).toEqual({ approved: true });
      },
      contextManagement: {
        maxTokens: 10,
        onCompact: async () => {},
      },
      parentContext: { traceId: 'loop-coverage' },
      withTraceContext: async (_context, fn) => {
        traceCalls++;
        return fn();
      },
    });

    expect(result.finishReason).toBe('stop-condition');
    expect(result.content).toBe('done');
    expect(traceCalls).toBe(3);
    expect(hookCalls).toContain('input:ok');
    expect(hookCalls).toContain('output:ok');
    expect(hookCalls).toContain('complete:ok');
  });

  it('returns abort and error results from the loop helpers', async () => {
    const aborted = await executeLoop({
      generate: async () => textResponse('unused'),
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      signal: AbortSignal.abort('stop now'),
    });

    expect(aborted.finishReason).toBe('aborted');

    const failed = await executeLoop({
      generate: async () => {
        throw new Error('boom');
      },
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
    });

    expect(failed.finishReason).toBe('error');
    expect(failed.error).toBeInstanceOf(Error);
  });

  it('covers the retry delay abort path directly', async () => {
    const controller = new AbortController();
    let calls = 0;

    const result = await executeLoop({
      generate: async () => {
        calls++;
        if (calls === 1) {
          throw new Error('retry me');
        }

        return textResponse('unused');
      },
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      signal: controller.signal,
      retry: {
        attempts: 3,
        delay: 1000,
        sleep: async () => {
          controller.abort('cancel retry');
        },
      },
    });

    expect(result.finishReason).toBe('aborted');
    expect(calls).toBe(1);
  });

  it('covers the backpressure abort path directly', async () => {
    const controller = new AbortController();

    const result = await executeLoop({
      generate: async () => textResponse('unused'),
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      signal: controller.signal,
      backpressure: {
        beforeStep: () => {
          controller.abort('cancel backpressure');
          return { delay: 1000 };
        },
        onSuccess: () => {},
        onError: () => {},
      },
    });

    expect(result.finishReason).toBe('aborted');
  });

  it('covers synthetic tool error results when onError skips tool execution', async () => {
    const hooks = new HookRegistry<OperativeHookMap>();

    hooks.on('onError', async (context) => {
      if (context.phase === 'tool-execution') return 'skip';
      return undefined;
    });

    const throwingToolbox = {
      tools: () => [],
      execute: async () => {
        throw new Error('toolbox execute failed');
      },
      toObservable: () => ({ subscribe: () => ({ unsubscribe: () => {} }) }),
    };

    let calls = 0;
    const result = await run({
      generate: async () => {
        calls++;
        if (calls === 1) {
          return {
            content: '',
            toolCalls: [{ id: 'call-1', name: 'get_weather', arguments: { location: 'Denver' } }],
          };
        }

        return textResponse('after skip');
      },
      toolbox: throwingToolbox as never,
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      hooks,
    });

    expect(result.finishReason).toBe('stop-condition');
    expect(result.steps[0]?.results).toEqual([
      expect.objectContaining({
        toolName: 'get_weather',
        outcome: 'error',
        content: 'Tool execution skipped by onError hook',
      }),
    ]);
  });

  it('covers usage accumulation with multiple stop conditions', async () => {
    const result = await executeLoop({
      generate: async () => ({
        content: 'final',
        toolCalls: [],
        usage: { prompt: 3, completion: 2, total: 5 },
      }),
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: [async () => false, noToolCalls()],
    });

    expect(result.finishReason).toBe('stop-condition');
    expect(result.usage).toEqual({ prompt: 3, completion: 2, total: 5 });
    expect(result.content).toBe('final');
  });
});
