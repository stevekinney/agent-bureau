import { createTestToolbox } from 'armorer/test';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';
import type { StandardSchemaV1 } from 'interoperability';
import { z } from 'zod';

import { noToolCalls } from '../src/conditions/predicates';
import { createActiveRun } from '../src/create-run';
import { resolveResponseFormat } from '../src/structured-output/response-schema';
import { createRunRecorder } from '../src/test/index';
import type { GenerateResponse } from '../src/types';
const run = (options: Parameters<typeof createActiveRun>[0]) => createActiveRun(options).result;

/**
 * A minimal hand-rolled Standard Schema V1 validator (no vendor dependency
 * required — Valibot, ArkType, etc. all implement the same `~standard`
 * shape). Rejects a low `confidence`, mirroring a real business rule a Zod
 * schema alone couldn't express as cleanly, and returns a NEW object (not
 * the raw parsed JSON) so a passing test proves the validator's OUTPUT
 * reaches `structuredOutput`, not just the raw parsed JSON.
 */
function confidentAnswerSchema(): StandardSchemaV1<
  unknown,
  { answer: string; confidence: number }
> {
  return {
    '~standard': {
      version: 1,
      vendor: 'test',
      validate(value: unknown) {
        const candidate = value as { answer?: unknown; confidence?: unknown };
        if (typeof candidate?.answer !== 'string' || typeof candidate?.confidence !== 'number') {
          return { issues: [{ message: 'expected { answer: string, confidence: number }' }] };
        }
        if (candidate.confidence < 0.5) {
          return { issues: [{ message: 'confidence too low', path: [{ key: 'confidence' }] }] };
        }
        return { value: { answer: candidate.answer, confidence: candidate.confidence } };
      },
    },
  };
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

    const activeRun = createActiveRun({
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
      responseSchema: schema,
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

  it('does not add schemaValidation when responseSchema is not set', async () => {
    const result = await run({
      generate: async () => textResponse('hello'),
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
    });

    expect(result.schemaValidation).toBeUndefined();
  });

  it('puts the validated value on the distinct structuredOutput field for a Zod schema', async () => {
    const validJson = JSON.stringify({ answer: 'Hello', confidence: 0.95 });

    const result = await run({
      generate: async () => textResponse(validJson),
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      responseSchema: schema,
    });

    expect(result.structuredOutput).toEqual({ answer: 'Hello', confidence: 0.95 });
    // Distinct from `content` — the raw model text — not merely equal to it.
    expect(result.structuredOutput).not.toBe(result.content);
  });

  it('does not set structuredOutput when validation fails', async () => {
    const result = await run({
      generate: async () => textResponse('not valid json'),
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      responseSchema: schema,
      schemaRetries: 0,
    });

    expect(result.schemaValidation?.success).toBe(false);
    expect(result.structuredOutput).toBeUndefined();
  });
});

describe('structured output — non-Zod Standard Schema validator', () => {
  it('uses an explicit JSON Schema as the provider response format', () => {
    const responseJsonSchema = {
      type: 'object',
      required: ['answer'],
      properties: { answer: { type: 'string' } },
    };

    expect(resolveResponseFormat(confidentAnswerSchema(), responseJsonSchema)).toEqual({
      type: 'json_schema',
      schema: responseJsonSchema,
      name: 'response',
    });
  });

  it('validates via `~standard.validate` and surfaces its TRANSFORMED output as structuredOutput', async () => {
    const result = await run({
      generate: async () =>
        textResponse(JSON.stringify({ answer: 'Hi', confidence: 0.9, junk: 1 })),
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      responseSchema: confidentAnswerSchema(),
    });

    expect(result.finishReason).toBe('stop-condition');
    expect(result.schemaValidation?.success).toBe(true);
    // The validator's output strips `junk` — proves structuredOutput is the
    // VALIDATOR's value, not merely the raw JSON.parse of model content.
    expect(result.structuredOutput).toEqual({ answer: 'Hi', confidence: 0.9 });
  });

  it('rejects invalid output and drives the schemaRetries repair loop', async () => {
    let callCount = 0;
    const generate = async () => {
      callCount++;
      if (callCount === 1) {
        return textResponse(JSON.stringify({ answer: 'Unsure', confidence: 0.1 }));
      }
      return textResponse(JSON.stringify({ answer: 'Sure', confidence: 0.9 }));
    };

    const result = await run({
      generate,
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      responseSchema: confidentAnswerSchema(),
      schemaRetries: 1,
    });

    expect(result.schemaValidation?.success).toBe(true);
    expect(callCount).toBe(2);
    expect(result.structuredOutput).toEqual({ answer: 'Sure', confidence: 0.9 });
  });

  it('NEUTER CHECK: a validator that always rejects never produces structuredOutput, even with retries', async () => {
    // Confirms the previous test's success is driven by the validator's real
    // pass/fail logic, not by the retry loop unconditionally succeeding.
    const alwaysRejects: StandardSchemaV1<unknown, never> = {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: () => ({ issues: [{ message: 'always rejects' }] }),
      },
    };

    const result = await run({
      generate: async () => textResponse(JSON.stringify({ answer: 'x', confidence: 1 })),
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      responseSchema: alwaysRejects,
      schemaRetries: 1,
    });

    expect(result.schemaValidation?.success).toBe(false);
    expect(result.structuredOutput).toBeUndefined();
  });
});

describe('structured output — raw JSON Schema responseSchema (AB-95)', () => {
  const findingsJsonSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['findings'],
    properties: {
      findings: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['path', 'startLine', 'endLine', 'side', 'severity', 'title', 'body'],
          properties: {
            path: { type: 'string' },
            startLine: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }] },
            endLine: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }] },
            side: { enum: ['LEFT', 'RIGHT'] },
            severity: { enum: ['info', 'warning', 'error'] },
            title: { type: 'string' },
            body: { type: 'string' },
            suggestion: { type: 'string' },
          },
        },
      },
    },
  };

  it('validates a valid response and surfaces the parsed value as structuredOutput', async () => {
    const finding = {
      path: 'a.ts',
      startLine: 1,
      endLine: 2,
      side: 'LEFT',
      severity: 'warning',
      title: 'nit',
      body: 'consider renaming',
    };

    const result = await run({
      generate: async () => textResponse(JSON.stringify({ findings: [finding] })),
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      responseSchema: findingsJsonSchema,
    });

    expect(result.finishReason).toBe('stop-condition');
    expect(result.schemaValidation?.success).toBe(true);
    expect(result.structuredOutput).toEqual({ findings: [finding] });
  });

  it('rejects a response with a bad enum value and drives the schemaRetries repair loop', async () => {
    let callCount = 0;
    const badFinding = {
      path: 'a.ts',
      startLine: 1,
      endLine: 2,
      side: 'WRONG_SIDE',
      severity: 'warning',
      title: 'nit',
      body: 'x',
    };
    const goodFinding = { ...badFinding, side: 'RIGHT' };

    const generate = async () => {
      callCount++;
      if (callCount === 1) return textResponse(JSON.stringify({ findings: [badFinding] }));
      return textResponse(JSON.stringify({ findings: [goodFinding] }));
    };

    const result = await run({
      generate,
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      responseSchema: findingsJsonSchema,
      schemaRetries: 1,
    });

    expect(result.schemaValidation?.success).toBe(true);
    expect(callCount).toBe(2);
    expect(result.structuredOutput).toEqual({ findings: [goodFinding] });
  });

  it('NEUTER CHECK: exhausts retries and reports failure when every response is invalid', async () => {
    let callCount = 0;
    const generate = async () => {
      callCount++;
      return textResponse(JSON.stringify({ findings: 'not-an-array' }));
    };

    const result = await run({
      generate,
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      responseSchema: findingsJsonSchema,
      schemaRetries: 1,
      maximumSteps: 5,
    });

    expect(result.schemaValidation?.success).toBe(false);
    expect(result.structuredOutput).toBeUndefined();
    // 1 original + 1 retry = 2 calls
    expect(callCount).toBe(2);
  });

  // Fixtures copied verbatim from `outputSchemaForRole` in
  // /Users/stevekinney/Developer/tribunal/runner/run-agent.mjs (readable at
  // implementation time) — Tribunal's three PR-review role schemas
  // (specialist/findings, triage, verifier), used exactly as sent to a
  // provider today (`outputFormat: { type: 'json_schema', schema:
  // outputSchemaForRole(role) }`).
  describe('round-trip: Tribunal role schemas', () => {
    const triageJsonSchema = {
      type: 'object',
      additionalProperties: false,
      required: ['skip', 'reason', 'riskFlags'],
      properties: {
        skip: { type: 'boolean' },
        reason: { type: 'string' },
        riskFlags: { type: 'array', items: { type: 'string' } },
      },
    };

    const verifierJsonSchema = {
      type: 'object',
      additionalProperties: false,
      required: ['verified', 'note'],
      properties: {
        verified: { type: 'boolean' },
        note: { type: 'string' },
      },
    };

    it('round-trips a valid triage-skip response', async () => {
      const decision = { skip: true, reason: 'docs-only change', riskFlags: [] };
      const result = await run({
        generate: async () => textResponse(JSON.stringify(decision)),
        toolbox: createTestToolbox([]),
        conversation: new Conversation(),
        stopWhen: noToolCalls(),
        responseSchema: triageJsonSchema,
      });

      expect(result.schemaValidation?.success).toBe(true);
      expect(result.structuredOutput).toEqual(decision);
    });

    it('round-trips a valid verifier-verdict response', async () => {
      const verdict = { verified: false, note: 'reproduced the failure scenario' };
      const result = await run({
        generate: async () => textResponse(JSON.stringify(verdict)),
        toolbox: createTestToolbox([]),
        conversation: new Conversation(),
        stopWhen: noToolCalls(),
        responseSchema: verifierJsonSchema,
      });

      expect(result.schemaValidation?.success).toBe(true);
      expect(result.structuredOutput).toEqual(verdict);
    });

    it('round-trips a valid specialist findings response', async () => {
      const findings = {
        findings: [
          {
            path: 'src/index.ts',
            startLine: 10,
            endLine: null,
            side: 'RIGHT',
            severity: 'error',
            title: 'Off-by-one',
            body: 'Loop bound should be `<=`.',
            suggestion: 'Use `<=` instead of `<`.',
          },
        ],
      };
      const result = await run({
        generate: async () => textResponse(JSON.stringify(findings)),
        toolbox: createTestToolbox([]),
        conversation: new Conversation(),
        stopWhen: noToolCalls(),
        responseSchema: findingsJsonSchema,
      });

      expect(result.schemaValidation?.success).toBe(true);
      expect(result.structuredOutput).toEqual(findings);
    });

    it('rejects a triage response with an extra property (additionalProperties: false)', async () => {
      const result = await run({
        generate: async () =>
          textResponse(JSON.stringify({ skip: true, reason: 'x', riskFlags: [], extra: 1 })),
        toolbox: createTestToolbox([]),
        conversation: new Conversation(),
        stopWhen: noToolCalls(),
        responseSchema: triageJsonSchema,
        schemaRetries: 0,
      });

      expect(result.schemaValidation?.success).toBe(false);
      expect(result.structuredOutput).toBeUndefined();
    });
  });
});
