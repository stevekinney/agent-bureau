import type { RunState } from '@lostgradient/operative';
import { describe, expect, it } from 'bun:test';
import { serializeRunDetail, serializeRunState } from './serialization';
import {
  makeNonJsonToolCall,
  makeStep,
  stubActiveRunWithSnapshot,
} from './serialization-test-helpers';

describe('serializeRunState', () => {
  it('maps RunState to a JSON-safe RunSummary', () => {
    const runState: RunState = {
      id: 'run-1',
      status: 'completed',
      steps: [makeStep(1), makeStep(2)],
      usage: { prompt: 100, completion: 50, total: 150 },
      finishReason: 'stop-condition',
      error: undefined,
      snapshots: [],
      actions: [
        { sequence: 0, runId: 'run-1', type: 'run.started', detail: {}, timestamp: 1 },
        { sequence: 1, runId: 'run-1', type: 'run.completed', detail: {}, timestamp: 2 },
      ],
      activeRun: stubActiveRunWithSnapshot(),
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
      activeRun: stubActiveRunWithSnapshot(),
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
      activeRun: stubActiveRunWithSnapshot(),
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
      activeRun: stubActiveRunWithSnapshot(),
    };

    const summary = serializeRunState(runState, '');
    expect(summary.error).toBe('Connection timeout');
  });
});

describe('serializeRunDetail', () => {
  it('keeps non-plain tool result values JSON-safe without dropping their contents', () => {
    const runState: RunState = {
      id: 'run-5',
      status: 'completed',
      steps: [
        {
          ...makeStep(1),
          step: 1,
          content: 'done',
          final: true,
          usage: { prompt: 1, completion: 1, total: 2 },
          toolCalls: [makeNonJsonToolCall()],
          results: [
            {
              callId: 'tool-call-1',
              toolCallId: 'tool-call-1',
              outcome: 'success',
              content: null,
              toolName: 'inspect',
              result: {
                tags: new Set(['one', 'two']),
                values: new Map([['count', 2]]),
              },
            },
          ],
        },
      ],
      usage: { prompt: 1, completion: 1, total: 2 },
      finishReason: 'stop-condition',
      error: undefined,
      snapshots: [],
      actions: [],
      activeRun: stubActiveRunWithSnapshot(),
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
