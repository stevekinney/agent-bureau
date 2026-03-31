import { describe, expect, it } from 'bun:test';
import type { ActiveRun } from 'operative';
import type { RunState } from 'sentinel';

import { serializeActionDetail, serializeRunState } from './serialization';

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
});
