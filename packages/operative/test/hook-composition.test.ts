import { createTool } from 'armorer';
import { createTestToolbox } from 'armorer/test';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';
import { z } from 'zod';

import { noToolCalls } from '../src/conditions/predicates';
import { createActiveRun } from '../src/create-run';
import { createMockGenerate, createRunRecorder } from '../src/test/index';
import type { GenerateResponse, Toolbox } from '../src/types';
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
  return { content, toolCalls };
}

function textResponse(content: string): GenerateResponse {
  return { content, toolCalls: [] };
}

describe('hook composition (array-valued hooks)', () => {
  describe('prepareStep', () => {
    it('array of two functions: both called when first returns void', async () => {
      const calls: string[] = [];
      const generate = createMockGenerate([textResponse('Hello')]);

      await run({
        generate,
        toolbox: createTestToolbox([tool]),
        conversation: new Conversation(),
        stopWhen: noToolCalls(),
        prepareStep: [
          async () => {
            calls.push('first');
            return undefined;
          },
          async () => {
            calls.push('second');
            return undefined;
          },
        ],
      });

      expect(calls).toEqual(['first', 'second']);
      expect(generate.callCount).toBe(1);
    });

    it('first returns void, second returns GenerateResponse — generate is skipped', async () => {
      const calls: string[] = [];
      const generate = createMockGenerate([textResponse('Should not be called')]);

      const result = await run({
        generate,
        toolbox: createTestToolbox([tool]),
        conversation: new Conversation(),
        stopWhen: noToolCalls(),
        prepareStep: [
          async () => {
            calls.push('first');
            return undefined;
          },
          async () => {
            calls.push('second');
            return { content: 'Intercepted', toolCalls: [] };
          },
        ],
      });

      expect(calls).toEqual(['first', 'second']);
      expect(generate.callCount).toBe(0);
      expect(result.content).toBe('Intercepted');
    });

    it('first returns GenerateResponse — second is skipped', async () => {
      const calls: string[] = [];
      const generate = createMockGenerate([textResponse('Should not be called')]);

      const result = await run({
        generate,
        toolbox: createTestToolbox([tool]),
        conversation: new Conversation(),
        stopWhen: noToolCalls(),
        prepareStep: [
          async () => {
            calls.push('first');
            return { content: 'Early return', toolCalls: [] };
          },
          async () => {
            calls.push('second');
            return undefined;
          },
        ],
      });

      expect(calls).toEqual(['first']);
      expect(generate.callCount).toBe(0);
      expect(result.content).toBe('Early return');
    });
  });

  describe('beforeToolExecution', () => {
    it('array: chained filtering', async () => {
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
        beforeToolExecution: [
          // First hook: remove Portland
          async ({ toolCalls }) =>
            toolCalls.filter(
              (tc) => (tc.arguments as { location: string }).location !== 'Portland',
            ),
          // Second hook: remove Seattle
          async ({ toolCalls }) =>
            toolCalls.filter((tc) => (tc.arguments as { location: string }).location !== 'Seattle'),
        ],
      });

      expect(executedLocations).toEqual(['Denver']);
    });
  });

  describe('selectTools', () => {
    it('array: last hook determines the toolbox', async () => {
      const tool2 = createTool({
        name: 'search',
        description: 'Search',
        input: z.object({ query: z.string() }),
        execute: async ({ query }) => ({ results: [query] }),
      });

      const generate = createMockGenerate([textResponse('Done')]);

      const toolboxes: Toolbox[] = [];
      await run({
        generate,
        toolbox: createTestToolbox([tool, tool2]),
        conversation: new Conversation(),
        stopWhen: noToolCalls(),
        selectTools: [
          async () => {
            const tb = createTestToolbox([tool]);
            toolboxes.push(tb);
            return tb;
          },
          async () => {
            const tb = createTestToolbox([tool2]);
            toolboxes.push(tb);
            return tb;
          },
        ],
      });

      expect(toolboxes).toHaveLength(2);
    });
  });

  describe('validateResponse', () => {
    it('array: chained transformation', async () => {
      const generate = createMockGenerate([textResponse('original')]);

      const result = await run({
        generate,
        toolbox: createTestToolbox([]),
        conversation: new Conversation(),
        stopWhen: noToolCalls(),
        validateResponse: [
          async (response) => ({
            ...response,
            content: response.content + '-first',
          }),
          async (response) => ({
            ...response,
            content: response.content + '-second',
          }),
        ],
      });

      expect(result.content).toBe('original-first-second');
    });
  });

  describe('afterToolExecution', () => {
    it('array: both called in sequence', async () => {
      const calls: string[] = [];
      const generate = createMockGenerate([
        toolCallResponse([weatherToolCall('Denver')]),
        textResponse('Done'),
      ]);

      await run({
        generate,
        toolbox: createTestToolbox([tool]),
        conversation: new Conversation(),
        stopWhen: noToolCalls(),
        afterToolExecution: [
          async () => {
            calls.push('first');
          },
          async () => {
            calls.push('second');
          },
        ],
      });

      expect(calls).toEqual(['first', 'second']);
    });
  });

  describe('onStep', () => {
    it('array: both called in sequence', async () => {
      const calls: string[] = [];
      const generate = createMockGenerate([textResponse('Hello')]);

      await run({
        generate,
        toolbox: createTestToolbox([]),
        conversation: new Conversation(),
        stopWhen: noToolCalls(),
        onStep: [
          async () => {
            calls.push('first');
          },
          async () => {
            calls.push('second');
          },
        ],
      });

      expect(calls).toEqual(['first', 'second']);
    });
  });

  describe('backward compatibility', () => {
    it('single function still works for all hook types', async () => {
      const calls: string[] = [];

      const generate = createMockGenerate([
        toolCallResponse([weatherToolCall('Denver')]),
        textResponse('Done'),
      ]);

      await run({
        generate,
        toolbox: createTestToolbox([tool]),
        conversation: new Conversation(),
        stopWhen: noToolCalls(),
        prepareStep: async () => {
          calls.push('prepareStep');
          return undefined;
        },
        beforeToolExecution: async ({ toolCalls }) => {
          calls.push('beforeToolExecution');
          return toolCalls;
        },
        afterToolExecution: async () => {
          calls.push('afterToolExecution');
        },
        onStep: async () => {
          calls.push('onStep');
        },
      });

      expect(calls).toContain('prepareStep');
      expect(calls).toContain('beforeToolExecution');
      expect(calls).toContain('afterToolExecution');
      expect(calls).toContain('onStep');
    });
  });

  describe('error handling', () => {
    it('error in any hook member terminates the loop with run.error', async () => {
      const generate = createMockGenerate([textResponse('Hello')]);

      const activeRun = createActiveRun({
        generate,
        toolbox: createTestToolbox([]),
        conversation: new Conversation(),
        stopWhen: noToolCalls(),
        onStep: [
          async () => {
            throw new Error('hook failed');
          },
          async () => {
            // should not be called
          },
        ],
      });

      const recorder = createRunRecorder(activeRun);
      const result = await activeRun.result;

      expect(result.finishReason).toBe('error');
      const errorEvents = recorder.events.filter((e) => e.type === 'run.error');
      expect(errorEvents).toHaveLength(1);
    });
  });
});
