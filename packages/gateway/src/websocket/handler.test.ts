import type { ServerWebSocket } from 'bun';
import { describe, expect, it } from 'bun:test';

import { LiveFrameBroker } from '../live-events';
import { createWebSocketHandler } from './handler';

/** A minimal fake shaped like the subset of `ServerWebSocket` the handler touches. */
function createFakeWebSocket() {
  let closeCalled = false;
  const sent: string[] = [];
  const ws = {
    send: (data: string) => sent.push(data),
    close: () => {
      closeCalled = true;
    },
  } as unknown as ServerWebSocket<unknown>;
  return { ws, sent, wasCloseCalled: () => closeCalled };
}

describe('createWebSocketHandler — AB-235 shutdown drain', () => {
  it('registers a closeConnection callback on open() that closes the WebSocket', () => {
    const broker = new LiveFrameBroker();
    const handler = createWebSocketHandler({ broker });
    const { ws, wasCloseCalled } = createFakeWebSocket();

    handler.open(ws);
    expect(broker.subscriberCount).toBe(1);

    broker.closeAll();

    expect(wasCloseCalled()).toBe(true);
  });

  it('does not close a WebSocket that was never opened through the handler', () => {
    const broker = new LiveFrameBroker();
    createWebSocketHandler({ broker });

    expect(() => broker.closeAll()).not.toThrow();
    expect(broker.subscriberCount).toBe(0);
  });
});

describe('createWebSocketHandler — message routing', () => {
  it('forwards a broadcast frame to the WebSocket via sendFrame', () => {
    const broker = new LiveFrameBroker();
    const handler = createWebSocketHandler({ broker });
    const { ws, sent } = createFakeWebSocket();

    handler.open(ws);
    handler.message(ws, JSON.stringify({ type: 'subscribe', runId: 'run-1' }));
    sent.length = 0; // clear the 'subscribed' ack from setup

    broker.broadcast({
      type: 'event',
      runId: 'run-1',
      event: 'run.completed',
      detail: { content: 'Done.' },
      sequence: 1,
      runSeq: 1,
      timestamp: Date.now(),
    });

    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0] ?? '{}')).toMatchObject({ type: 'event', runId: 'run-1' });
  });

  it('sends an error frame and returns without dispatching on malformed input', () => {
    const broker = new LiveFrameBroker();
    const handler = createWebSocketHandler({ broker });
    const { ws, sent } = createFakeWebSocket();

    handler.open(ws);
    handler.message(ws, 'not valid json');

    expect(sent).toHaveLength(1);
    const frame = JSON.parse(sent[0] ?? '{}');
    expect(frame.type).toBe('error');
    expect(frame.code).toBe('PARSE_ERROR');
  });

  it('subscribes, replays buffered frames, and acks on a subscribe frame', () => {
    const broker = new LiveFrameBroker();
    broker.broadcast({
      type: 'event',
      runId: 'run-1',
      event: 'run.completed',
      detail: { content: 'Done.' },
      sequence: 1,
      runSeq: 1,
      timestamp: Date.now(),
    });
    const handler = createWebSocketHandler({ broker });
    const { ws, sent } = createFakeWebSocket();

    handler.open(ws);
    handler.message(ws, JSON.stringify({ type: 'subscribe', runId: 'run-1', since: 0 }));

    const frames = sent.map((entry) => JSON.parse(entry));
    expect(frames).toContainEqual(expect.objectContaining({ type: 'event', runId: 'run-1' }));
    expect(frames).toContainEqual({ type: 'subscribed', runId: 'run-1' });
    expect(broker.getSubscriberCount('run-1')).toBe(1);
  });

  it('unsubscribes and acks on an unsubscribe frame', () => {
    const broker = new LiveFrameBroker();
    const handler = createWebSocketHandler({ broker });
    const { ws, sent } = createFakeWebSocket();

    handler.open(ws);
    handler.message(ws, JSON.stringify({ type: 'subscribe', runId: 'run-1' }));
    expect(broker.getSubscriberCount('run-1')).toBe(1);

    handler.message(ws, JSON.stringify({ type: 'unsubscribe', runId: 'run-1' }));

    expect(broker.getSubscriberCount('run-1')).toBe(0);
    expect(sent).toContainEqual(JSON.stringify({ type: 'unsubscribed', runId: 'run-1' }));
  });
});

describe('createWebSocketHandler — connection watchdog pulses (AB-219)', () => {
  it('records a transport-keepalive pulse when the client sends ping', () => {
    const broker = new LiveFrameBroker();
    const handler = createWebSocketHandler({ broker });
    const { ws, sent } = createFakeWebSocket();

    handler.open(ws);
    const [key] = [...broker.getConnectionRegistry().keys()];
    expect(key).toBeDefined();
    if (!key) return;
    expect(broker.getConnectionRegistry().get(key)?.snapshot().evidence).toHaveLength(0);

    handler.message(ws, JSON.stringify({ type: 'ping' }));

    const evidence = broker.getConnectionRegistry().get(key)?.snapshot().evidence;
    expect(evidence).toHaveLength(1);
    expect(evidence?.[0]?.source).toBe('transport-keepalive');
    expect(sent).toEqual([JSON.stringify({ type: 'pong' })]);
  });
});
