import { describe, expect, it } from 'bun:test';
import type { ActiveRun } from 'operative';
import type { RunState } from 'operative/store';

import {
  serializeActionDetail,
  serializeRunDetail,
  serializeRunState,
  serializeUnknownError,
} from './serialization';

describe('serializeRunState', () => {
  it('maps RunState to a JSON-safe RunSummary', () => {
    const runState: RunState = {
      id: 'run-1',
      status: 'completed',
      steps: [{ step: 1 } as never, { step: 2 } as never],
      usage: { prompt: 100, completion: 50, total: 150 },
      finishReason: 'stop-condition',
      error: undefined,
      snapshots: [],
      actions: [
        { sequence: 0, runId: 'run-1', type: 'run.started', detail: {}, timestamp: 1 },
        { sequence: 1, runId: 'run-1', type: 'run.completed', detail: {}, timestamp: 2 },
      ],
      activeRun: {} as ActiveRun,
    };

    const summary = serializeRunState(runState, '');

    expect(summary.id).toBe('run-1');
    expect(summary.status).toBe('completed');
    expect(summary.steps).toBe(2);
    expect(summary.usage).toEqual({ prompt: 100, completion: 50, total: 150 });
    expect(summary.finishReason).toBe('stop-condition');
    expect(summary.error).toBeUndefined();
    expect(summary.actionCount).toBe(2);
  });

  it('serializes errors to strings', () => {
    const runState: RunState = {
      id: 'run-2',
      status: 'error',
      steps: [],
      usage: { prompt: 0, completion: 0, total: 0 },
      finishReason: 'error',
      error: new Error('Something broke'),
      snapshots: [],
      actions: [],
      activeRun: {} as ActiveRun,
    };

    const summary = serializeRunState(runState, '');
    expect(summary.error).toBe('Something broke');
  });

  it('produces JSON-serializable output', () => {
    const runState: RunState = {
      id: 'run-3',
      status: 'running',
      steps: [],
      usage: { prompt: 10, completion: 5, total: 15 },
      finishReason: undefined,
      error: undefined,
      snapshots: [],
      actions: [],
      activeRun: {} as ActiveRun,
    };

    const summary = serializeRunState(runState, '');
    const json = JSON.stringify(summary);
    const parsed = JSON.parse(json);
    expect(parsed.id).toBe('run-3');
  });

  it('does not double-quote string errors', () => {
    const runState: RunState = {
      id: 'run-4',
      status: 'error',
      steps: [],
      usage: { prompt: 0, completion: 0, total: 0 },
      finishReason: 'error',
      error: 'Connection timeout',
      snapshots: [],
      actions: [],
      activeRun: {} as ActiveRun,
    };

    const summary = serializeRunState(runState, '');
    expect(summary.error).toBe('Connection timeout');
  });
});

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

    const result = serializeActionDetail('step.completed', detail) as Record<string, unknown>;
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

    const result = serializeActionDetail('step.completed', detail) as Record<string, unknown>;
    expect(result).not.toHaveProperty('conversation');
    expect(result['completedAt']).toBe('2026-03-31T21:15:48.000Z');
    expect(result['values']).toEqual(['gateway', 'live']);
    expect(result['stats']).toEqual([['attempts', '2']]);
    expect(() => JSON.stringify(result)).not.toThrow();
  });

  it('strips conversation from run.completed details', () => {
    const detail = {
      conversation: { snapshot: () => ({}) },
      steps: [],
      content: 'done',
      usage: { prompt: 1, completion: 2, total: 3 },
      finishReason: 'stop-condition',
    };

    const result = serializeActionDetail('run.completed', detail) as Record<string, unknown>;
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

    const result = serializeActionDetail('run.completed', detail) as Record<string, unknown>;
    expect(result).not.toHaveProperty('conversation');

    const steps = result['steps'] as Record<string, unknown>[];
    expect(steps).toHaveLength(2);
    for (const step of steps) {
      expect(step).not.toHaveProperty('conversation');
    }
    expect(steps[0]!['content']).toBe('a');
    expect(steps[1]!['content']).toBe('b');
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

    const result = serializeActionDetail('run.completed', detail) as Record<string, unknown>;
    expect(result).not.toHaveProperty('conversation');
    expect(result['finishedAt']).toBe('2026-03-31T21:15:48.000Z');
    expect(result['totalCost']).toBe('42');

    const steps = result['steps'] as Record<string, unknown>[];
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

  it('passes through other event types unchanged', () => {
    const detail = { some: 'data' };
    const result = serializeActionDetail('run.started', detail);
    expect(result).toEqual(detail);
  });

  it('passes through primitives unchanged', () => {
    expect(serializeActionDetail('run.error', 'oops')).toBe('oops');
    expect(serializeActionDetail('run.error', null)).toBeNull();
    expect(serializeActionDetail('run.error', 42)).toBe(42);
  });

  it('serializes Error instances in run.error details to their message', () => {
    const detail = { step: 3, error: new Error('Connection refused') };
    const result = serializeActionDetail('run.error', detail) as Record<string, unknown>;
    expect(result['step']).toBe(3);
    expect(result['error']).toBe('Connection refused');
  });

  it('preserves string errors in run.error details', () => {
    const detail = { step: 1, error: 'something went wrong' };
    const result = serializeActionDetail('run.error', detail) as Record<string, unknown>;
    expect(result['step']).toBe(1);
    expect(result['error']).toBe('something went wrong');
  });

  it('serializes non-string non-Error errors in run.error details', () => {
    const detail = { step: 2, error: { code: 'TIMEOUT', retryable: true } };
    const result = serializeActionDetail('run.error', detail) as Record<string, unknown>;
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
    const result = serializeActionDetail('generate.error', detail) as Record<string, unknown>;
    expect(result['error']).toBe('Rate limited');
    expect(result['durationMilliseconds']).toBe(150);
  });

  it('serializes Error instances in generate.retry details', () => {
    const detail = { step: 2, attempt: 3, error: new Error('Timeout') };
    const result = serializeActionDetail('generate.retry', detail) as Record<string, unknown>;
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

    const result = serializeActionDetail('run.started', detail) as Record<string, unknown>;
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

    const result = serializeActionDetail('run.started', detail) as Record<string, unknown>;
    expect(result['first']).toEqual({ prompt: 10, completion: 5, total: 15 });
    expect(result['second']).toEqual({ prompt: 10, completion: 5, total: 15 });
  });
});

describe('serializeRunDetail', () => {
  it('keeps non-plain tool result values JSON-safe without dropping their contents', () => {
    const runState: RunState = {
      id: 'run-5',
      status: 'completed',
      steps: [
        {
          step: 1,
          content: 'done',
          final: true,
          usage: { prompt: 1, completion: 1, total: 2 },
          toolCalls: [
            {
              id: 'tool-call-1',
              name: 'inspect',
              arguments: {
                createdAt: new Date('2026-03-31T21:15:48.000Z'),
              },
            },
          ],
          results: [
            {
              toolName: 'inspect',
              result: {
                tags: new Set(['one', 'two']),
                values: new Map([['count', 2]]),
              },
              error: undefined,
              errorMessage: undefined,
            },
          ],
        } as never,
      ],
      usage: { prompt: 1, completion: 1, total: 2 },
      finishReason: 'stop-condition',
      error: undefined,
      snapshots: [],
      actions: [],
      activeRun: {} as ActiveRun,
    };

    const detail = serializeRunDetail(runState, 'session-1');
    expect(detail.stepDetails[0]?.toolCalls[0]?.arguments).toEqual({
      createdAt: '2026-03-31T21:15:48.000Z',
    });
    expect(detail.stepDetails[0]?.results[0]?.result).toEqual({
      tags: ['one', 'two'],
      values: [['count', 2]],
    });
  });
});

describe('serializeUnknownError', () => {
  it('serializes circular objects without throwing', () => {
    const error: Record<string, unknown> = {};
    error['self'] = error;

    expect(serializeUnknownError(error)).toBe('{"self":"[Circular]"}');
  });

  it('serializes bigint-containing objects without throwing', () => {
    expect(serializeUnknownError({ value: 42n })).toBe('{"value":"42"}');
  });

  it('serializes repeated non-circular references without dropping later values', () => {
    const shared = { attempts: 2, ok: true };

    expect(serializeUnknownError({ first: shared, second: shared })).toBe(
      '{"first":{"attempts":2,"ok":true},"second":{"attempts":2,"ok":true}}',
    );
  });
});
