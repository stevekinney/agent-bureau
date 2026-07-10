import { describe, expect, it } from 'bun:test';
import type { StreamEvent } from 'operative';

import { parseClientFrame, streamEventToFrame, SubscriptionManager } from './protocol';

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

  it('returns INVALID_FRAME (not PARSE_ERROR) for a JSON null payload', () => {
    const frame = parseClientFrame('null');
    expect(frame.type).toBe('error');
    if (frame.type === 'error') {
      expect(frame.code).toBe('INVALID_FRAME');
    }
  });

  it('returns INVALID_FRAME for a JSON array payload', () => {
    const frame = parseClientFrame('[1,2,3]');
    expect(frame.type).toBe('error');
    if (frame.type === 'error') {
      expect(frame.code).toBe('INVALID_FRAME');
    }
  });

  it('returns INVALID_FRAME for a JSON scalar payload', () => {
    const frame = parseClientFrame('42');
    expect(frame.type).toBe('error');
    if (frame.type === 'error') {
      expect(frame.code).toBe('INVALID_FRAME');
    }
  });

  it('drops a negative "since" on subscribe instead of accepting it', () => {
    const frame = parseClientFrame(
      JSON.stringify({ type: 'subscribe', runId: 'run-1', since: -5 }),
    );
    expect(frame).toEqual({ type: 'subscribe', runId: 'run-1', since: undefined });
  });

  it('drops a fractional "since" on subscribe instead of accepting it', () => {
    const frame = parseClientFrame(
      JSON.stringify({ type: 'subscribe', runId: 'run-1', since: 1.5 }),
    );
    expect(frame).toEqual({ type: 'subscribe', runId: 'run-1', since: undefined });
  });

  it('accepts a safe non-negative integer "since" on subscribe', () => {
    const frame = parseClientFrame(JSON.stringify({ type: 'subscribe', runId: 'run-1', since: 0 }));
    expect(frame).toEqual({ type: 'subscribe', runId: 'run-1', since: 0 });
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

  it('broadcasts stream events to subscribers via broadcastStreamEvent', () => {
    const manager = new SubscriptionManager();
    const { ws, sent } = createMockWebSocket();

    manager.subscribe(ws, 'run-1');

    const event: StreamEvent = {
      type: 'stream:text-delta',
      content: 'Hello',
      accumulated: 'Hello',
    };

    manager.broadcastStreamEvent('run-1', event);

    expect(sent).toHaveLength(1);
    const parsed = JSON.parse(sent[0]!) as Record<string, unknown>;
    expect(parsed['type']).toBe('stream:text-delta');
    expect(parsed['runId']).toBe('run-1');
    expect(parsed['content']).toBe('Hello');
    expect(parsed['accumulated']).toBe('Hello');
  });

  it('does not broadcast stream events to unsubscribed clients', () => {
    const manager = new SubscriptionManager();
    const { ws: ws1, sent: sent1 } = createMockWebSocket();
    const { ws: ws2, sent: sent2 } = createMockWebSocket();

    manager.subscribe(ws1, 'run-1');
    manager.subscribe(ws2, 'run-2');

    const event: StreamEvent = {
      type: 'stream:tool-call-start',
      toolName: 'get_weather',
      blockId: 'block-1',
    };

    manager.broadcastStreamEvent('run-1', event);

    expect(sent1).toHaveLength(1);
    expect(sent2).toHaveLength(0);
  });

  it('does not advance the run sequence when a run has zero subscribers', () => {
    const manager = new SubscriptionManager();
    const { ws, sent } = createMockWebSocket();

    // Subscribe then immediately unsubscribe, so 'run-1' has zero subscribers
    // but its sequence counter (if any) still exists in the manager.
    manager.subscribe(ws, 'run-1');
    manager.unsubscribe(ws, 'run-1');

    const event: StreamEvent = {
      type: 'stream:text-delta',
      content: 'nobody home',
      accumulated: 'nobody home',
    };

    // Broadcasting with zero subscribers must not throw or deliver anything.
    manager.broadcastStreamEvent('run-1', event);
    expect(sent).toHaveLength(0);

    // Re-subscribing must see a fresh sequence starting at 1, proving the
    // earlier no-subscriber broadcast never advanced (or leaked) the counter.
    manager.subscribe(ws, 'run-1');
    manager.broadcastStreamEvent('run-1', event);
    expect(sent).toHaveLength(1);
    const parsed = JSON.parse(sent[0]!) as Record<string, unknown>;
    expect(parsed['runSeq']).toBe(1);
  });
});

describe('streamEventToFrame', () => {
  it('converts stream:text-delta to a ServerFrame', () => {
    const event: StreamEvent = {
      type: 'stream:text-delta',
      content: 'Hello',
      accumulated: 'Hello',
    };

    const frame = streamEventToFrame('run-1', event);
    expect(frame).toBeDefined();
    expect(frame?.type).toBe('stream:text-delta');
    if (frame?.type === 'stream:text-delta') {
      expect(frame.runId).toBe('run-1');
      expect(frame.content).toBe('Hello');
      expect(frame.accumulated).toBe('Hello');
    }
  });

  it('converts stream:tool-call-start to a ServerFrame', () => {
    const event: StreamEvent = {
      type: 'stream:tool-call-start',
      toolName: 'get_weather',
      blockId: 'block-1',
    };

    const frame = streamEventToFrame('run-2', event);
    expect(frame).toBeDefined();
    expect(frame?.type).toBe('stream:tool-call-start');
    if (frame?.type === 'stream:tool-call-start') {
      expect(frame.runId).toBe('run-2');
      expect(frame.toolName).toBe('get_weather');
    }
  });

  it('converts stream:tool-call-delta to a ServerFrame', () => {
    const event: StreamEvent = {
      type: 'stream:tool-call-delta',
      toolName: 'search',
      blockId: 'block-1',
      partialArguments: '{"query":',
    };

    const frame = streamEventToFrame('run-3', event);
    expect(frame).toBeDefined();
    if (frame?.type === 'stream:tool-call-delta') {
      expect(frame.toolName).toBe('search');
      expect(frame.partialArgs).toBe('{"query":');
    }
  });

  it('converts stream:tool-call-complete to a ServerFrame', () => {
    const event: StreamEvent = {
      type: 'stream:tool-call-complete',
      toolName: 'search',
      blockId: 'block-2',
      arguments: { query: 'test' },
    };

    const frame = streamEventToFrame('run-4', event);
    expect(frame).toBeDefined();
    if (frame?.type === 'stream:tool-call-complete') {
      expect(frame.toolName).toBe('search');
      expect(frame.arguments).toEqual({ query: 'test' });
    }
  });

  it('converts stream:complete to a ServerFrame with state', () => {
    const event: StreamEvent = {
      type: 'stream:complete',
      state: {
        blocks: [],
        activeBlock: undefined,
        textContent: 'Hello',
        toolCalls: [],
        complete: true,
      },
    };

    const frame = streamEventToFrame('run-5', event);
    expect(frame).toBeDefined();
    if (frame?.type === 'stream:complete') {
      expect(frame.runId).toBe('run-5');
      expect(frame.state).toBeDefined();
    }
  });

  it('converts stream:error to a ServerFrame with string error', () => {
    const event: StreamEvent = {
      type: 'stream:error',
      error: new Error('Connection lost'),
    };

    const frame = streamEventToFrame('run-6', event);
    expect(frame).toBeDefined();
    if (frame?.type === 'stream:error') {
      expect(frame.runId).toBe('run-6');
      expect(frame.error).toBe('Connection lost');
    }
  });

  it('returns undefined for internal-only events', () => {
    const blockStart: StreamEvent = {
      type: 'stream:block-start',
      block: {
        id: 'b1',
        type: 'text',
        index: 0,
        content: '',
        complete: false,
      },
    };

    expect(streamEventToFrame('run-7', blockStart)).toBeUndefined();
  });

  it('converts non-Error stream:error to string', () => {
    const event: StreamEvent = {
      type: 'stream:error',
      error: 'simple string error',
    };

    const frame = streamEventToFrame('run-8', event);
    if (frame?.type === 'stream:error') {
      expect(frame.error).toBe('simple string error');
    }
  });
});
