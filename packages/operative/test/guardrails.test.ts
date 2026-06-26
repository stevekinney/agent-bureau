import { createTool } from 'armorer';
import { createTestToolbox } from 'armorer/test';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';
import { z } from 'zod';

import { noToolCalls } from '../src/conditions/predicates';
import { createActiveRun } from '../src/create-run';
import { createRunRecorder } from '../src/test/index';
import type { GenerateResponse } from '../src/types';
const run = (options: Parameters<typeof createActiveRun>[0]) => createActiveRun(options).result;

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

function weatherToolCall(location = 'Denver') {
  return { name: 'get_weather', arguments: { location } };
}

describe('validateResponse guardrail', () => {
  it('modifies content when returning a new response', async () => {
    let callCount = 0;
    const generate = async () => {
      callCount++;
      return textResponse('raw content');
    };

    const result = await run({
      generate,
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      validateResponse: async (response) => {
        return { ...response, content: response.content.toUpperCase() };
      },
    });

    expect(result.content).toBe('RAW CONTENT');
  });

  it('passes through when returning void', async () => {
    const result = await run({
      generate: async () => textResponse('unchanged'),
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      validateResponse: async () => {
        // Return void — no modification
      },
    });

    expect(result.content).toBe('unchanged');
  });

  it('terminates the loop when throwing', async () => {
    const result = await run({
      generate: async () => textResponse('bad content'),
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      validateResponse: async () => {
        throw new Error('Response rejected');
      },
    });

    expect(result.finishReason).toBe('error');
  });

  it('receives correct step context', async () => {
    const contexts: Array<{ step: number; hasConversation: boolean }> = [];

    const result = await run({
      generate: async () => textResponse('Hello'),
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      validateResponse: async (_response, context) => {
        contexts.push({
          step: context.step,
          hasConversation: context.conversation instanceof Conversation,
        });
      },
    });

    expect(contexts).toHaveLength(1);
    expect(contexts[0].step).toBe(0);
    expect(contexts[0].hasConversation).toBe(true);
  });

  it('emits response.validated event when response is modified', async () => {
    const activeRun = createActiveRun({
      generate: async () => textResponse('original'),
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      validateResponse: async (response) => {
        return { ...response, content: 'modified' };
      },
    });

    const recorder = createRunRecorder(activeRun);
    await activeRun.result;

    const validatedEvents = recorder.events.filter((e) => e.type === 'response.validated');
    expect(validatedEvents).toHaveLength(1);
    const detail = validatedEvents[0].detail as {
      original: GenerateResponse;
      validated: GenerateResponse;
    };
    expect(detail.original.content).toBe('original');
    expect(detail.validated.content).toBe('modified');
  });
});

describe('validateToolResult guardrail', () => {
  it('modifies tool result content', async () => {
    let callIndex = 0;
    const generate = async () => {
      callIndex++;
      if (callIndex === 1) return toolCallResponse([weatherToolCall('Denver')]);
      return textResponse('Done');
    };

    const result = await run({
      generate,
      toolbox: createTestToolbox([weatherTool]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      validateToolResult: async (toolResult) => {
        return { ...toolResult, content: 'REDACTED' };
      },
    });

    expect(result.finishReason).toBe('stop-condition');
    expect(result.steps[0].results[0].content).toBe('REDACTED');
  });

  it('passes through when returning void', async () => {
    let callIndex = 0;
    const generate = async () => {
      callIndex++;
      if (callIndex === 1) return toolCallResponse([weatherToolCall('Denver')]);
      return textResponse('Done');
    };

    const result = await run({
      generate,
      toolbox: createTestToolbox([weatherTool]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      validateToolResult: async () => {
        // Return void — no modification
      },
    });

    expect(result.finishReason).toBe('stop-condition');
    expect(result.steps[0].results).toHaveLength(1);
  });

  it('terminates the loop when throwing', async () => {
    let callIndex = 0;
    const generate = async () => {
      callIndex++;
      if (callIndex === 1) return toolCallResponse([weatherToolCall('Denver')]);
      return textResponse('Done');
    };

    const result = await run({
      generate,
      toolbox: createTestToolbox([weatherTool]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      validateToolResult: async () => {
        throw new Error('Tool result rejected');
      },
    });

    expect(result.finishReason).toBe('error');
  });

  it('receives correct context with toolCalls and results', async () => {
    const contextData: Array<{ toolCallCount: number; resultCount: number }> = [];

    let callIndex = 0;
    const generate = async () => {
      callIndex++;
      if (callIndex === 1) return toolCallResponse([weatherToolCall('Denver')]);
      return textResponse('Done');
    };

    await run({
      generate,
      toolbox: createTestToolbox([weatherTool]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      validateToolResult: async (_result, context) => {
        contextData.push({
          toolCallCount: context.toolCalls.length,
          resultCount: context.results.length,
        });
      },
    });

    expect(contextData).toHaveLength(1);
    expect(contextData[0].toolCallCount).toBe(1);
    expect(contextData[0].resultCount).toBe(1);
  });

  it('emits tool-result.validated event when result is modified', async () => {
    let callIndex = 0;
    const generate = async () => {
      callIndex++;
      if (callIndex === 1) return toolCallResponse([weatherToolCall('Denver')]);
      return textResponse('Done');
    };

    const activeRun = createActiveRun({
      generate,
      toolbox: createTestToolbox([weatherTool]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      validateToolResult: async (toolResult) => {
        return { ...toolResult, content: 'validated' };
      },
    });

    const recorder = createRunRecorder(activeRun);
    await activeRun.result;

    const validatedEvents = recorder.events.filter((e) => e.type === 'tool-result.validated');
    expect(validatedEvents).toHaveLength(1);
  });
});
