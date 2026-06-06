import { afterEach, describe, expect, it, mock } from 'bun:test';

import type { RunDetail } from '../../types';
import { createRunDetailStore } from './use-run-detail.svelte.ts';

function makeRunDetail(overrides: Partial<RunDetail> = {}): RunDetail {
  return {
    id: 'run-1',
    sessionId: 'session-1',
    status: 'running',
    steps: 0,
    usage: { prompt: 0, completion: 0, total: 0 },
    finishReason: undefined,
    error: undefined,
    actionCount: 0,
    events: [],
    stepDetails: [],
    latestSnapshot: undefined,
    ...overrides,
  };
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('createRunDetailStore', () => {
  it('seeds the timeline from the initial run events', () => {
    const store = createRunDetailStore(
      makeRunDetail({
        events: [{ sequence: 1, runId: 'run-1', event: 'run.started', detail: {}, timestamp: 10 }],
      }),
    );

    expect(store.events).toHaveLength(1);
    expect(store.events[0]?.event).toBe('run.started');
    expect(store.events[0]?.sequence).toBe(1);
  });

  it('ignores frames for a different run id', () => {
    const store = createRunDetailStore(makeRunDetail({ id: 'run-1' }));
    store.handleMessage({
      type: 'stream:text-delta',
      runId: 'other',
      content: 'x',
      accumulated: 'x',
    });
    expect(store.streamingAssistantContent).toBe('');
  });

  it('appends event frames to the timeline', () => {
    const store = createRunDetailStore(makeRunDetail({ id: 'run-1' }));
    store.handleMessage({
      type: 'event',
      runId: 'run-1',
      event: 'log',
      detail: { line: 'hello' },
      sequence: 7,
      timestamp: 99,
    });

    expect(store.events).toHaveLength(1);
    expect(store.events[0]).toEqual({
      event: 'log',
      detail: { line: 'hello' },
      timestamp: 99,
      sequence: 7,
    });
  });

  it('accumulates streaming text and clears it on stream:complete', () => {
    const store = createRunDetailStore(makeRunDetail({ id: 'run-1' }));
    store.handleMessage({
      type: 'stream:text-delta',
      runId: 'run-1',
      content: 'lo',
      accumulated: 'hello',
    });
    expect(store.streamingAssistantContent).toBe('hello');

    store.handleMessage({ type: 'stream:complete', runId: 'run-1', state: undefined });
    expect(store.streamingAssistantContent).toBe('');
  });

  it('tracks tool activity by block id and appends a synthetic timeline event on start', () => {
    const store = createRunDetailStore(makeRunDetail({ id: 'run-1' }));

    store.handleMessage({
      type: 'stream:tool-call-start',
      runId: 'run-1',
      toolName: 'search',
      blockId: 'block-a',
    });
    store.handleMessage({
      type: 'stream:tool-call-delta',
      runId: 'run-1',
      toolName: 'search',
      blockId: 'block-a',
      partialArgs: '{"q":"a"}',
    });
    store.handleMessage({
      type: 'stream:tool-call-complete',
      runId: 'run-1',
      toolName: 'search',
      blockId: 'block-a',
      arguments: { q: 'a' },
    });

    expect(store.toolActivity).toEqual(['search completed']);
    expect(store.events.map((event) => event.event)).toContain('stream:tool-call-start');
  });

  it('appends a streaming error to the tool-activity log', () => {
    const store = createRunDetailStore(makeRunDetail({ id: 'run-1' }));
    store.handleMessage({ type: 'stream:error', runId: 'run-1', error: 'disconnected' });
    expect(store.toolActivity).toEqual(['Streaming error: disconnected']);
  });

  it('refreshes on terminal events and merges synthetic timeline entries', async () => {
    const refreshed: RunDetail = makeRunDetail({
      id: 'run-1',
      status: 'completed',
      events: [{ sequence: 2, runId: 'run-1', event: 'run.completed', detail: {}, timestamp: 20 }],
    });
    const fetchMock = mock(() => Promise.resolve(new Response(JSON.stringify(refreshed))));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const store = createRunDetailStore(makeRunDetail({ id: 'run-1' }));

    // A synthetic (sequence-less) tool-call-start entry should survive refresh.
    store.handleMessage({
      type: 'stream:tool-call-start',
      runId: 'run-1',
      toolName: 'search',
      blockId: 'block-a',
    });

    store.handleMessage({
      type: 'event',
      runId: 'run-1',
      event: 'run.completed',
      detail: {},
      sequence: 2,
      timestamp: 20,
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(store.run.status).toBe('completed');
    const synthetic = store.events.filter((event) => event.sequence === undefined);
    expect(synthetic.map((event) => event.event)).toContain('stream:tool-call-start');
  });
});
