import { describe, expect, it } from 'bun:test';

import { LiveFrameBroker } from './live-events';
import type { ServerFrame } from './types';

function createRunFrame(runSeq = 1): ServerFrame {
  return {
    type: 'event',
    runId: 'run-1',
    event: 'run.completed',
    detail: { content: 'Done.' },
    sequence: runSeq,
    runSeq,
    timestamp: Date.now(),
  };
}

describe('SSE response headers', () => {
  it('sets content-type to text/event-stream', () => {
    const broker = new LiveFrameBroker();
    const request = new Request('http://example.test/api/v1/events');
    const response = broker.createEventStreamResponse(request);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
  });

  it('disables caching and response transformation', () => {
    const broker = new LiveFrameBroker();
    const request = new Request('http://example.test/api/v1/events');
    const response = broker.createEventStreamResponse(request);
    expect(response.headers.get('cache-control')).toBe('no-cache, no-transform');
  });

  it('instructs nginx/proxy not to buffer the SSE stream', () => {
    const broker = new LiveFrameBroker();
    const request = new Request('http://example.test/api/v1/events');
    const response = broker.createEventStreamResponse(request);
    expect(response.headers.get('x-accel-buffering')).toBe('no');
  });

  it('prevents MIME sniffing on the event stream', () => {
    const broker = new LiveFrameBroker();
    const request = new Request('http://example.test/api/v1/events');
    const response = broker.createEventStreamResponse(request);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('sets connection keep-alive for HTTP/1.1 compatibility', () => {
    const broker = new LiveFrameBroker();
    const request = new Request('http://example.test/api/v1/events');
    const response = broker.createEventStreamResponse(request);
    expect(response.headers.get('connection')).toBe('keep-alive');
  });
});

describe('SSE heartbeat', () => {
  it('defaults to an interval shorter than Bun idle timeout (10 s)', async () => {
    const broker = new LiveFrameBroker();
    // Use a very short custom interval to verify heartbeat fires within the test.
    const request = new Request('http://example.test/api/v1/events');
    const response = broker.createEventStreamResponse(request, {
      heartbeatIntervalMs: 1,
    });

    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    if (!reader) return;

    // First chunk: the ': connected' comment
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain(': connected');

    // Second chunk: the heartbeat comment (fires after 1 ms)
    const second = await reader.read();
    expect(new TextDecoder().decode(second.value)).toContain(': heartbeat');

    await reader.cancel();
  });

  it('accepts a custom heartbeat interval', async () => {
    const broker = new LiveFrameBroker();
    const request = new Request('http://example.test/api/v1/events');
    // Verify the option is accepted without throwing.
    const response = broker.createEventStreamResponse(request, {
      heartbeatIntervalMs: 30_000,
    });
    expect(response).toBeDefined();
    const reader = response.body?.getReader();
    await reader?.cancel();
  });
});

describe('LiveFrameBroker', () => {
  it('keeps broadcasting when one subscriber throws', () => {
    const broker = new LiveFrameBroker();
    const received: ServerFrame[] = [];
    const failingSubscriber = {};
    const healthySubscriber = {};

    broker.addSubscriber(
      failingSubscriber,
      () => {
        throw new Error('socket closed');
      },
      { runIds: ['run-1'] },
    );
    broker.addSubscriber(healthySubscriber, (frame) => received.push(frame), { runIds: ['run-1'] });

    expect(() => broker.broadcast(createRunFrame())).not.toThrow();
    expect(received).toHaveLength(1);
    expect(broker.getSubscriberCount('run-1')).toBe(1);
  });

  it('does not broadcast control frames without a run identifier through run subscriptions', () => {
    const broker = new LiveFrameBroker();
    const received: ServerFrame[] = [];

    broker.addSubscriber({}, (frame) => received.push(frame), { runIds: ['run-1'] });
    broker.addSubscriber({}, (frame) => received.push(frame), {
      runIds: ['*'],
      includeScheduler: true,
    });

    broker.broadcast({ type: 'pong' });

    expect(received).toHaveLength(0);
  });

  it('treats stream cancellation as a full close before a later abort', async () => {
    const broker = new LiveFrameBroker();
    const abortController = new AbortController();
    const request = new Request('http://example.test/api/v1/events', {
      signal: abortController.signal,
    });

    const response = broker.createEventStreamResponse(request, {
      runIds: ['run-1'],
      heartbeatIntervalMs: 1,
    });

    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    if (!reader) {
      return;
    }

    await reader.read();
    expect(broker.getSubscriberCount('run-1')).toBe(1);

    await reader.cancel();
    abortController.abort();

    expect(broker.getSubscriberCount('run-1')).toBe(0);
    expect(() => broker.broadcast(createRunFrame())).not.toThrow();
  });

  it('replays nothing for an omitted "since" — a fresh subscribe is not a history replay', () => {
    const broker = new LiveFrameBroker();
    broker.broadcast(createRunFrame());
    broker.broadcast(createRunFrame(2));

    // Buffer has frames, but a fresh subscribe (no cursor at all) must not
    // receive any of them — only an explicit `since` triggers replay.
    expect(broker.getFramesSince('run-1')).toEqual([]);
  });

  it('replays the full buffer for an explicit "since: 0" (reconnect from the start)', () => {
    const broker = new LiveFrameBroker();
    broker.broadcast(createRunFrame());
    broker.broadcast(createRunFrame(2));

    const frames = broker.getFramesSince('run-1', 0);
    expect(frames).toHaveLength(2);
  });

  it('does not replay buffered history to a fresh SSE subscription with no cursor', async () => {
    const broker = new LiveFrameBroker();
    broker.broadcast(createRunFrame());
    broker.broadcast(createRunFrame(2));

    const request = new Request('http://example.test/api/v1/events?runId=run-1');
    const response = broker.createEventStreamResponse(request, { runIds: ['run-1'] });
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    if (!reader) return;

    // Only the ': connected' comment should show up — no replayed data lines.
    const first = await reader.read();
    const text = new TextDecoder().decode(first.value);
    expect(text).toContain(': connected');
    expect(text).not.toContain('data:');

    await reader.cancel();
  });

  it('falls back to the "since" query param when Last-Event-ID is present but empty', async () => {
    const broker = new LiveFrameBroker();
    broker.broadcast(createRunFrame());
    broker.broadcast(createRunFrame(2));

    const request = new Request(
      `http://example.test/api/v1/events?runId=run-1&since=${encodeURIComponent('run-1')}:1`,
      { headers: { 'last-event-id': '' } },
    );
    const response = broker.createEventStreamResponse(request, { runIds: ['run-1'] });
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    if (!reader) return;

    const chunk = await reader.read();
    const text = new TextDecoder().decode(chunk.value);
    // The `since=run-1:1` query param should win (empty header is ignored),
    // so only runSeq 2 (the frame after the cursor) is replayed.
    expect(text).toContain('"runSeq":2');
    expect(text).not.toContain('"runSeq":1');

    await reader.cancel();
  });

  it('tolerates a malformed percent-encoded cursor without throwing', async () => {
    const broker = new LiveFrameBroker();
    broker.broadcast(createRunFrame());

    const request = new Request('http://example.test/api/v1/events?runId=run-1&since=bad%zz:3');
    expect(() => broker.createEventStreamResponse(request, { runIds: ['run-1'] })).not.toThrow();
  });

  it('ignores a negative or fractional cursor entry instead of using it', async () => {
    const broker = new LiveFrameBroker();
    broker.broadcast(createRunFrame());
    broker.broadcast(createRunFrame(2));

    const request = new Request(
      `http://example.test/api/v1/events?runId=run-1&since=${encodeURIComponent('run-1')}:-1`,
    );
    const response = broker.createEventStreamResponse(request, { runIds: ['run-1'] });
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    if (!reader) return;

    // An invalid cursor entry is dropped, which decodes to "no cursor for
    // run-1" — i.e. no replay, not "replay everything".
    const first = await reader.read();
    const text = new TextDecoder().decode(first.value);
    expect(text).not.toContain('data:');

    await reader.cancel();
  });
});
