import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

import type { ServerFrame } from '../../types';
import {
  clearScheduledInterval,
  createBrowserClientEnvironment,
  type GatewayClientEnvironment,
  type RuntimeTimers,
  scheduleInterval,
  type TimeoutHandle,
} from '../client-environment';
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

/**
 * Timers double that never actually schedules anything — `setTimeout` is a
 * no-op returning a sentinel handle, so tests that don't exercise the
 * reconnect-timer path never wait on anything real. Tests that do exercise
 * it build their own controllable timers with {@link createControllableTimers}.
 */
function createInertTimers(): RuntimeTimers {
  return {
    setTimeout: () => 0 as unknown as TimeoutHandle,
    clearTimeout: () => {},
    setInterval: () => {
      throw new Error('createWebSocket does not use timers.setInterval');
    },
    clearInterval: () => {},
    now: () => 0,
  };
}

/**
 * A deterministic, fully controllable `timers.setTimeout`/`clearTimeout`
 * double for the reconnect-timing tests: no real delay is ever waited on —
 * the scheduled callback fires only when the test calls
 * {@link fireScheduledTimeout} explicitly.
 */
function createControllableTimers(): {
  timers: RuntimeTimers;
  fireScheduledTimeout: () => void;
  scheduledDelay: () => number | undefined;
  scheduledCount: () => number;
} {
  let scheduled: { callback: () => void; delay: number | undefined } | undefined;
  let scheduledCount = 0;
  const timers: RuntimeTimers = {
    setTimeout: (callback, milliseconds) => {
      scheduled = { callback, delay: milliseconds };
      scheduledCount += 1;
      return scheduledCount as unknown as TimeoutHandle;
    },
    clearTimeout: () => {
      scheduled = undefined;
    },
    setInterval: () => {
      throw new Error('createWebSocket does not use timers.setInterval');
    },
    clearInterval: () => {},
    now: () => 0,
  };
  return {
    timers,
    fireScheduledTimeout: () => {
      const pending = scheduled;
      scheduled = undefined;
      pending?.callback();
    },
    scheduledDelay: () => scheduled?.delay,
    scheduledCount: () => scheduledCount,
  };
}

// Bun's `typeof fetch` also requires a static `preconnect` method this stub
// has no use for; the cast documents that this is a deliberate
// call-should-never-happen sentinel, not a real fetch implementation.
const unusedFetch = (() =>
  Promise.reject(new Error('createWebSocket does not use fetch'))) as unknown as typeof fetch;

function createEnvironment(timers: RuntimeTimers = createInertTimers()): GatewayClientEnvironment {
  return {
    fetch: unusedFetch,
    WebSocket: FakeWebSocket as unknown as typeof WebSocket,
    EventSource: FakeEventSource as unknown as typeof EventSource,
    timers,
  };
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  FakeEventSource.instances = [];
  // `buildEventStreamUrl` reads window.location.origin — unrelated to the
  // injected transport environment, so this stays a direct global stub.
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { location: { origin: 'http://localhost' } },
  });
});

afterEach(() => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: originalWindow,
  });
});

describe('createWebSocket', () => {
  it('starts disconnected and connects on start()', () => {
    const store = createWebSocket({
      url: '/ws',
      eventStreamUrl: '/api/v1/events',
      environment: createEnvironment(),
    });
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
      environment: createEnvironment(),
    });
    store.start();
    expect(lastSocket().url).toBe('/ws?token=secret');
    store.stop();
  });

  it('flushes pending subscriptions when the socket opens', () => {
    const store = createWebSocket({
      url: '/ws',
      eventStreamUrl: '/api/v1/events',
      environment: createEnvironment(),
    });
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
    const store = createWebSocket({
      url: '/ws',
      eventStreamUrl: '/api/v1/events',
      environment: createEnvironment(),
    });
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
    const store = createWebSocket({
      url: '/ws',
      eventStreamUrl: '/api/v1/events',
      onMessage,
      environment: createEnvironment(),
    });
    store.start();
    lastSocket().open();

    lastSocket().emit('message', { data: JSON.stringify({ type: 'pong' }) });
    expect(onMessage).toHaveBeenCalledWith({ type: 'pong' });

    lastSocket().emit('message', { data: 'not json' });
    expect(onMessage).toHaveBeenCalledTimes(1);
    store.stop();
  });

  it('falls back to the event stream when the socket closes before opening', () => {
    const store = createWebSocket({
      url: '/ws',
      eventStreamUrl: '/api/v1/events',
      environment: createEnvironment(),
    });
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
      environment: createEnvironment(),
    });
    store.start();
    store.subscribe('run-1');
    lastSocket().fireClose();

    expect(lastSource().url).toBe('http://localhost/api/v1/events?token=tok&runId=run-1');
    store.stop();
  });

  it('schedules a reconnect after an established socket closes, driven deterministically by the injected timers', () => {
    const { timers, fireScheduledTimeout, scheduledDelay, scheduledCount } =
      createControllableTimers();

    const store = createWebSocket({
      url: '/ws',
      eventStreamUrl: '/api/v1/events',
      reconnectInterval: 1234,
      environment: createEnvironment(timers),
    });
    store.start();
    lastSocket().open();
    expect(store.status).toBe('connected');

    lastSocket().fireClose();
    expect(store.status).toBe('disconnected');
    expect(scheduledCount()).toBe(1);
    expect(scheduledDelay()).toBe(1234);

    // Firing the scheduled reconnect opens a fresh socket — no real timer
    // was ever waited on to reach this point.
    const before = FakeWebSocket.instances.length;
    fireScheduledTimeout();
    expect(FakeWebSocket.instances.length).toBe(before + 1);

    store.stop();
  });

  it('does not reconnect or change status after stop()', () => {
    const store = createWebSocket({
      url: '/ws',
      eventStreamUrl: '/api/v1/events',
      environment: createEnvironment(),
    });
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
    const store = createWebSocket({
      url: '/ws',
      eventStreamUrl: '/api/v1/events',
      environment: createEnvironment(),
    });
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
    const { timers, fireScheduledTimeout } = createControllableTimers();

    const store = createWebSocket({
      url: '/ws',
      eventStreamUrl: '/api/v1/events',
      environment: createEnvironment(timers),
    });
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
    lastSocket().fireClose();
    fireScheduledTimeout();
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

    store.stop();
  });
});

describe('createBrowserClientEnvironment', () => {
  it('wires fetch, WebSocket, and EventSource straight to the real globals', () => {
    const environment = createBrowserClientEnvironment();
    expect(environment.fetch).toBe(globalThis.fetch);
    expect(environment.WebSocket).toBe(globalThis.WebSocket);
    expect(environment.EventSource).toBe(globalThis.EventSource);
  });

  it('wires timers.setTimeout/clearTimeout and timers.setInterval/clearInterval to the real global timer functions', () => {
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const originalSetInterval = globalThis.setInterval;
    const originalClearInterval = globalThis.clearInterval;
    const setTimeoutSpy = mock((callback: () => void, ms?: number) =>
      originalSetTimeout(callback, ms),
    );
    const clearTimeoutSpy = mock((handle: ReturnType<typeof globalThis.setTimeout>) =>
      originalClearTimeout(handle),
    );
    const setIntervalSpy = mock((callback: () => void, ms?: number) =>
      originalSetInterval(callback, ms),
    );
    const clearIntervalSpy = mock((handle: ReturnType<typeof globalThis.setInterval>) =>
      originalClearInterval(handle),
    );
    globalThis.setTimeout = setTimeoutSpy as unknown as typeof globalThis.setTimeout;
    globalThis.clearTimeout = clearTimeoutSpy as unknown as typeof globalThis.clearTimeout;
    globalThis.setInterval = setIntervalSpy as unknown as typeof globalThis.setInterval;
    globalThis.clearInterval = clearIntervalSpy as unknown as typeof globalThis.clearInterval;

    try {
      const environment = createBrowserClientEnvironment();
      // Scheduled and cleared in the same tick — no real delay is ever
      // waited on to reach these assertions.
      const timeoutHandle = environment.timers.setTimeout(() => {}, 10);
      environment.timers.clearTimeout(timeoutHandle);
      const intervalHandle = environment.timers.setInterval(() => {}, 10);
      environment.timers.clearInterval(intervalHandle);

      expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
      expect(setTimeoutSpy.mock.calls[0]?.[1]).toBe(10);
      expect(clearTimeoutSpy).toHaveBeenCalledWith(timeoutHandle);
      expect(setIntervalSpy).toHaveBeenCalledTimes(1);
      expect(setIntervalSpy.mock.calls[0]?.[1]).toBe(10);
      expect(clearIntervalSpy).toHaveBeenCalledWith(intervalHandle);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
      globalThis.setInterval = originalSetInterval;
      globalThis.clearInterval = originalClearInterval;
    }
  });

  it('reads the current wall-clock time from Date.now()', () => {
    const environment = createBrowserClientEnvironment();
    const before = Date.now();
    const reading = environment.timers.now();
    const after = Date.now();
    expect(reading).toBeGreaterThanOrEqual(before);
    expect(reading).toBeLessThanOrEqual(after);
  });
});

describe('scheduleInterval / clearScheduledInterval', () => {
  it('forwards to timers.setInterval and timers.clearInterval', () => {
    let capturedDelay: number | undefined;
    let cleared: unknown;
    const timers: RuntimeTimers = {
      setTimeout: () => {
        throw new Error('not used by this test');
      },
      clearTimeout: () => {},
      setInterval: (_callback, milliseconds) => {
        capturedDelay = milliseconds;
        return 7 as unknown as TimeoutHandle;
      },
      clearInterval: (handle) => {
        cleared = handle;
      },
      now: () => 0,
    };
    const environment = createEnvironment(timers);

    const handle = scheduleInterval(environment, () => {}, 500);
    expect(capturedDelay).toBe(500);
    expect(handle).toBe(7 as unknown as TimeoutHandle);

    clearScheduledInterval(environment, handle);
    expect(cleared).toBe(7);
  });
});

describe('no global transport assignment', () => {
  it('does not assign to globalThis.fetch, globalThis.WebSocket, or globalThis.EventSource anywhere under packages/gateway/src/ui', () => {
    const uiDirectory = join(dirname(fileURLToPath(import.meta.url)), '..');
    const forbiddenAssignment = /(globalThis|global)\.(fetch|WebSocket|EventSource)\s*=/;
    const offenders: string[] = [];
    const scanned: string[] = [];

    function walk(directory: string): void {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const fullPath = join(directory, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath);
          continue;
        }
        if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.svelte')) continue;
        scanned.push(fullPath);
        const contents = readFileSync(fullPath, 'utf-8');
        if (forbiddenAssignment.test(contents)) {
          offenders.push(fullPath);
        }
      }
    }

    walk(uiDirectory);

    // Guard against a vacuous pass: prove the walk actually found the five
    // hook test files (and this file itself) before trusting an empty
    // `offenders` list.
    const scannedBasenames = scanned.map((path) => path.split('/').pop());
    for (const expectedFile of [
      'use-chat.svelte.test.ts',
      'use-reviews.svelte.test.ts',
      'use-run-detail.svelte.test.ts',
      'use-runs.svelte.test.ts',
      'use-websocket.svelte.test.ts',
    ]) {
      expect(scannedBasenames).toContain(expectedFile);
    }

    expect(offenders).toEqual([]);
  });
});
