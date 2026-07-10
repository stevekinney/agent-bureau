import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

import type { ServerFrame } from '../../types';
import { createWebSocket } from './use-websocket.svelte.ts';

// ── Controllable transport fakes ────────────────────────────────────

type Listener = (event: unknown) => void;

class FakeEventTarget {
  protected listeners = new Map<string, Set<Listener>>();

  addEventListener(type: string, listener: Listener): void {
    const set = this.listeners.get(type) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(type, set);
  }

  emit(type: string, event: unknown = {}): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

class FakeWebSocket extends FakeEventTarget {
  static readonly OPEN = 1;
  static instances: FakeWebSocket[] = [];

  readonly url: string;
  readyState = 0;
  readonly sent: string[] = [];
  closed = false;

  constructor(url: string) {
    super();
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.emit('open');
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.readyState = 3;
  }

  /** Simulates the socket closing, the way the browser fires the close event. */
  fireClose(): void {
    this.readyState = 3;
    this.emit('close');
  }
}

class FakeEventSource extends FakeEventTarget {
  static instances: FakeEventSource[] = [];

  readonly url: string;
  closed = false;

  constructor(url: string) {
    super();
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  open(): void {
    this.emit('open');
  }

  close(): void {
    this.closed = true;
  }
}

const originalWebSocket = globalThis.WebSocket;
const originalEventSource = globalThis.EventSource;
const originalWindow = (globalThis as { window?: unknown }).window;

function lastSocket(): FakeWebSocket {
  const socket = FakeWebSocket.instances.at(-1);
  if (!socket) throw new Error('expected a FakeWebSocket to have been constructed');
  return socket;
}

function lastSource(): FakeEventSource {
  const source = FakeEventSource.instances.at(-1);
  if (!source) throw new Error('expected a FakeEventSource to have been constructed');
  return source;
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  FakeEventSource.instances = [];
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
  // `buildEventStreamUrl` reads window.location.origin.
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { location: { origin: 'http://localhost' } },
  });
});

afterEach(() => {
  globalThis.WebSocket = originalWebSocket;
  globalThis.EventSource = originalEventSource;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: originalWindow,
  });
});

describe('createWebSocket', () => {
  it('starts disconnected and connects on start()', () => {
    const store = createWebSocket({ url: '/ws', eventStreamUrl: '/api/v1/events' });
    expect(store.status).toBe('disconnected');

    store.start();
    expect(store.status).toBe('connecting');
    expect(lastSocket().url).toBe('/ws');

    lastSocket().open();
    expect(store.status).toBe('connected');

    store.stop();
  });

  it('appends the auth token to the websocket url', () => {
    const store = createWebSocket({
      url: '/ws',
      eventStreamUrl: '/api/v1/events',
      authToken: 'secret',
    });
    store.start();
    expect(lastSocket().url).toBe('/ws?token=secret');
    store.stop();
  });

  it('flushes pending subscriptions when the socket opens', () => {
    const store = createWebSocket({ url: '/ws', eventStreamUrl: '/api/v1/events' });
    store.start();
    store.subscribe('run-1');
    store.subscribe('run-2');

    lastSocket().open();

    expect(lastSocket().sent).toEqual([
      JSON.stringify({ type: 'subscribe', runId: 'run-1' }),
      JSON.stringify({ type: 'subscribe', runId: 'run-2' }),
    ]);
    store.stop();
  });

  it('sends frames immediately over an open socket', () => {
    const store = createWebSocket({ url: '/ws', eventStreamUrl: '/api/v1/events' });
    store.start();
    lastSocket().open();

    store.subscribe('run-9');
    expect(lastSocket().sent).toContain(JSON.stringify({ type: 'subscribe', runId: 'run-9' }));

    store.unsubscribe('run-9');
    expect(lastSocket().sent).toContain(JSON.stringify({ type: 'unsubscribe', runId: 'run-9' }));
    store.stop();
  });

  it('forwards parsed frames to onMessage and ignores malformed ones', () => {
    const onMessage = mock((_frame: ServerFrame) => {});
    const store = createWebSocket({ url: '/ws', eventStreamUrl: '/api/v1/events', onMessage });
    store.start();
    lastSocket().open();

    lastSocket().emit('message', { data: JSON.stringify({ type: 'pong' }) });
    expect(onMessage).toHaveBeenCalledWith({ type: 'pong' });

    lastSocket().emit('message', { data: 'not json' });
    expect(onMessage).toHaveBeenCalledTimes(1);
    store.stop();
  });

  it('falls back to the event stream when the socket closes before opening', () => {
    const store = createWebSocket({ url: '/ws', eventStreamUrl: '/api/v1/events' });
    store.start();
    store.subscribe('run-1');

    // Socket never opened — closing triggers the SSE fallback.
    lastSocket().fireClose();

    expect(store.status).toBe('connecting');
    expect(lastSource().url).toBe('http://localhost/api/v1/events?runId=run-1');

    lastSource().open();
    expect(store.status).toBe('connected');
    store.stop();
  });

  it('threads the auth token into the event stream url', () => {
    const store = createWebSocket({
      url: '/ws',
      eventStreamUrl: '/api/v1/events',
      authToken: 'tok',
    });
    store.start();
    store.subscribe('run-1');
    lastSocket().fireClose();

    expect(lastSource().url).toBe('http://localhost/api/v1/events?token=tok&runId=run-1');
    store.stop();
  });

  it('schedules a reconnect after an established socket closes', () => {
    const setTimeoutSpy = mock((handler: () => void, _ms?: number) => {
      // Return a sentinel handle; capture the handler for assertion below.
      pendingReconnect = handler;
      return 1 as unknown as ReturnType<typeof setTimeout>;
    });
    let pendingReconnect: (() => void) | undefined;
    const originalSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = setTimeoutSpy as unknown as typeof setTimeout;

    try {
      const store = createWebSocket({
        url: '/ws',
        eventStreamUrl: '/api/v1/events',
        reconnectInterval: 1234,
      });
      store.start();
      lastSocket().open();
      expect(store.status).toBe('connected');

      lastSocket().fireClose();
      expect(store.status).toBe('disconnected');
      expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
      expect(setTimeoutSpy.mock.calls[0]?.[1]).toBe(1234);

      // Firing the scheduled reconnect opens a fresh socket.
      const before = FakeWebSocket.instances.length;
      pendingReconnect?.();
      expect(FakeWebSocket.instances.length).toBe(before + 1);

      store.stop();
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
  });

  it('does not reconnect or change status after stop()', () => {
    const store = createWebSocket({ url: '/ws', eventStreamUrl: '/api/v1/events' });
    store.start();
    const socket = lastSocket();
    socket.open();
    expect(store.status).toBe('connected');

    store.stop();
    expect(socket.closed).toBe(true);

    // A late close event from the torn-down socket must not flip status or
    // schedule a reconnect.
    const before = FakeWebSocket.instances.length;
    socket.fireClose();
    expect(store.status).toBe('connected');
    expect(FakeWebSocket.instances.length).toBe(before);
  });

  it('reopens the event stream on send when already in fallback mode', () => {
    const store = createWebSocket({ url: '/ws', eventStreamUrl: '/api/v1/events' });
    store.start();
    store.subscribe('run-1');
    lastSocket().fireClose();
    lastSource().open();

    const sourcesBefore = FakeEventSource.instances.length;
    store.subscribe('run-2');
    expect(FakeEventSource.instances.length).toBe(sourcesBefore + 1);
    expect(lastSource().url).toBe('http://localhost/api/v1/events?runId=run-1&runId=run-2');
    store.stop();
  });

  // AB-15 regression: a wildcard ('*') subscription has no run id of its own
  // to carry a replay cursor — `lastSeenRunSeq` is keyed by the real run ids
  // frames arrived for. A reconnect must still carry those per-run cursors
  // (in addition to '*') or every run update received while disconnected is
  // silently lost until a manual refresh.
  it('carries per-run cursors alongside a wildcard subscription on reconnect', () => {
    const store = createWebSocket({ url: '/ws', eventStreamUrl: '/api/v1/events' });
    store.start();
    store.subscribe('*');
    lastSocket().open();

    // Frames for two concrete runs arrive over the wildcard subscription.
    lastSocket().emit('message', {
      data: JSON.stringify({
        type: 'event',
        runId: 'run-a',
        event: 'run.completed',
        detail: {},
        sequence: 1,
        runSeq: 3,
        timestamp: Date.now(),
      }),
    });
    lastSocket().emit('message', {
      data: JSON.stringify({
        type: 'event',
        runId: 'run-b',
        event: 'run.completed',
        detail: {},
        sequence: 1,
        runSeq: 5,
        timestamp: Date.now(),
      }),
    });

    // Kill the socket after it was established — falls to the reconnect
    // timer path (not the immediate SSE-fallback path).
    const setTimeoutSpy = mock((handler: () => void, _ms?: number) => {
      pendingReconnect = handler;
      return 1 as unknown as ReturnType<typeof setTimeout>;
    });
    let pendingReconnect: (() => void) | undefined;
    const originalSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = setTimeoutSpy as unknown as typeof setTimeout;

    try {
      lastSocket().fireClose();
      pendingReconnect?.();
      lastSocket().open();

      const sentSubscribes = lastSocket().sent.map(
        (raw) => JSON.parse(raw) as Record<string, unknown>,
      );
      const byRunId = new Map(sentSubscribes.map((frame) => [frame['runId'], frame['since']]));

      // '*' stays subscribed (with no cursor of its own — there's no stable
      // buffered position across an open-ended run set).
      expect(byRunId.get('*')).toBeUndefined();
      expect(byRunId.has('*')).toBe(true);
      // Each concrete run carries its own last-seen cursor so the door can
      // replay exactly what was missed while disconnected.
      expect(byRunId.get('run-a')).toBe(3);
      expect(byRunId.get('run-b')).toBe(5);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      store.stop();
    }
  });
});
