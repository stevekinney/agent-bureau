import { createTestToolbox } from 'armorer/test';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';
import { z } from 'zod';

import { noToolCalls } from '../src/conditions/predicates';
import { createActiveRun } from '../src/create-run';
import {
  NonJsonOutputError,
  OutputSchemaConversionError,
  OutputValidationError,
} from '../src/errors';
import { validateOutputValue } from '../src/structured-output/response-schema';
import { createRunRecorder } from '../src/test/index';
import type { GenerateResponse } from '../src/types';
const run = (options: Parameters<typeof createActiveRun>[0]) => createActiveRun(options).result;

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
      output: schema,
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
      output: schema,
      schemaRetries: 0,
    });

    expect(result.finishReason).toBe('stop-condition');
    expect(result.schemaValidation?.success).toBe(false);
    expect(result.schemaValidation?.error).toBeDefined();
  });

  it('wraps non-JSON final text in NonJsonOutputError, not OutputValidationError', async () => {
    const result = await run({
      generate: async () => textResponse('not valid json'),
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      output: schema,
      schemaRetries: 0,
    });

    expect(result.schemaValidation?.error).toBeInstanceOf(NonJsonOutputError);
    expect((result.schemaValidation?.error as NonJsonOutputError).code).toBe('NON_JSON_OUTPUT');
  });

  it('wraps valid-JSON-but-schema-mismatched text in OutputValidationError, not NonJsonOutputError', async () => {
    const result = await run({
      generate: async () => textResponse(JSON.stringify({ answer: 'Hello' })), // missing `confidence`
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      output: schema,
      schemaRetries: 0,
    });

    const error = result.schemaValidation?.error as OutputValidationError;
    expect(error).toBeInstanceOf(OutputValidationError);
    expect(error.code).toBe('INVALID_OUTPUT');
    // The underlying ZodError's per-field issues are exposed as a first-class
    // field, not just buried in `cause`.
    expect(error.issues.length).toBeGreaterThan(0);
    expect(error.issues[0]?.path).toEqual(['confidence']);
  });

  it('validates a `z.string()` output schema against non-JSON raw text directly', async () => {
    const result = await run({
      generate: async () => textResponse('plain text, not JSON'),
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      output: z.string(),
    });

    expect(result.schemaValidation?.success).toBe(true);
    expect(result.output).toBe('plain text, not JSON');
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
      output: schema,
      schemaRetries: 2,
    });

    expect(result.finishReason).toBe('stop-condition');
    expect(result.schemaValidation?.success).toBe(true);
    expect(callCount).toBe(2);
  });

  it('validates each retry candidate independently — a new invalid candidate does not reuse the previous error', async () => {
    const seenTexts: string[] = [];
    let callCount = 0;
    const generate = async () => {
      callCount++;
      if (callCount === 1)
        return textResponse(JSON.stringify({ answer: 'Bad', confidence: 'not-a-number' }));
      if (callCount === 2) return textResponse('not json at all');
      return textResponse(JSON.stringify({ answer: 'Good', confidence: 1 }));
    };

    const result = await run({
      generate,
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      output: schema,
      schemaRetries: 2,
      schemaRetryMessage: (error) => {
        seenTexts.push(String(error));
        return 'retry';
      },
    });

    expect(result.schemaValidation?.success).toBe(true);
    expect(callCount).toBe(3);
    // Two distinct failures were validated independently (an OutputValidationError,
    // then a NonJsonOutputError) — the second retry did not just re-check the first.
    expect(seenTexts).toHaveLength(2);
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
      output: schema,
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
      output: schema,
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

    const activeRun = createActiveRun({
      generate,
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      output: schema,
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

  it('uses custom schemaRetryMessage when provided', async () => {
    const retryMessages: string[] = [];
    let callCount = 0;
    const generate = async () => {
      callCount++;
      if (callCount === 1) return textResponse('bad');
      return textResponse(JSON.stringify({ answer: 'Fixed', confidence: 0.9 }));
    };

    const result = await run({
      generate,
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      output: schema,
      schemaRetries: 1,
      schemaRetryMessage: (error, attempt) => {
        const message = `Custom retry #${attempt}: ${String(error)}`;
        retryMessages.push(message);
        return message;
      },
    });

    expect(result.schemaValidation?.success).toBe(true);
    expect(retryMessages).toHaveLength(1);
    expect(retryMessages[0]).toMatch(/^Custom retry #1:/);

    // Verify the custom message was appended to the conversation
    const messages = result.conversation.getMessages();
    const userMessages = messages.filter((m) => m.role === 'user');
    const retryUserMessage = userMessages.find(
      (m) => typeof m.content === 'string' && m.content.startsWith('Custom retry'),
    );
    expect(retryUserMessage).toBeDefined();
  });

  it('does not add schemaValidation when no output schema is set', async () => {
    const result = await run({
      generate: async () => textResponse('hello'),
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
    });

    expect(result.schemaValidation).toBeUndefined();
  });

  it('puts the validated value on the distinct output field for a Zod schema', async () => {
    const validJson = JSON.stringify({ answer: 'Hello', confidence: 0.95 });

    const result = await run({
      generate: async () => textResponse(validJson),
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      output: schema,
    });

    expect(result.output).toEqual({ answer: 'Hello', confidence: 0.95 });
    // Distinct from `content` — the raw model text — not merely equal to it.
    expect(result.output).not.toBe(result.content);
  });

  it('does not set output when validation fails', async () => {
    const result = await run({
      generate: async () => textResponse('not valid json'),
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      output: schema,
      schemaRetries: 0,
    });

    expect(result.schemaValidation?.success).toBe(false);
    expect(result.output).toBeUndefined();
  });

  it('runs a schema transform exactly once per candidate (async transform observed once)', async () => {
    let transformCalls = 0;
    const transformingSchema = z.object({ answer: z.string() }).transform(async (value) => {
      transformCalls++;
      return { ...value, transformed: true };
    });

    const result = await run({
      generate: async () => textResponse(JSON.stringify({ answer: 'Hello' })),
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      output: transformingSchema,
    });

    expect(result.schemaValidation?.success).toBe(true);
    expect(result.output).toEqual({ answer: 'Hello', transformed: true });
    expect(transformCalls).toBe(1);
  });

  it('throws OutputSchemaConversionError synchronously from createActiveRun() for an unrepresentable output schema (AB-18)', () => {
    // Covers a `createActiveRun` caller that bypasses `createAgent` (bureau,
    // sessions, durable routing) — the same synchronous guard applies here.
    expect(() =>
      createActiveRun({
        generate: async () => textResponse('{}'),
        toolbox: createTestToolbox([]),
        conversation: new Conversation(),
        stopWhen: noToolCalls(),
        output: z.date(),
      }),
    ).toThrow(OutputSchemaConversionError);
  });
});

describe('validateOutputValue — the recursive JSONValue contract on an already-decoded candidate', () => {
  const answerSchema = z.object({ answer: z.string() });

  it('accepts a plain JSONValue candidate that satisfies the schema', async () => {
    const result = await validateOutputValue(answerSchema, { answer: 'hi' });
    expect(result).toEqual({ success: true, value: { answer: 'hi' } });
  });

  it('rejects a cyclic object as NonJsonOutputError, before the schema is even consulted', async () => {
    const cyclic: Record<string, unknown> = { answer: 'hi' };
    cyclic['self'] = cyclic;

    const result = await validateOutputValue(answerSchema, cyclic);
    expect(result.success).toBe(false);
    expect(!result.success && result.error).toBeInstanceOf(NonJsonOutputError);
  });

  it('rejects a sparse array as NonJsonOutputError', async () => {
    // eslint-disable-next-line no-sparse-arrays
    const sparse = [1, , 3];
    const result = await validateOutputValue(z.array(z.number()), sparse);
    expect(result.success).toBe(false);
    expect(!result.success && result.error).toBeInstanceOf(NonJsonOutputError);
  });

  it('rejects a Date instance as NonJsonOutputError, even against a permissive z.unknown() schema', async () => {
    const result = await validateOutputValue(z.unknown(), new Date());
    expect(result.success).toBe(false);
    expect(!result.success && result.error).toBeInstanceOf(NonJsonOutputError);
  });

  it('accepts a null-prototype object', async () => {
    const nullProto = Object.assign(Object.create(null), { answer: 'hi' });
    const result = await validateOutputValue(answerSchema, nullProto);
    expect(result).toEqual({ success: true, value: { answer: 'hi' } });
  });

  it('reports a schema mismatch on a JSONValue-valid candidate as OutputValidationError, not NonJsonOutputError', async () => {
    const result = await validateOutputValue(answerSchema, { answer: 42 });
    expect(result.success).toBe(false);
    expect(!result.success && result.error).toBeInstanceOf(OutputValidationError);
  });
});
