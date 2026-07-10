import { afterEach, describe, expect, it, mock } from 'bun:test';

import type { RunSummary, ServerFrame } from '../../types';
import { createRunsStore } from './use-runs.svelte.ts';

function makeRun(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    id: 'run-1',
    sessionId: 'session-1',
    status: 'running',
    steps: 0,
    usage: { prompt: 0, completion: 0, total: 0 },
    finishReason: undefined,
    error: undefined,
    actionCount: 0,
    agentName: 'bureau',
    principal: undefined,
    startedAt: 0,
    ...overrides,
  };
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('createRunsStore', () => {
  it('seeds runs from the initial value and exposes them reactively', () => {
    const store = createRunsStore([makeRun()]);
    expect(store.runs).toHaveLength(1);
    expect(store.runs[0]?.id).toBe('run-1');
  });

  it('upserts a new run at the head', () => {
    const store = createRunsStore([makeRun({ id: 'run-1' })]);
    store.upsertRun(makeRun({ id: 'run-2' }));
    expect(store.runs.map((run) => run.id)).toEqual(['run-2', 'run-1']);
  });

  it('upserts an existing run in place', () => {
    const store = createRunsStore([makeRun({ id: 'run-1', status: 'running' })]);
    store.upsertRun(makeRun({ id: 'run-1', status: 'completed' }));
    expect(store.runs).toHaveLength(1);
    expect(store.runs[0]?.status).toBe('completed');
  });

  it('accumulates usage and advances steps on step.completed', () => {
    const store = createRunsStore([makeRun({ id: 'run-1', steps: 0 })]);
    const frame: ServerFrame = {
      type: 'event',
      runId: 'run-1',
      event: 'step.completed',
      detail: { step: 2, usage: { prompt: 10, completion: 5, total: 15 } },
      sequence: 1,
      runSeq: 1,
      timestamp: 1,
    };
    store.handleMessage(frame);

    expect(store.runs[0]?.steps).toBe(3);
    expect(store.runs[0]?.usage).toEqual({ prompt: 10, completion: 5, total: 15 });
    expect(store.runs[0]?.actionCount).toBe(1);
  });

  it('marks a run completed with its finish reason', () => {
    const store = createRunsStore([makeRun({ id: 'run-1' })]);
    store.handleMessage({
      type: 'event',
      runId: 'run-1',
      event: 'run.completed',
      detail: { finishReason: 'stop' },
      sequence: 1,
      runSeq: 1,
      timestamp: 1,
    });

    expect(store.runs[0]?.status).toBe('completed');
    expect(store.runs[0]?.finishReason).toBe('stop');
  });

  it('marks a run errored with its error message', () => {
    const store = createRunsStore([makeRun({ id: 'run-1' })]);
    store.handleMessage({
      type: 'event',
      runId: 'run-1',
      event: 'run.error',
      detail: { error: 'boom' },
      sequence: 1,
      runSeq: 1,
      timestamp: 1,
    });

    expect(store.runs[0]?.status).toBe('error');
    expect(store.runs[0]?.error).toBe('boom');
  });

  it('marks a run aborted', () => {
    const store = createRunsStore([makeRun({ id: 'run-1' })]);
    store.handleMessage({
      type: 'event',
      runId: 'run-1',
      event: 'run.aborted',
      detail: {},
      sequence: 1,
      runSeq: 1,
      timestamp: 1,
    });

    expect(store.runs[0]?.status).toBe('aborted');
  });

  it('ignores non-event frames', () => {
    const store = createRunsStore([makeRun({ id: 'run-1', actionCount: 0 })]);
    store.handleMessage({ type: 'pong' });
    expect(store.runs[0]?.actionCount).toBe(0);
  });

  it('refreshes when an unseen run.started frame arrives', async () => {
    const fetched: RunSummary[] = [makeRun({ id: 'run-9' })];
    const fetchMock = mock(() => Promise.resolve(new Response(JSON.stringify(fetched))));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const store = createRunsStore([]);
    store.handleMessage({
      type: 'event',
      runId: 'run-9',
      event: 'run.started',
      detail: {},
      sequence: 1,
      runSeq: 1,
      timestamp: 1,
    });

    // The refresh fires asynchronously; let the microtask + fetch settle.
    await Promise.resolve();
    await Promise.resolve();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(store.runs.map((run) => run.id)).toEqual(['run-9']);
  });

  it('does not refresh when a run.started frame matches an existing run', async () => {
    const fetchMock = mock(() => Promise.resolve(new Response('[]')));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const store = createRunsStore([makeRun({ id: 'run-1' })]);
    store.handleMessage({
      type: 'event',
      runId: 'run-1',
      event: 'run.started',
      detail: {},
      sequence: 1,
      runSeq: 1,
      timestamp: 1,
    });

    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('replaces the run list on refresh', async () => {
    const fetchMock = mock(() =>
      Promise.resolve(new Response(JSON.stringify([makeRun({ id: 'refreshed' })]))),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const store = createRunsStore([makeRun({ id: 'stale' })]);
    await store.refresh();

    expect(store.runs.map((run) => run.id)).toEqual(['refreshed']);
  });
});
