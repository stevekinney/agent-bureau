import { describe, expect, it } from 'bun:test';
import {
  appendAssistantMessage,
  appendToolCall,
  appendToolResult,
  appendUserMessage,
  type ConversationHistory,
  createConversationHistory,
} from 'conversationalist';

import type { CostEstimate } from '../src/cost-estimation';
import {
  buildRunReport,
  createAssistantChunkFrame,
  createAssistantFinalFrame,
  createNotificationFrame,
  createRunFinishedFrame,
  createRunStartedFrame,
  createStepFrame,
  createToolPostFrame,
  createToolPreFrame,
  mapFinishReasonToStatus,
  RUN_ENVELOPE_SCHEMA_VERSION,
  runFrameSchema,
  runReportSchema,
  stringifyError,
  summarizeToolInput,
} from '../src/run-envelope';

function roundTrip<T>(value: T): unknown {
  return JSON.parse(JSON.stringify(value));
}

describe('summarizeToolInput', () => {
  it('redacts keys that look sensitive', () => {
    const summary = summarizeToolInput({ apiKey: 'sk-live-123', username: 'ada' });
    expect(summary).toEqual({ apiKey: '[redacted]', username: 'ada' });
  });

  it('truncates strings past the configured max length', () => {
    const summary = summarizeToolInput('x'.repeat(20), { maxStringLength: 5 });
    expect(summary).toBe('xxxxx…(15 more chars)');
  });

  it('truncates arrays past the configured max item count', () => {
    const summary = summarizeToolInput([1, 2, 3, 4, 5], { maxArrayItems: 2 });
    expect(summary).toEqual([1, 2, '…(3 more items)']);
  });

  it('truncates deeply nested values past maxDepth', () => {
    const summary = summarizeToolInput({ a: { b: { c: { d: 'too deep' } } } }, { maxDepth: 2 });
    expect(summary).toEqual({ a: { b: '[truncated]' } });
  });

  it('produces a JSON-safe value for a value with functions and errors', () => {
    const summary = summarizeToolInput({
      callback: () => undefined,
      failure: new Error('boom'),
    });
    expect(() => JSON.stringify(summary)).not.toThrow();
    const parsed = JSON.parse(JSON.stringify(summary)) as Record<string, unknown>;
    expect(parsed['failure']).toBe('boom');
    expect(typeof parsed['callback']).toBe('string');
  });

  it('summarizes invalid dates and truncates oversized objects', () => {
    expect(summarizeToolInput(new Date(Number.NaN))).toBe('Invalid Date');
    expect(summarizeToolInput({ a: 1, b: 2, c: 3 }, { maxObjectKeys: 2 })).toEqual({
      a: 1,
      b: 2,
      '…': '(1 more keys)',
    });
  });
});

describe('stringifyError', () => {
  it('normalizes string, null, serializable, and circular non-Error values', () => {
    expect(stringifyError('plain failure')).toBe('plain failure');
    expect(stringifyError(null)).toBe('null');
    expect(stringifyError({ code: 'FAILED' })).toBe('{"code":"FAILED"}');
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    expect(stringifyError(circular)).toBe('[unserializable error]');
  });
});

describe('mapFinishReasonToStatus', () => {
  it('maps stop-condition and maximum-steps to succeeded', () => {
    expect(mapFinishReasonToStatus('stop-condition')).toBe('succeeded');
    expect(mapFinishReasonToStatus('maximum-steps')).toBe('succeeded');
  });

  it('maps aborted to aborted', () => {
    expect(mapFinishReasonToStatus('aborted')).toBe('aborted');
  });

  it('maps budget-exceeded to budget_stopped', () => {
    expect(mapFinishReasonToStatus('budget-exceeded')).toBe('budget_stopped');
  });

  it('maps error and elicitation-denied to failed', () => {
    expect(mapFinishReasonToStatus('error')).toBe('failed');
    expect(mapFinishReasonToStatus('elicitation-denied')).toBe('failed');
  });
});

describe('buildRunReport', () => {
  const usage = { prompt: 10, completion: 5, total: 15 };
  const costEstimate: CostEstimate = {
    promptCost: 0.01,
    completionCost: 0.02,
    cacheWriteCost: 0,
    cacheReadCost: 0,
    totalCost: 0.03,
    model: 'claude-sonnet-5',
    usage,
  };

  function sampleTranscript(): ConversationHistory {
    let conversation = createConversationHistory();
    conversation = appendUserMessage(conversation, 'What is 2 + 2?');
    conversation = appendAssistantMessage(conversation, '', {});
    conversation = appendToolCall(conversation, {
      id: 'call-1',
      name: 'add',
      arguments: { a: 2, b: 2 },
    });
    conversation = appendToolResult(conversation, {
      callId: 'call-1',
      outcome: 'success',
      content: 4,
    });
    return conversation;
  }

  it('builds a succeeded report for every terminal field', () => {
    const report = buildRunReport({
      runId: 'run-1',
      status: 'succeeded',
      finishReason: 'stop-condition',
      usage,
      costEstimate,
      effectiveModel: 'claude-sonnet-5',
      effectiveEffort: 'medium',
      structuredOutput: { answer: 4 },
      transcript: sampleTranscript(),
    });

    expect(report.schemaVersion).toBe(RUN_ENVELOPE_SCHEMA_VERSION);
    expect(report.status).toBe('succeeded');
    expect(report.usage).toEqual(usage);
    expect(report.costEstimate).toEqual(costEstimate);
    expect(report.effectiveModel).toBe('claude-sonnet-5');
    expect(report.effectiveEffort).toBe('medium');
    expect(report.structuredOutput).toEqual({ answer: 4 });
    expect(report.error).toBeUndefined();
    expect(report.transcript?.ids.length).toBeGreaterThan(0);

    const parsed = runReportSchema.parse(report);
    expect(parsed.status).toBe('succeeded');
  });

  it('stringifies an Error into the error field', () => {
    const report = buildRunReport({
      runId: 'run-2',
      status: 'failed',
      usage,
      error: new Error('provider timed out'),
    });
    expect(report.error).toBe('provider timed out');
  });

  it('drops a structuredOutput value that cannot round-trip through JSON', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    const report = buildRunReport({
      runId: 'run-3',
      status: 'succeeded',
      usage,
      structuredOutput: circular,
    });
    expect(report.structuredOutput).toBeUndefined();
  });

  it('preserves tool-call/tool-result pair integrity in a partial transcript', () => {
    const transcript = sampleTranscript();
    const report = buildRunReport({
      runId: 'run-4',
      status: 'aborted',
      usage,
      transcript,
    });

    const toolCallMessage = Object.values(report.transcript!.messages).find((m) => m.toolCall);
    const toolResultMessage = Object.values(report.transcript!.messages).find((m) => m.toolResult);
    expect(toolCallMessage?.toolCall?.id).toBe('call-1');
    expect(toolResultMessage?.toolResult?.callId).toBe('call-1');
  });

  it('round-trips every field through JSON.parse(JSON.stringify(x))', () => {
    const report = buildRunReport({
      runId: 'run-5',
      status: 'budget_stopped',
      finishReason: 'budget-exceeded',
      usage,
      costEstimate,
      transcript: sampleTranscript(),
    });
    const roundTripped = roundTrip(report);
    expect(roundTripped).toEqual(JSON.parse(JSON.stringify(report)));
    expect(() => runReportSchema.parse(roundTripped)).not.toThrow();
  });
});

describe('RunFrame constructors', () => {
  const clock = () => 1_700_000_000_000;

  it('every frame variant round-trips JSON.parse(JSON.stringify(x)) and validates', () => {
    const frames = [
      createRunStartedFrame({ runId: 'run-1', sessionId: 'session-1', agentName: 'bureau' }, clock),
      createStepFrame(
        {
          runId: 'run-1',
          step: 0,
          phase: 'completed',
          usage: { prompt: 1, completion: 1, total: 2 },
        },
        clock,
      ),
      createAssistantChunkFrame({ runId: 'run-1', step: 0, delta: 'Hi', accumulated: 'Hi' }, clock),
      createAssistantFinalFrame({ runId: 'run-1', step: 0, content: 'Hi there' }, clock),
      createToolPreFrame(
        {
          runId: 'run-1',
          step: 0,
          toolCallId: 'call-1',
          toolName: 'add',
          params: { apiKey: 'secret', a: 1 },
        },
        clock,
      ),
      createToolPostFrame(
        {
          runId: 'run-1',
          step: 0,
          toolCallId: 'call-1',
          toolName: 'add',
          status: 'success',
          durationMs: 12,
          result: { total: 4 },
        },
        clock,
      ),
      createNotificationFrame(
        {
          runId: 'run-1',
          step: 0,
          level: 'warning',
          code: 'budget.threshold',
          message: 'Approaching budget',
        },
        clock,
      ),
      createRunFinishedFrame(
        {
          runId: 'run-1',
          report: buildRunReport({
            runId: 'run-1',
            status: 'succeeded',
            usage: { prompt: 1, completion: 1, total: 2 },
          }),
        },
        clock,
      ),
    ];

    for (const frame of frames) {
      expect(frame.schemaVersion).toBe(RUN_ENVELOPE_SCHEMA_VERSION);
      const roundTripped = roundTrip(frame);
      expect(roundTripped).toEqual(JSON.parse(JSON.stringify(frame)));
      expect(() => runFrameSchema.parse(roundTripped)).not.toThrow();
    }
  });

  it('redacts a sensitive tool input on the tool-pre frame', () => {
    const frame = createToolPreFrame(
      {
        runId: 'run-1',
        step: 0,
        toolCallId: 'call-1',
        toolName: 'add',
        params: { apiKey: 'sk-secret' },
      },
      clock,
    );
    expect(frame.inputSummary).toEqual({ apiKey: '[redacted]' });
  });

  it('stringifies a tool error on the tool-post frame', () => {
    const frame = createToolPostFrame(
      {
        runId: 'run-1',
        step: 0,
        toolCallId: 'call-1',
        toolName: 'add',
        status: 'error',
        error: new Error('tool exploded'),
      },
      clock,
    );
    expect(frame.error).toBe('tool exploded');
  });
});
