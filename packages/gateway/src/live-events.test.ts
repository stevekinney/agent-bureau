import { describe, expect, it } from 'bun:test';

import { LiveFrameBroker } from './live-events';
import type { ServerFrame } from './types';

function createRunFrame(): ServerFrame {
  return {
    type: 'event',
    runId: 'run-1',
    event: 'run.completed',
    detail: { content: 'Done.' },
    sequence: 1,
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
});
