import { describe, expect, it } from 'bun:test';
import type { ActiveRun } from 'operative';
import type { RunState } from 'sentinel';

import { serializeRunState } from './serialization';

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

    const summary = serializeRunState(runState);

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

    const summary = serializeRunState(runState);
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

    const summary = serializeRunState(runState);
    const json = JSON.stringify(summary);
    const parsed = JSON.parse(json);
    expect(parsed.id).toBe('run-3');
  });
});
