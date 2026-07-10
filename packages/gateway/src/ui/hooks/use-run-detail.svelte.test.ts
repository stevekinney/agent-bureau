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
    agentName: 'bureau',
    principal: undefined,
    startedAt: 0,
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
      runSeq: 1,
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
      runSeq: 7,
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
      runSeq: 1,
      runId: 'run-1',
      content: 'lo',
      accumulated: 'hello',
    });
    expect(store.streamingAssistantContent).toBe('hello');

    store.handleMessage({ type: 'stream:complete', runSeq: 1, runId: 'run-1', state: undefined });
    expect(store.streamingAssistantContent).toBe('');
  });

  it('tracks tool activity by block id and appends a synthetic timeline event on start', () => {
    const store = createRunDetailStore(makeRunDetail({ id: 'run-1' }));

    store.handleMessage({
      type: 'stream:tool-call-start',
      runSeq: 1,
      runId: 'run-1',
      toolName: 'search',
      blockId: 'block-a',
    });
    store.handleMessage({
      type: 'stream:tool-call-delta',
      runSeq: 1,
      runId: 'run-1',
      toolName: 'search',
      blockId: 'block-a',
      partialArgs: '{"q":"a"}',
    });
    store.handleMessage({
      type: 'stream:tool-call-complete',
      runSeq: 1,
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
    store.handleMessage({ type: 'stream:error', runSeq: 1, runId: 'run-1', error: 'disconnected' });
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
      runSeq: 1,
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
      runSeq: 2,
      timestamp: 20,
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(store.run.status).toBe('completed');
    const synthetic = store.events.filter((event) => event.sequence === undefined);
    expect(synthetic.map((event) => event.event)).toContain('stream:tool-call-start');

    // The API also returned sequence 2, so the locally-appended sequence-2
    // event must appear exactly once after the merge — no duplicate row.
    const sequenceTwo = store.events.filter((event) => event.sequence === 2);
    expect(sequenceTwo).toHaveLength(1);
  });

  it('keeps a live sequenced event the refreshed API response has not caught up to', async () => {
    // Regression: refresh() used to rebuild the timeline from the API plus only
    // sequence-less rows, so any sequenced websocket event missing from the
    // (lagging) API response was dropped — timeline rows vanished right after a
    // terminal event. The merge must keep such events until the API includes
    // them.
    const lagging: RunDetail = makeRunDetail({
      id: 'run-1',
      status: 'completed',
      // The API lags the stream: it knows about sequence 1 but not the
      // sequence-2 step.completed that the websocket already delivered.
      events: [{ sequence: 1, runId: 'run-1', event: 'run.started', detail: {}, timestamp: 10 }],
    });
    const fetchMock = mock(() => Promise.resolve(new Response(JSON.stringify(lagging))));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const store = createRunDetailStore(makeRunDetail({ id: 'run-1' }));

    store.handleMessage({
      type: 'event',
      runId: 'run-1',
      event: 'step.completed',
      detail: {},
      sequence: 2,
      runSeq: 2,
      timestamp: 20,
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The lagging API event survives, AND the live sequence-2 event is retained.
    const sequences = store.events
      .map((event) => event.sequence)
      .filter((sequence): sequence is number => sequence !== undefined)
      .sort((a, b) => a - b);
    expect(sequences).toEqual([1, 2]);
    expect(store.events.map((event) => event.event)).toContain('step.completed');
  });

  it('does not duplicate a sequence value of 0 across a refresh', () => {
    // `sequence` can legitimately be 0; the merge must dedup it like any other
    // value and never treat it as "sequence-less" (which would double it).
    const store = createRunDetailStore(
      makeRunDetail({
        id: 'run-1',
        events: [{ sequence: 0, runId: 'run-1', event: 'run.started', detail: {}, timestamp: 1 }],
      }),
    );

    expect(store.events.filter((event) => event.sequence === 0)).toHaveLength(1);
  });
});
