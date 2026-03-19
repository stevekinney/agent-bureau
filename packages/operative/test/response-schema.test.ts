import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { createTestToolbox } from 'armorer/test';
import { Conversation } from 'conversationalist';

import { noToolCalls } from '../src/conditions/predicates';
import { createRun } from '../src/create-run';
import { run } from '../src/run';
import { createRunRecorder } from '../src/test/index';
import type { GenerateResponse } from '../src/types';

function textResponse(content: string): GenerateResponse {
  return { content, toolCalls: [] };
}

function toolCallResponse(
  toolCalls: GenerateResponse['toolCalls'],
  content = '',
): GenerateResponse {
  return { content, toolCalls };
}

const schema = z.object({
  answer: z.string(),
  confidence: z.number(),
});

describe('structured output enforcement', () => {
  it('passes when valid JSON matches schema', async () => {
    const validJson = JSON.stringify({ answer: 'Hello', confidence: 0.95 });

    const result = await run({
      generate: async () => textResponse(validJson),
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      responseSchema: schema,
    });

    expect(result.finishReason).toBe('stop-condition');
    expect(result.schemaValidation?.success).toBe(true);
    expect(result.content).toBe(validJson);
  });

  it('returns schemaValidation.success=false with 0 retries on invalid response', async () => {
    const result = await run({
      generate: async () => textResponse('not valid json'),
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      responseSchema: schema,
      schemaRetries: 0,
    });

    expect(result.finishReason).toBe('stop-condition');
    expect(result.schemaValidation?.success).toBe(false);
    expect(result.schemaValidation?.error).toBeDefined();
  });

  it('re-prompts on invalid response and succeeds on retry', async () => {
    let callCount = 0;
    const generate = async () => {
      callCount++;
      if (callCount === 1) return textResponse('invalid');
      return textResponse(JSON.stringify({ answer: 'Fixed', confidence: 0.9 }));
    };

    const result = await run({
      generate,
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      responseSchema: schema,
      schemaRetries: 2,
    });

    expect(result.finishReason).toBe('stop-condition');
    expect(result.schemaValidation?.success).toBe(true);
    expect(callCount).toBe(2);
  });

  it('exhausts all schema retries and returns failure', async () => {
    let callCount = 0;
    const generate = async () => {
      callCount++;
      return textResponse('still invalid');
    };

    const result = await run({
      generate,
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      responseSchema: schema,
      schemaRetries: 2,
      maximumSteps: 10,
    });

    expect(result.schemaValidation?.success).toBe(false);
    // 1 original + 2 retries = 3 calls
    expect(callCount).toBe(3);
  });

  it('only applies on the final step (not mid-loop)', async () => {
    let callCount = 0;
    const generate = async () => {
      callCount++;
      if (callCount <= 2) {
        return toolCallResponse([{ name: 'noop', arguments: {} }], 'not json');
      }
      return textResponse(JSON.stringify({ answer: 'Done', confidence: 1.0 }));
    };

    const toolbox = createTestToolbox([]);

    const result = await run({
      generate,
      toolbox,
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      responseSchema: schema,
      maximumSteps: 10,
    });

    // Schema only checked on final text response (step 2), not on tool call steps
    expect(result.finishReason).toBe('stop-condition');
    expect(result.schemaValidation?.success).toBe(true);
  });

  it('emits response.schema-failed event on validation failure', async () => {
    let callCount = 0;
    const generate = async () => {
      callCount++;
      if (callCount === 1) return textResponse('bad');
      return textResponse(JSON.stringify({ answer: 'Good', confidence: 1.0 }));
    };

    const activeRun = createRun({
      generate,
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      responseSchema: schema,
      schemaRetries: 1,
    });

    const recorder = createRunRecorder(activeRun);
    await activeRun.result;

    const failedEvents = recorder.events.filter((e) => e.type === 'response.schema-failed');
    expect(failedEvents).toHaveLength(1);
    const detail = failedEvents[0].detail as {
      content: string;
      retriesRemaining: number;
    };
    expect(detail.content).toBe('bad');
    expect(detail.retriesRemaining).toBe(0);
  });

  it('does not add schemaValidation when responseSchema is not set', async () => {
    const result = await run({
      generate: async () => textResponse('hello'),
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
    });

    expect(result.schemaValidation).toBeUndefined();
  });
});
