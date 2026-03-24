import { describe, expect, it } from 'bun:test';

import { parseClientFrame, SubscriptionManager } from './protocol';

describe('parseClientFrame', () => {
  it('parses a subscribe frame', () => {
    const frame = parseClientFrame(JSON.stringify({ type: 'subscribe', runId: 'run-1' }));
    expect(frame).toEqual({ type: 'subscribe', runId: 'run-1' });
  });

  it('parses an unsubscribe frame', () => {
    const frame = parseClientFrame(JSON.stringify({ type: 'unsubscribe', runId: 'run-1' }));
    expect(frame).toEqual({ type: 'unsubscribe', runId: 'run-1' });
  });

  it('parses a ping frame', () => {
    const frame = parseClientFrame(JSON.stringify({ type: 'ping' }));
    expect(frame).toEqual({ type: 'ping' });
  });

  it('returns error for invalid JSON', () => {
    const frame = parseClientFrame('not json');
    expect(frame.type).toBe('error');
    if (frame.type === 'error') {
      expect(frame.code).toBe('PARSE_ERROR');
    }
  });

  it('returns error for missing type field', () => {
    const frame = parseClientFrame(JSON.stringify({ runId: 'run-1' }));
    expect(frame.type).toBe('error');
    if (frame.type === 'error') {
      expect(frame.code).toBe('INVALID_FRAME');
    }
  });

  it('returns error for unknown type', () => {
    const frame = parseClientFrame(JSON.stringify({ type: 'unknown' }));
    expect(frame.type).toBe('error');
    if (frame.type === 'error') {
      expect(frame.code).toBe('UNKNOWN_TYPE');
    }
  });

  it('returns error for subscribe without runId', () => {
    const frame = parseClientFrame(JSON.stringify({ type: 'subscribe' }));
    expect(frame.type).toBe('error');
  });

  it('returns error for unsubscribe without runId', () => {
    const frame = parseClientFrame(JSON.stringify({ type: 'unsubscribe' }));
    expect(frame.type).toBe('error');
  });

  it('handles Buffer input', () => {
    const frame = parseClientFrame(Buffer.from(JSON.stringify({ type: 'ping' })));
    expect(frame).toEqual({ type: 'ping' });
  });
});

describe('SubscriptionManager', () => {
  function createMockWebSocket() {
    const sent: string[] = [];
    return {
      ws: {
        send(data: string) {
          sent.push(data);
        },
      } as unknown as import('bun').ServerWebSocket<unknown>,
      sent,
    };
  }

  it('subscribes a connection to a run', () => {
    const manager = new SubscriptionManager();
    const { ws } = createMockWebSocket();

    manager.subscribe(ws, 'run-1');
    expect(manager.getSubscriptions(ws).has('run-1')).toBe(true);
    expect(manager.getSubscriberCount('run-1')).toBe(1);
  });

  it('unsubscribes a connection from a run', () => {
    const manager = new SubscriptionManager();
    const { ws } = createMockWebSocket();

    manager.subscribe(ws, 'run-1');
    manager.unsubscribe(ws, 'run-1');
    expect(manager.getSubscriptions(ws).size).toBe(0);
    expect(manager.getSubscriberCount('run-1')).toBe(0);
  });

  it('removes all subscriptions for a connection', () => {
    const manager = new SubscriptionManager();
    const { ws } = createMockWebSocket();

    manager.subscribe(ws, 'run-1');
    manager.subscribe(ws, 'run-2');
    manager.removeConnection(ws);

    expect(manager.getSubscriberCount('run-1')).toBe(0);
    expect(manager.getSubscriberCount('run-2')).toBe(0);
  });

  it('broadcasts to all subscribers of a run', () => {
    const manager = new SubscriptionManager();
    const { ws: ws1, sent: sent1 } = createMockWebSocket();
    const { ws: ws2, sent: sent2 } = createMockWebSocket();
    const { ws: ws3, sent: sent3 } = createMockWebSocket();

    manager.subscribe(ws1, 'run-1');
    manager.subscribe(ws2, 'run-1');
    manager.subscribe(ws3, 'run-2');

    manager.broadcast('run-1', { type: 'pong' });

    expect(sent1).toHaveLength(1);
    expect(sent2).toHaveLength(1);
    expect(sent3).toHaveLength(0);
  });

  it('supports multiple subscriptions per connection', () => {
    const manager = new SubscriptionManager();
    const { ws } = createMockWebSocket();

    manager.subscribe(ws, 'run-1');
    manager.subscribe(ws, 'run-2');

    expect(manager.getSubscriptions(ws).size).toBe(2);
  });

  it('handles unsubscribing from non-subscribed run gracefully', () => {
    const manager = new SubscriptionManager();
    const { ws } = createMockWebSocket();

    // Should not throw
    manager.unsubscribe(ws, 'run-nonexistent');
    expect(manager.getSubscriberCount('run-nonexistent')).toBe(0);
  });

  it('handles removing untracked connection gracefully', () => {
    const manager = new SubscriptionManager();
    const { ws } = createMockWebSocket();

    // Should not throw
    manager.removeConnection(ws);
  });

  it('returns empty set for unknown connection', () => {
    const manager = new SubscriptionManager();
    const { ws } = createMockWebSocket();
    expect(manager.getSubscriptions(ws).size).toBe(0);
  });
});
