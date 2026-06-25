import { createTool, createToolbox } from 'armorer';
import { createTestToolbox } from 'armorer/test';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';
import { z } from 'zod';

import { noToolCalls } from '../src/conditions/predicates.ts';
import { createActiveRun } from '../src/create-run.ts';
import { createSubagentTool } from '../src/create-subagent-tool.ts';
import { executeLoop } from '../src/loop.ts';
import type { GenerateResponse, RunOptions } from '../src/types.ts';

function textResponse(content: string): GenerateResponse {
  return { content, toolCalls: [] };
}

function toolCallResponse(
  toolCalls: GenerateResponse['toolCalls'],
  content = '',
): GenerateResponse {
  return { content, toolCalls };
}

describe('trace context propagation', () => {
  describe('ToolContext.traceContext', () => {
    it('traceContext flows through toolbox context to raw ToolConfiguration entries', async () => {
      let receivedTraceContext: unknown;

      const traceContext = { traceId: 'parent-trace-123' };
      const toolbox = createToolbox(
        [
          {
            name: 'spy',
            description: 'spy tool',
            input: z.object({ input: z.string() }),
            execute: async (_params: unknown, context: { traceContext?: unknown }) => {
              receivedTraceContext = context.traceContext;
              return 'ok';
            },
          },
        ],
        { context: { traceContext } },
      );

      await toolbox.execute([{ id: 'call-1', name: 'spy', arguments: { input: 'test' } }]);

      expect(receivedTraceContext).toEqual(traceContext);
    });

    it('traceContext flows through toolbox context to pre-built Tool objects', async () => {
      let receivedTraceContext: unknown;

      const tool = createTool({
        name: 'spy',
        description: 'spy tool',
        input: z.object({ input: z.string() }),
        execute: async (_params: { input: string }, context: { traceContext?: unknown }) => {
          receivedTraceContext = context.traceContext;
          return 'ok';
        },
      });

      const traceContext = { traceId: 'pre-built-trace-456' };
      const toolbox = createToolbox([tool], { context: { traceContext } });

      await toolbox.execute([{ id: 'call-1', name: 'spy', arguments: { input: 'test' } }]);

      expect(receivedTraceContext).toEqual(traceContext);
    });
  });

  describe('createSubagentTool', () => {
    it('forwards context.traceContext to the run callback', async () => {
      let receivedTraceContext: unknown;

      const subTool = createSubagentTool({
        name: 'delegate',
        description: 'Delegate',
        agentName: 'sub',
        run: async (_input, context) => {
          receivedTraceContext = context.traceContext;
          return {
            conversation: {} as never,
            steps: [],
            content: 'done',
            usage: { prompt: 0, completion: 0, total: 0 },
            finishReason: 'stop-condition' as const,
          };
        },
        input: z.object({ task: z.string() }),
      });

      let callCount = 0;
      const generate = async () => {
        callCount++;
        if (callCount === 1) {
          return toolCallResponse([{ name: 'delegate', arguments: { task: 'do it' } }]);
        }
        return textResponse('parent done');
      };

      const traceContext = { traceId: 'parent-trace' };
      const parentToolbox = createToolbox([subTool], { context: { traceContext } });

      await executeLoop({
        generate,
        toolbox: parentToolbox,
        conversation: new Conversation(),
        stopWhen: noToolCalls(),
      });

      expect(receivedTraceContext).toEqual(traceContext);
    });

    it('does not forward traceContext when not present in tool context', async () => {
      let receivedTraceContext: unknown = 'not-set';

      const subTool = createSubagentTool({
        name: 'delegate',
        description: 'Delegate',
        agentName: 'sub',
        run: async (_input, context) => {
          receivedTraceContext = context.traceContext;
          return {
            conversation: {} as never,
            steps: [],
            content: 'done',
            usage: { prompt: 0, completion: 0, total: 0 },
            finishReason: 'stop-condition' as const,
          };
        },
        input: z.object({ task: z.string() }),
      });

      let callCount = 0;
      const generate = async () => {
        callCount++;
        if (callCount === 1) {
          return toolCallResponse([{ name: 'delegate', arguments: { task: 'do it' } }]);
        }
        return textResponse('parent done');
      };

      await executeLoop({
        generate,
        toolbox: createTestToolbox([subTool]),
        conversation: new Conversation(),
        stopWhen: noToolCalls(),
      });

      // Without traceContext on the toolbox, it should be undefined
      expect(receivedTraceContext).toBeUndefined();
    });
  });

  describe('executeLoop with withTraceContext', () => {
    it('calls withTraceContext around generate when both fields present', async () => {
      const wrapCalls: string[] = [];
      const parentContext = { traceId: 'test-trace' };

      const options: RunOptions = {
        generate: async () => textResponse('hello'),
        toolbox: createTestToolbox([]),
        conversation: new Conversation(),
        stopWhen: noToolCalls(),
        parentContext,
        withTraceContext: async (_ctx, fn) => {
          wrapCalls.push('generate');
          return fn();
        },
      };

      await executeLoop(options);

      expect(wrapCalls).toContain('generate');
    });

    it('calls withTraceContext around tool execution when both fields present', async () => {
      const wrapCalls: string[] = [];
      const parentContext = { traceId: 'test-trace' };

      const echoTool = createTool({
        name: 'echo',
        description: 'echo tool',
        input: z.object({ input: z.string() }),
        execute: async (params: { input: string }) => params.input,
      });

      let callCount = 0;
      const options: RunOptions = {
        generate: async () => {
          callCount++;
          if (callCount === 1) {
            return toolCallResponse([{ name: 'echo', arguments: { input: 'hi' } }]);
          }
          return textResponse('done');
        },
        toolbox: createTestToolbox([echoTool]),
        conversation: new Conversation(),
        stopWhen: noToolCalls(),
        parentContext,
        withTraceContext: async (_ctx, fn) => {
          wrapCalls.push('wrapped');
          return fn();
        },
      };

      await executeLoop(options);

      // Should be called at least twice: once for generate, once for tool execution
      expect(wrapCalls.length).toBeGreaterThanOrEqual(2);
    });

    it('does not wrap when parentContext is absent', async () => {
      let wrapCalled = false;

      const options: RunOptions = {
        generate: async () => textResponse('hello'),
        toolbox: createTestToolbox([]),
        conversation: new Conversation(),
        stopWhen: noToolCalls(),
        withTraceContext: async (_ctx, fn) => {
          wrapCalled = true;
          return fn();
        },
      };

      await executeLoop(options);

      expect(wrapCalled).toBe(false);
    });

    it('does not wrap when withTraceContext is absent', async () => {
      const options: RunOptions = {
        generate: async () => textResponse('hello'),
        toolbox: createTestToolbox([]),
        conversation: new Conversation(),
        stopWhen: noToolCalls(),
        parentContext: { traceId: 'test' },
      };

      // Should not throw — withTraceContext is undefined, so no wrapping
      const result = await executeLoop(options);
      expect(result.finishReason).toBe('stop-condition');
    });
  });

  describe('createActiveRun with parentContext', () => {
    it('passes parentContext through to executeLoop via createActiveRun', async () => {
      let receivedParentContext: unknown;

      const parentContext = { traceId: 'parent-123' };
      const activeRun = createActiveRun({
        generate: async () => textResponse('done'),
        toolbox: createTestToolbox([]),
        conversation: new Conversation(),
        stopWhen: noToolCalls(),
        parentContext,
        withTraceContext: async (ctx, fn) => {
          receivedParentContext = ctx;
          return fn();
        },
      });

      await activeRun.result;

      expect(receivedParentContext).toEqual(parentContext);
    });

    it('parentContext flows end-to-end through createActiveRun to executeLoop', async () => {
      const wrapCalls: unknown[] = [];

      const parentContext = { traceId: 'e2e-trace', spanId: 'e2e-span' };
      const activeRun = createActiveRun({
        generate: async () => textResponse('done'),
        toolbox: createTestToolbox([]),
        conversation: new Conversation(),
        stopWhen: noToolCalls(),
        parentContext,
        withTraceContext: async (ctx, fn) => {
          wrapCalls.push(ctx);
          return fn();
        },
      });

      await activeRun.result;

      expect(wrapCalls).toHaveLength(1);
      expect(wrapCalls[0]).toEqual(parentContext);
    });
  });
});
