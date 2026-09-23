import { AbortAgentRunError } from '@lostgradient/operative';
import { describe, expect, it } from 'bun:test';
import { serializeActionDetail } from './serialization';
import { requireRecord, requireRecords, requireString } from './serialization-test-helpers';

describe('serializeActionDetail', () => {
  it('strips conversation from step.completed details', () => {
    const detail = {
      step: 1,
      conversation: { snapshot: () => ({}) },
      content: 'hello',
      toolCalls: [],
      results: [],
      final: false,
    };

    const result = requireRecord(serializeActionDetail('step.completed', detail));
    expect(result).not.toHaveProperty('conversation');
    expect(result['content']).toBe('hello');
    expect(result['step']).toBe(1);
  });

  it('keeps step.completed details JSON-safe after stripping conversation', () => {
    const detail = {
      step: 1,
      conversation: { snapshot: () => ({}) },
      completedAt: new Date('2026-03-31T21:15:48.000Z'),
      values: new Set(['gateway', 'live']),
      stats: new Map([['attempts', 2n]]),
      final: false,
    };

    const result = requireRecord(serializeActionDetail('step.completed', detail));
    expect(result).not.toHaveProperty('conversation');
    expect(result['completedAt']).toBe('2026-03-31T21:15:48.000Z');
    expect(result['values']).toEqual(['gateway', 'live']);
    expect(result['stats']).toEqual([['attempts', '2']]);
    expect(() => JSON.stringify(result)).not.toThrow();
  });

  it('strips conversation from run.aborted details', () => {
    const detail = {
      step: 2,
      conversation: { snapshot: () => ({}) },
      reason: 'cancelled',
      error: new AbortAgentRunError('cancelled'),
    };

    const result = requireRecord(serializeActionDetail('run.aborted', detail));
    expect(result).not.toHaveProperty('conversation');
    expect(result['step']).toBe(2);
    expect(result['reason']).toBe('cancelled');
    expect(JSON.parse(requireString(result['error']))).toMatchObject({
      name: 'AbortAgentRunError',
      message: 'cancelled',
      kind: 'abort',
      code: 'ABORTED',
    });
  });

  it('strips conversation from run.completed details', () => {
    const detail = {
      conversation: { snapshot: () => ({}) },
      steps: [],
      content: 'done',
      usage: { prompt: 1, completion: 2, total: 3 },
      finishReason: 'stop-condition',
    };

    const result = requireRecord(serializeActionDetail('run.completed', detail));
    expect(result).not.toHaveProperty('conversation');
    expect(result['content']).toBe('done');
    expect(result['finishReason']).toBe('stop-condition');
  });

  it('strips nested conversation from each step inside run.completed details', () => {
    const detail = {
      conversation: { snapshot: () => ({}) },
      steps: [
        {
          step: 1,
          conversation: { snapshot: () => ({}) },
          content: 'a',
          toolCalls: [],
          results: [],
          final: false,
        },
        {
          step: 2,
          conversation: { snapshot: () => ({}) },
          content: 'b',
          toolCalls: [],
          results: [],
          final: true,
        },
      ],
      content: 'done',
      usage: { prompt: 10, completion: 20, total: 30 },
      finishReason: 'stop-condition',
    };

    const result = requireRecord(serializeActionDetail('run.completed', detail));
    expect(result).not.toHaveProperty('conversation');

    const steps = requireRecords(result['steps']);
    expect(steps).toHaveLength(2);
    for (const step of steps) {
      expect(step).not.toHaveProperty('conversation');
    }
    expect(steps[0]!['content']).toBe('a');
    expect(steps[1]!['content']).toBe('b');
  });

  it('projects nested run.completed result without conversation graphs', () => {
    const detail = {
      conversation: { snapshot: () => ({}) },
      result: {
        conversation: { snapshot: () => ({}) },
        steps: [
          {
            step: 1,
            conversation: { snapshot: () => ({}) },
            content: 'nested',
            toolCalls: [],
            results: [],
            final: true,
          },
        ],
        content: 'done',
        usage: { prompt: 1, completion: 2, total: 3 },
        finishReason: 'stop-condition',
      },
      steps: [],
      content: 'done',
      usage: { prompt: 1, completion: 2, total: 3 },
      finishReason: 'stop-condition',
    };

    const result = requireRecord(serializeActionDetail('run.completed', detail));
    const nestedResult = requireRecord(result['result']);
    const nestedSteps = requireRecords(nestedResult['steps']);

    expect(nestedResult).not.toHaveProperty('conversation');
    expect(nestedSteps[0]).not.toHaveProperty('conversation');
    expect(nestedResult['content']).toBe('done');
  });

  it('keeps run.completed details JSON-safe after stripping conversations', () => {
    const detail = {
      conversation: { snapshot: () => ({}) },
      finishedAt: new Date('2026-03-31T21:15:48.000Z'),
      usage: { prompt: 1, completion: 2, total: 3 },
      totalCost: 42n,
      steps: [
        {
          step: 1,
          conversation: { snapshot: () => ({}) },
          content: 'done',
          toolCalls: [
            {
              name: 'inspect',
              metadata: new Map([['labels', new Set(['gateway'])]]),
            },
          ],
          results: [
            {
              value: new Set(['ok']),
            },
          ],
          final: true,
        },
      ],
    };

    const result = requireRecord(serializeActionDetail('run.completed', detail));
    expect(result).not.toHaveProperty('conversation');
    expect(result['finishedAt']).toBe('2026-03-31T21:15:48.000Z');
    expect(result['totalCost']).toBe('42');

    const steps = requireRecords(result['steps']);
    expect(steps[0]).not.toHaveProperty('conversation');
    expect(steps[0]?.['toolCalls']).toEqual([
      {
        name: 'inspect',
        metadata: [['labels', ['gateway']]],
      },
    ]);
    expect(steps[0]?.['results']).toEqual([{ value: ['ok'] }]);
    expect(() => JSON.stringify(result)).not.toThrow();
  });

  it('strips conversation from run.completed details even when steps is not an array (e.g. an abrupt run.completed with no steps field)', () => {
    const detail = {
      conversation: { snapshot: () => ({}) },
      content: 'done',
      finishReason: 'error',
    };

    const result = requireRecord(serializeActionDetail('run.completed', detail));
    expect(result).not.toHaveProperty('conversation');
    expect(result['content']).toBe('done');
    expect(result['finishReason']).toBe('error');
  });

  it('passes through other event types unchanged', () => {
    const detail = { some: 'data' };
    const result = serializeActionDetail('run.started', detail);
    expect(result).toEqual(detail);
  });

  it('serializes nested ordinary errors in other event details', () => {
    expect(
      serializeActionDetail('custom.event', {
        nested: { error: new Error('nested failure') },
      }),
    ).toEqual({ nested: { error: 'nested failure' } });
  });

  it('passes through primitives unchanged', () => {
    expect(serializeActionDetail('run.error', 'oops')).toBe('oops');
    expect(serializeActionDetail('run.error', null)).toBeNull();
    expect(serializeActionDetail('run.error', 42)).toBe(42);
  });

  it('serializes Error instances in run.error details to their message', () => {
    const detail = { step: 3, error: new Error('Connection refused') };
    const result = requireRecord(serializeActionDetail('run.error', detail));
    expect(result['step']).toBe(3);
    expect(result['error']).toBe('Connection refused');
  });

  it('preserves string errors in run.error details', () => {
    const detail = { step: 1, error: 'something went wrong' };
    const result = requireRecord(serializeActionDetail('run.error', detail));
    expect(result['step']).toBe(1);
    expect(result['error']).toBe('something went wrong');
  });

  it('serializes non-string non-Error errors in run.error details', () => {
    const detail = { step: 2, error: { code: 'TIMEOUT', retryable: true } };
    const result = requireRecord(serializeActionDetail('run.error', detail));
    expect(result['step']).toBe(2);
    expect(result['error']).toBe('{"code":"TIMEOUT","retryable":true}');
  });

  it('produces valid JSON for run.error with Error instances', () => {
    const detail = { step: 5, error: new Error('Boom') };
    const serialized = serializeActionDetail('run.error', detail);
    const json = JSON.stringify(serialized);
    const parsed = JSON.parse(json);
    expect(parsed.error).toBe('Boom');
    expect(parsed.step).toBe(5);
  });

  it('serializes Error instances in generate.error details', () => {
    const detail = { step: 1, error: new Error('Rate limited'), durationMilliseconds: 150 };
    const result = requireRecord(serializeActionDetail('generate.error', detail));
    expect(result['error']).toBe('Rate limited');
    expect(result['durationMilliseconds']).toBe(150);
  });

  it('serializes Error instances in generate.retry details', () => {
    const detail = { step: 2, attempt: 3, error: new Error('Timeout') };
    const result = requireRecord(serializeActionDetail('generate.retry', detail));
    expect(result['error']).toBe('Timeout');
    expect(result['attempt']).toBe(3);
  });

  it('preserves dates, maps, and sets in serialized detail payloads', () => {
    const detail = {
      createdAt: new Date('2026-03-31T21:15:48.000Z'),
      labels: new Set(['gateway', 'live']),
      metadata: new Map<unknown, unknown>([
        ['attempt', 2],
        ['nested', new Map([['ok', true]])],
      ]),
    };

    const result = requireRecord(serializeActionDetail('run.started', detail));
    expect(result['createdAt']).toBe('2026-03-31T21:15:48.000Z');
    expect(result['labels']).toEqual(['gateway', 'live']);
    expect(result['metadata']).toEqual([
      ['attempt', 2],
      ['nested', [['ok', true]]],
    ]);
  });

  it('preserves shared object values that are not circular', () => {
    const sharedUsage = { prompt: 10, completion: 5, total: 15 };
    const detail = {
      first: sharedUsage,
      second: sharedUsage,
    };

    const result = requireRecord(serializeActionDetail('run.started', detail));
    expect(result['first']).toEqual({ prompt: 10, completion: 5, total: 15 });
    expect(result['second']).toEqual({ prompt: 10, completion: 5, total: 15 });
  });
});
