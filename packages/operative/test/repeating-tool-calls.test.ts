import { createTool } from 'armorer';
import { createTestToolbox } from 'armorer/test';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';
import { z } from 'zod';

import { repeatingToolCalls } from '../src/conditions/predicates';
import { run } from '../src/run';
import { createMockGenerate } from '../src/test/index';
import type { GenerateResponse, StepResult } from '../src/types';

const weatherTool = createTool({
  name: 'get_weather',
  description: 'Get weather',
  input: z.object({ location: z.string() }),
  execute: async ({ location }) => ({ temperature: 72, location }),
});

function weatherToolCall(location = 'Denver') {
  return { name: 'get_weather', arguments: { location } };
}

function textResponse(content: string): GenerateResponse {
  return { content, toolCalls: [] };
}

function toolCallResponse(
  toolCalls: GenerateResponse['toolCalls'],
  content = '',
): GenerateResponse {
  return { content, toolCalls };
}

const makeStepResult = (overrides: Partial<StepResult> = {}): StepResult => ({
  step: 0,
  conversation: {} as any,
  content: '',
  toolCalls: [],
  results: [],
  final: false,
  ...overrides,
});

describe('repeatingToolCalls', () => {
  it('does not trigger before window size is reached', () => {
    const condition = repeatingToolCalls({ windowSize: 3 });

    const result1 = condition(
      makeStepResult({
        toolCalls: [{ id: 'c1', name: 'get_weather', arguments: { location: 'Denver' } }],
      }),
    );
    const result2 = condition(
      makeStepResult({
        toolCalls: [{ id: 'c2', name: 'get_weather', arguments: { location: 'Denver' } }],
      }),
    );

    expect(result1).toBe(false);
    expect(result2).toBe(false);
  });

  it('triggers after windowSize consecutive identical tool calls', () => {
    const condition = repeatingToolCalls({ windowSize: 3 });

    condition(
      makeStepResult({
        toolCalls: [{ id: 'c1', name: 'get_weather', arguments: { location: 'Denver' } }],
      }),
    );
    condition(
      makeStepResult({
        toolCalls: [{ id: 'c2', name: 'get_weather', arguments: { location: 'Denver' } }],
      }),
    );
    const result = condition(
      makeStepResult({
        toolCalls: [{ id: 'c3', name: 'get_weather', arguments: { location: 'Denver' } }],
      }),
    );

    expect(result).toBe(true);
  });

  it('does not trigger when tool calls differ', () => {
    const condition = repeatingToolCalls({ windowSize: 3 });

    condition(
      makeStepResult({
        toolCalls: [{ id: 'c1', name: 'get_weather', arguments: { location: 'Denver' } }],
      }),
    );
    condition(
      makeStepResult({
        toolCalls: [{ id: 'c2', name: 'get_weather', arguments: { location: 'Seattle' } }],
      }),
    );
    const result = condition(
      makeStepResult({
        toolCalls: [{ id: 'c3', name: 'get_weather', arguments: { location: 'Denver' } }],
      }),
    );

    expect(result).toBe(false);
  });

  it('text-only steps never trigger and break the window', () => {
    const condition = repeatingToolCalls({ windowSize: 2 });

    condition(
      makeStepResult({
        toolCalls: [{ id: 'c1', name: 'get_weather', arguments: { location: 'Denver' } }],
      }),
    );
    // Text-only step breaks the consecutive sequence
    condition(makeStepResult({ toolCalls: [], content: 'Thinking...' }));
    const result = condition(
      makeStepResult({
        toolCalls: [{ id: 'c2', name: 'get_weather', arguments: { location: 'Denver' } }],
      }),
    );

    expect(result).toBe(false);
  });

  it('defaults to windowSize of 3', () => {
    const condition = repeatingToolCalls();

    condition(
      makeStepResult({
        toolCalls: [{ id: 'c1', name: 'get_weather', arguments: { location: 'Denver' } }],
      }),
    );
    condition(
      makeStepResult({
        toolCalls: [{ id: 'c2', name: 'get_weather', arguments: { location: 'Denver' } }],
      }),
    );
    const result = condition(
      makeStepResult({
        toolCalls: [{ id: 'c3', name: 'get_weather', arguments: { location: 'Denver' } }],
      }),
    );

    expect(result).toBe(true);
  });

  it('is order-independent for multiple tool calls in a single step', () => {
    const condition = repeatingToolCalls({ windowSize: 2 });

    condition(
      makeStepResult({
        toolCalls: [
          { id: 'c1', name: 'tool_a', arguments: { x: 1 } },
          { id: 'c2', name: 'tool_b', arguments: { y: 2 } },
        ],
      }),
    );
    // Same tools in different order
    const result = condition(
      makeStepResult({
        toolCalls: [
          { id: 'c3', name: 'tool_b', arguments: { y: 2 } },
          { id: 'c4', name: 'tool_a', arguments: { x: 1 } },
        ],
      }),
    );

    expect(result).toBe(true);
  });

  it('accepts a custom fingerprint function', () => {
    const condition = repeatingToolCalls({
      windowSize: 2,
      fingerprint: (toolCalls) => toolCalls.map((c) => c.name).join(','),
    });

    condition(
      makeStepResult({
        toolCalls: [{ id: 'c1', name: 'get_weather', arguments: { location: 'Denver' } }],
      }),
    );
    // Different arguments but same name — custom fingerprint ignores arguments
    const result = condition(
      makeStepResult({
        toolCalls: [{ id: 'c2', name: 'get_weather', arguments: { location: 'Seattle' } }],
      }),
    );

    expect(result).toBe(true);
  });

  it('stops the agent loop when stuck in a repeating pattern', async () => {
    const generate = createMockGenerate([
      toolCallResponse([weatherToolCall('Denver')]),
      toolCallResponse([weatherToolCall('Denver')]),
      toolCallResponse([weatherToolCall('Denver')]),
      textResponse('Should not reach here'),
    ]);

    const result = await run({
      generate,
      toolbox: createTestToolbox([weatherTool]),
      conversation: new Conversation(),
      stopWhen: repeatingToolCalls({ windowSize: 3 }),
      maximumSteps: 10,
    });

    expect(result.finishReason).toBe('stop-condition');
    expect(result.steps).toHaveLength(3);
  });

  it('keeps bounded memory with 100+ steps', () => {
    const condition = repeatingToolCalls({ windowSize: 3 });

    // Feed 100 distinct steps to grow history
    for (let i = 0; i < 100; i++) {
      condition(
        makeStepResult({
          toolCalls: [{ id: `c${i}`, name: 'get_weather', arguments: { location: `City${i}` } }],
        }),
      );
    }

    // Now feed 3 identical steps
    for (let i = 0; i < 2; i++) {
      const result = condition(
        makeStepResult({
          toolCalls: [{ id: `r${i}`, name: 'get_weather', arguments: { location: 'Denver' } }],
        }),
      );
      expect(result).toBe(false);
    }

    const final = condition(
      makeStepResult({
        toolCalls: [{ id: 'r2', name: 'get_weather', arguments: { location: 'Denver' } }],
      }),
    );
    expect(final).toBe(true);
  });

  it('allows the loop to continue when tool calls vary', async () => {
    const generate = createMockGenerate([
      toolCallResponse([weatherToolCall('Denver')]),
      toolCallResponse([weatherToolCall('Seattle')]),
      toolCallResponse([weatherToolCall('Portland')]),
      toolCallResponse([weatherToolCall('Chicago')]),
    ]);

    const result = await run({
      generate,
      toolbox: createTestToolbox([weatherTool]),
      conversation: new Conversation(),
      stopWhen: repeatingToolCalls({ windowSize: 3 }),
      maximumSteps: 4,
    });

    expect(result.finishReason).toBe('maximum-steps');
    expect(result.steps).toHaveLength(4);
  });
});
