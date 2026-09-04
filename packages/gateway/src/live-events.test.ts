import type { GenerateFunction } from '@lostgradient/operative';
import type { DurableEventEnvelope, DurableEventOwner } from '@lostgradient/operative/durable';
import { LIVENESS_POLICY_VERSION, type Subscription } from '@lostgradient/operative/liveness';
import { describe, expect, it } from 'bun:test';
import type { RunEventRecord } from 'bureau';
import { createBureau } from 'bureau';
import { waitForRunState } from 'bureau/test';

import type { LiveFrameBrokerDurableEventHistory } from './live-events';
import { LiveFrameBroker, projectRunEventForPrivilege } from './live-events';
import { createManualLiveFrameBrokerClock } from './test';
import type { ServerFrame } from './types';
import { createWebSocketHandler } from './websocket/handler';

// AB-316: `createRunFrame()` and `createResponseValidatedFrame()` are each
// invoked twice per assertion in some tests below (once for the broadcast
// frame, once for the expected value via `toEqual`), so a `Date.now()`
// timestamp raced the wall clock ticking between the two calls (reproduced
// 1 in 3 locally, seen in CI on AB-274, AB-315, AB-301). Backing the
// `timestamp` field with this manual, non-advancing clock instead of
// `Date.now()` makes repeat calls agree deterministically.
const frameClock = createManualLiveFrameBrokerClock();

function createRunFrame(runSeq = 1): ServerFrame {
  return {
    type: 'event',
    runId: 'run-1',
    event: 'run.completed',
    detail: { content: 'Done.' },
    sequence: runSeq,
    runSeq,
    timestamp: frameClock.now(),
  };
}

const RAW_SECRET = 'sk-real-secret-do-not-leak';

function createResponseValidatedFrame(runSeq = 1): ServerFrame {
  return {
    type: 'event',
    runId: 'run-1',
    event: 'response.validated',
    detail: {
      step: 0,
      original: { content: RAW_SECRET, toolCalls: [] },
      validated: { content: '[redacted]', toolCalls: [] },
    },
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

  it('stops routing frames for a run after unsubscribe()', () => {
    const broker = new LiveFrameBroker();
    const received: ServerFrame[] = [];
    const key = {};

    broker.addSubscriber(key, (frame) => received.push(frame), { runIds: ['run-1'] });
    broker.broadcast(createRunFrame(1));
    expect(received).toHaveLength(1);

    broker.unsubscribe(key, 'run-1');
    broker.broadcast(createRunFrame(2));
    expect(received).toHaveLength(1);
  });

  it('is a no-op for unsubscribe() on a key that is not a tracked subscriber', () => {
    const broker = new LiveFrameBroker();
    expect(() => broker.unsubscribe({}, 'run-1')).not.toThrow();
  });

  it('drops a run replay buffer via clearRunBuffer()', () => {
    const broker = new LiveFrameBroker();
    broker.broadcast(createRunFrame(1));
    expect(broker.getFramesSince('run-1', 0)).toHaveLength(1);

    broker.clearRunBuffer('run-1');
    expect(broker.getFramesSince('run-1', 0)).toHaveLength(0);
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

describe('LiveFrameBroker — AB-305 response.validated wire projection', () => {
  it('broadcasts the redaction marker in place of "original" to a non-privileged subscriber', () => {
    const broker = new LiveFrameBroker();
    const received: ServerFrame[] = [];
    broker.addSubscriber({}, (frame) => received.push(frame), { runIds: ['run-1'] });

    broker.broadcast(createResponseValidatedFrame());

    expect(received).toHaveLength(1);
    const frame = received[0];
    expect(frame?.type).toBe('event');
    expect(JSON.stringify(frame)).not.toContain(RAW_SECRET);
    if (frame?.type === 'event') {
      expect(frame.detail).toEqual({
        step: 0,
        original: { content: '[redacted]', toolCalls: [] },
        validated: { content: '[redacted]', toolCalls: [] },
      });
    }
  });

  it('broadcasts the full "original" unredacted to a privileged subscriber', () => {
    const broker = new LiveFrameBroker();
    const received: ServerFrame[] = [];
    broker.addSubscriber({}, (frame) => received.push(frame), {
      runIds: ['run-1'],
      privileged: true,
    });

    broker.broadcast(createResponseValidatedFrame());

    expect(received).toHaveLength(1);
    const frame = received[0];
    expect(frame?.type).toBe('event');
    if (frame?.type === 'event') {
      expect(frame.detail).toEqual({
        step: 0,
        original: { content: RAW_SECRET, toolCalls: [] },
        validated: { content: '[redacted]', toolCalls: [] },
      });
    }
  });

  it('leaves a non-"response.validated" event frame untouched for a non-privileged subscriber', () => {
    const broker = new LiveFrameBroker();
    const received: ServerFrame[] = [];
    broker.addSubscriber({}, (frame) => received.push(frame), { runIds: ['run-1'] });

    broker.broadcast(createRunFrame());

    expect(received).toEqual([createRunFrame()]);
  });

  it('leaves a "response.validated" frame with a malformed detail untouched rather than throwing', () => {
    const broker = new LiveFrameBroker();
    const received: ServerFrame[] = [];
    broker.addSubscriber({}, (frame) => received.push(frame), { runIds: ['run-1'] });
    const malformed: ServerFrame = {
      type: 'event',
      runId: 'run-1',
      event: 'response.validated',
      detail: 'not an object',
      sequence: 1,
      runSeq: 1,
      timestamp: Date.now(),
    };

    expect(() => broker.broadcast(malformed)).not.toThrow();
    expect(received).toEqual([malformed]);
  });

  it('defaults an unspecified subscriber to non-privileged (redaction is the default)', () => {
    const broker = new LiveFrameBroker();
    const received: ServerFrame[] = [];
    // No `privileged` option at all.
    broker.addSubscriber({}, (frame) => received.push(frame), { runIds: ['run-1'] });

    broker.broadcast(createResponseValidatedFrame());

    expect(JSON.stringify(received)).not.toContain(RAW_SECRET);
  });

  it("projects a buffered frame returned by subscribe() per that subscriber's own privilege", () => {
    const broker = new LiveFrameBroker();
    broker.broadcast(createResponseValidatedFrame());

    const nonPrivilegedKey = {};
    broker.addSubscriber(nonPrivilegedKey, () => undefined);
    const nonPrivilegedReplay = broker.subscribe(nonPrivilegedKey, 'run-1', 0);
    expect(JSON.stringify(nonPrivilegedReplay)).not.toContain(RAW_SECRET);

    const privilegedKey = {};
    broker.addSubscriber(privilegedKey, () => undefined, { privileged: true });
    const privilegedReplay = broker.subscribe(privilegedKey, 'run-1', 0);
    expect(JSON.stringify(privilegedReplay)).toContain(RAW_SECRET);
  });

  it('returns an empty replay for a key that was never a tracked subscriber, without throwing', () => {
    const broker = new LiveFrameBroker();
    broker.broadcast(createResponseValidatedFrame());

    expect(broker.subscribe({}, 'run-1', 0)).toEqual([]);
  });

  it('projects an SSE reconnect replay for a non-privileged connection, and leaves it unredacted for a privileged one', async () => {
    const broker = new LiveFrameBroker();
    broker.broadcast(createResponseValidatedFrame());

    const nonPrivilegedRequest = new Request(
      'http://example.test/api/v1/events?runId=run-1&since=run-1:0',
    );
    const nonPrivilegedResponse = broker.createEventStreamResponse(nonPrivilegedRequest, {
      runIds: ['run-1'],
    });
    const nonPrivilegedReader = nonPrivilegedResponse.body?.getReader();
    expect(nonPrivilegedReader).toBeDefined();
    if (nonPrivilegedReader) {
      const chunk = await nonPrivilegedReader.read();
      const text = new TextDecoder().decode(chunk.value);
      expect(text).not.toContain(RAW_SECRET);
      await nonPrivilegedReader.cancel();
    }

    const privilegedRequest = new Request(
      'http://example.test/api/v1/events?runId=run-1&since=run-1:0',
    );
    const privilegedResponse = broker.createEventStreamResponse(privilegedRequest, {
      runIds: ['run-1'],
      privileged: true,
    });
    const privilegedReader = privilegedResponse.body?.getReader();
    expect(privilegedReader).toBeDefined();
    if (privilegedReader) {
      const chunk = await privilegedReader.read();
      const text = new TextDecoder().decode(chunk.value);
      expect(text).toContain(RAW_SECRET);
      await privilegedReader.cancel();
    }
  });
});

describe('projectRunEventForPrivilege — AB-323 REST run-detail projection', () => {
  function createRunEventRecord(overrides: Partial<RunEventRecord> = {}): RunEventRecord {
    return {
      sequence: 1,
      runId: 'run-1',
      event: 'response.validated',
      detail: { step: 0, original: { content: RAW_SECRET, toolCalls: [] }, validated: {} },
      timestamp: Date.now(),
      ...overrides,
    };
  }

  it('replaces "original" with the redaction marker for a non-privileged caller', () => {
    const projected = projectRunEventForPrivilege(createRunEventRecord(), false);

    expect(JSON.stringify(projected)).not.toContain(RAW_SECRET);
    expect(projected.detail).toEqual({
      step: 0,
      original: { content: '[redacted]', toolCalls: [] },
      validated: {},
    });
  });

  it('leaves "original" unredacted for a privileged caller', () => {
    const event = createRunEventRecord();
    const projected = projectRunEventForPrivilege(event, true);

    expect(projected).toBe(event);
    expect(JSON.stringify(projected)).toContain(RAW_SECRET);
  });

  it('leaves a non-"response.validated" event untouched regardless of privilege', () => {
    const event = createRunEventRecord({ event: 'run.completed', detail: { ok: true } });

    expect(projectRunEventForPrivilege(event, false)).toBe(event);
    expect(projectRunEventForPrivilege(event, true)).toBe(event);
  });

  it('leaves a "response.validated" event with a malformed detail untouched rather than throwing', () => {
    const event = createRunEventRecord({ detail: 'not an object' });

    expect(() => projectRunEventForPrivilege(event, false)).not.toThrow();
    expect(projectRunEventForPrivilege(event, false)).toBe(event);
  });
});

describe('LiveFrameBroker — AB-235 shutdown drain', () => {
  it('reports zero subscribers when none are registered', () => {
    const broker = new LiveFrameBroker();
    expect(broker.subscriberCount).toBe(0);
  });

  it('counts every registered subscriber regardless of transport', () => {
    const broker = new LiveFrameBroker();
    broker.addSubscriber({}, () => undefined, { runIds: ['run-1'] });
    broker.addSubscriber({}, () => undefined, { runIds: ['run-2'] });
    expect(broker.subscriberCount).toBe(2);
  });

  it('invokes each subscriber registered closeConnection callback', () => {
    const broker = new LiveFrameBroker();
    let firstClosed = false;
    let secondClosed = false;

    broker.addSubscriber({}, () => undefined, {
      runIds: ['run-1'],
      closeConnection: () => {
        firstClosed = true;
      },
    });
    broker.addSubscriber({}, () => undefined, {
      runIds: ['run-2'],
      closeConnection: () => {
        secondClosed = true;
      },
    });

    broker.closeAll();

    expect(firstClosed).toBe(true);
    expect(secondClosed).toBe(true);
  });

  it('does not throw when a subscriber has no closeConnection callback', () => {
    const broker = new LiveFrameBroker();
    broker.addSubscriber({}, () => undefined, { runIds: ['run-1'] });
    expect(() => broker.closeAll()).not.toThrow();
  });

  it('closes every remaining subscriber even when an earlier one throws on close', () => {
    const broker = new LiveFrameBroker();
    let secondClosed = false;

    broker.addSubscriber({}, () => undefined, {
      runIds: ['run-1'],
      closeConnection: () => {
        throw new Error('transport already gone');
      },
    });
    broker.addSubscriber({}, () => undefined, {
      runIds: ['run-2'],
      closeConnection: () => {
        secondClosed = true;
      },
    });

    expect(() => broker.closeAll()).not.toThrow();
    expect(secondClosed).toBe(true);
  });

  it('immediately closes a subscriber that registers after closeAll() has run', () => {
    const broker = new LiveFrameBroker();
    broker.closeAll();

    let closedImmediately = false;
    broker.addSubscriber({}, () => undefined, {
      runIds: ['run-1'],
      closeConnection: () => {
        closedImmediately = true;
      },
    });

    expect(closedImmediately).toBe(true);
  });

  it('closes the underlying SSE stream for a subscriber created via createEventStreamResponse', async () => {
    const broker = new LiveFrameBroker();
    const request = new Request('http://example.test/api/v1/events');
    const response = broker.createEventStreamResponse(request, { heartbeatIntervalMs: 60_000 });

    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    if (!reader) return;

    // Consume the initial ': connected' comment so the subscriber is fully
    // registered before we ask the broker to close everything.
    await reader.read();
    expect(broker.subscriberCount).toBe(1);

    broker.closeAll();

    // closeAll() ends the stream; the next read reports the stream as done.
    const next = await reader.read();
    expect(next.done).toBe(true);
  });

  it('immediately ends an SSE stream created after closeAll() (a late in-flight request)', async () => {
    const broker = new LiveFrameBroker();
    broker.closeAll();

    // Simulates an /api/v1/events request that was already in-flight
    // through async auth/rate-limiting when stop() called closeAll() —
    // it only registers its subscriber now, after shutdown began.
    const request = new Request('http://example.test/api/v1/events');
    const response = broker.createEventStreamResponse(request, { heartbeatIntervalMs: 60_000 });

    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    if (!reader) return;

    // Even the initial ': connected' comment must not hold the stream
    // open past shutdown — it is closed immediately rather than waiting
    // out the rest of the drain timeout.
    const first = await reader.read();
    expect(first.done).toBe(true);
  });
});

describe('gateway-connection watchdog (AB-219)', () => {
  it('classifies a connection against its own heartbeatIntervalMs, never the 8000ms default', () => {
    const clock = createManualLiveFrameBrokerClock();
    const broker = new LiveFrameBroker({ clock });

    const defaultCadenceKey = {};
    const longCadenceKey = {};
    broker.addSubscriber(defaultCadenceKey, () => {});
    broker.addSubscriber(longCadenceKey, () => {}, { heartbeatIntervalMs: 20_000 });

    // 13000ms crosses the default row's own check interval
    // (8000 + 4000 + 800 = 12800ms) but is nowhere near the long-cadence
    // connection's (20000 + 10000 + 2000 = 32000ms). Neither connection
    // ever recorded a pulse, so a connection classified against the fixed
    // 8000ms default would show a missed pulse here regardless of its own
    // configured cadence — the long-cadence connection must not.
    clock.advance(13_000);

    const defaultSnapshot = broker.getConnectionRegistry().get(defaultCadenceKey)?.snapshot();
    const longCadenceSnapshot = broker.getConnectionRegistry().get(longCadenceKey)?.snapshot();

    expect(defaultSnapshot?.missedPulseCount).toBeGreaterThan(0);
    expect(longCadenceSnapshot?.missedPulseCount).toBe(0);
  });

  it('never resolves reachability to reachable from transport-keepalive pulses alone', () => {
    const clock = createManualLiveFrameBrokerClock();
    const broker = new LiveFrameBroker({ clock });
    const key = {};
    broker.addSubscriber(key, () => {}, { heartbeatIntervalMs: 8_000 });

    // Simulate several on-time SSE `: heartbeat` writes — exactly the
    // evidence the generic createStallWatchdog() would otherwise treat as
    // "reachable" (missedPulseCount stays 0).
    for (let tick = 0; tick < 3; tick += 1) {
      clock.advance(8_000);
      broker.recordTransportKeepalive(key);
    }

    const snapshot = broker.getConnectionRegistry().get(key)?.snapshot();
    expect(snapshot?.missedPulseCount).toBe(0);
    expect(snapshot?.reachability).toBe('unknown');
    expect(snapshot?.progress).toBe('unknown');
    expect(snapshot?.evidence.every((entry) => entry.source === 'transport-keepalive')).toBe(true);
  });

  it('still classifies late/unreachable from missed transport-keepalive pulses (decay passes through unclamped)', () => {
    const clock = createManualLiveFrameBrokerClock();
    const broker = new LiveFrameBroker({ clock });
    const key = {};
    broker.addSubscriber(key, () => {}, { heartbeatIntervalMs: 8_000 });

    // checkIntervalMs = 8000 + 4000 + 800 = 12800; missedPulseThreshold: 2.
    clock.advance(12_800);
    expect(broker.getConnectionRegistry().get(key)?.snapshot().reachability).toBe('late');

    clock.advance(12_800);
    expect(broker.getConnectionRegistry().get(key)?.snapshot().reachability).toBe('unreachable');
    expect(broker.getConnectionRegistry().get(key)?.snapshot().assessment).toBe('unreachable');
  });

  it('exposes the subscribers map through getConnectionRegistry(), not a duplicate registry', () => {
    const clock = createManualLiveFrameBrokerClock();
    const broker = new LiveFrameBroker({ clock });
    expect(broker.getConnectionRegistry().size).toBe(0);

    const key = {};
    broker.addSubscriber(key, () => {});
    expect(broker.getConnectionRegistry().size).toBe(1);
    expect(broker.getConnectionRegistry().has(key)).toBe(true);

    broker.removeSubscriber(key);
    expect(broker.getConnectionRegistry().size).toBe(0);
  });

  it('disposes the connection watchdog (no leaked timers) on removeSubscriber', () => {
    const clock = createManualLiveFrameBrokerClock();
    const broker = new LiveFrameBroker({ clock });
    const key = {};
    broker.addSubscriber(key, () => {});
    expect(clock.pendingTimerCount()).toBe(1);

    broker.removeSubscriber(key);
    expect(clock.pendingTimerCount()).toBe(0);
  });

  it('produces a distinct, stable connection id per subscriber', () => {
    const clock = createManualLiveFrameBrokerClock();
    const broker = new LiveFrameBroker({ clock });
    const keyA = {};
    const keyB = {};
    broker.addSubscriber(keyA, () => {});
    broker.addSubscriber(keyB, () => {});

    const idA = broker.getConnectionRegistry().get(keyA)?.snapshot().id;
    const idB = broker.getConnectionRegistry().get(keyB)?.snapshot().id;
    expect(idA).toBeDefined();
    expect(idB).toBeDefined();
    expect(idA).not.toBe(idB);
    expect(broker.getConnectionRegistry().get(keyA)?.snapshot().id).toBe(idA);
  });

  it('advances revision on a fresh keepalive pulse', () => {
    const clock = createManualLiveFrameBrokerClock();
    const broker = new LiveFrameBroker({ clock });
    const key = {};
    broker.addSubscriber(key, () => {}, { heartbeatIntervalMs: 8_000 });

    const initialRevision = broker.getConnectionRegistry().get(key)?.snapshot().revision;
    expect(initialRevision).toBe(0);

    broker.recordTransportKeepalive(key);
    const afterPulse = broker.getConnectionRegistry().get(key)?.snapshot().revision;
    expect(afterPulse).toBeGreaterThan(initialRevision ?? -1);
  });

  it('advances revision on a timer-driven missed-pulse check (onAssessmentChange), with no pulse recorded', () => {
    const clock = createManualLiveFrameBrokerClock();
    const broker = new LiveFrameBroker({ clock });
    const key = {};
    broker.addSubscriber(key, () => {}, { heartbeatIntervalMs: 8_000 });

    const initialRevision = broker.getConnectionRegistry().get(key)?.snapshot().revision;
    expect(initialRevision).toBe(0);

    // checkIntervalMs = 8000 + 4000 + 800 = 12800 — no pulse was ever
    // recorded, so this check genuinely changes missedPulseCount (0 -> 1),
    // which is what drives createStallWatchdog's onAssessmentChange.
    clock.advance(12_800);
    const afterMiss = broker.getConnectionRegistry().get(key)?.snapshot().revision;
    expect(afterMiss).toBeGreaterThan(initialRevision ?? -1);
  });

  it('records a WebSocket pong as transport-keepalive evidence via recordTransportKeepalive', () => {
    const clock = createManualLiveFrameBrokerClock();
    const broker = new LiveFrameBroker({ clock });
    const key = {};
    broker.addSubscriber(key, () => {});

    broker.recordTransportKeepalive(key);

    const snapshot = broker.getConnectionRegistry().get(key)?.snapshot();
    expect(snapshot?.evidence).toHaveLength(1);
    expect(snapshot?.evidence[0]?.source).toBe('transport-keepalive');
  });

  it('is a no-op for a key that is not (or is no longer) a tracked subscriber', () => {
    const clock = createManualLiveFrameBrokerClock();
    const broker = new LiveFrameBroker({ clock });
    expect(() => broker.recordTransportKeepalive({})).not.toThrow();
  });

  it('the SSE heartbeat write records a transport-keepalive pulse through the real createEventStreamResponse path', async () => {
    const clock = createManualLiveFrameBrokerClock();
    const broker = new LiveFrameBroker({ clock });
    const request = new Request('http://example.test/api/v1/events');
    const response = broker.createEventStreamResponse(request, { heartbeatIntervalMs: 8_000 });

    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    if (!reader) return;

    await reader.read(); // ': connected'
    clock.advance(8_000); // one heartbeat tick

    const [key] = [...broker.getConnectionRegistry().keys()];
    expect(key).toBeDefined();
    if (!key) return;
    const snapshot = broker.getConnectionRegistry().get(key)?.snapshot();
    expect(snapshot?.evidence).toHaveLength(1);
    expect(snapshot?.evidence[0]?.source).toBe('transport-keepalive');

    await reader.cancel();
  });

  it('policyVersion matches obs-01 LIVENESS_POLICY_VERSION and kind is gateway-connection', () => {
    const clock = createManualLiveFrameBrokerClock();
    const broker = new LiveFrameBroker({ clock });
    const key = {};
    broker.addSubscriber(key, () => {});
    const snapshot = broker.getConnectionRegistry().get(key)?.snapshot();
    expect(snapshot?.kind).toBe('gateway-connection');
    expect(snapshot?.policyVersion).toBe(LIVENESS_POLICY_VERSION);
  });
});

// AB-212 AC3 — the detached-run branch: an SSE disconnect on
// `GET /api/v1/events` has never touched the run it was watching (only
// `removeSubscriber` runs, per `createEventStreamResponse`'s `close()`
// above); this is regression coverage over the real route + a real run
// proving that stays true, and that the buffer it keeps accumulating after
// the disconnect is exactly what a `Last-Event-ID`/`since` reconnect replays
// from.
describe('detached run: an SSE disconnect never touches the run (AB-212)', () => {
  it('the run reaches completed after the client disconnects, and a reconnect replays the run.completed frame the buffer kept', async () => {
    // Wired exactly as `create-gateway.ts` wires bureau + broker together
    // (see `reconnect-replay.test.ts`'s module doc for the same rationale):
    // a real `Bureau` and a real `LiveFrameBroker`, connected through
    // `subscribeLiveFrames`/`broadcast`, rather than a bureau stub. No
    // `stopWhen` is configured, so — matching `createMockGenerate`'s use
    // elsewhere in this package — `generate` must resolve immediately on
    // every call: the loop runs to `maximumSteps` regardless of `toolCalls`
    // when no stop condition is set, so a manually-gated generate that only
    // releases once would hang on step 1's call.
    const generate: GenerateFunction = async () => ({ content: 'Done.', toolCalls: [] });

    const bureau = await createBureau({ agents: {}, generate });
    const broker = new LiveFrameBroker();
    const unsubscribe = bureau.subscribeLiveFrames((frame) => broker.broadcast(frame));

    try {
      const summary = await bureau.createRun({ message: 'Hello' });
      const runId = summary.id;
      expect(bureau.getRun(runId)?.status).toBe('running');

      // Open a real SSE subscription for this run.
      const request = new Request(`http://example.test/api/v1/events?runId=${runId}`);
      const response = broker.createEventStreamResponse(request, { runIds: [runId] });
      const reader = response.body?.getReader();
      expect(reader).toBeDefined();
      if (!reader) return;
      // Consume the initial ": connected" comment so the subscriber is fully
      // registered before disconnecting.
      await reader.read();
      expect(broker.getSubscriberCount(runId)).toBe(1);

      // The client disconnects while the run is (still, per the assertion
      // above) running — this must remove ONLY the subscriber.
      await reader.cancel();
      expect(broker.getSubscriberCount(runId)).toBe(0);
      expect(bureau.getRun(runId)?.status).toBe('running');

      // The run keeps going after the disconnect — the SSE teardown never
      // touched it — and reaches "completed" on its own.
      await waitForRunState(bureau, runId, (run) => run.status === 'completed');

      // The buffer kept accumulating after the disconnect: it now holds
      // every frame the run emitted, including ones broadcast while nobody
      // was subscribed at all (between the disconnect and this point).
      const bufferedFrames = broker.getFramesSince(runId, 0);
      expect(bufferedFrames.length).toBeGreaterThan(0);
      const lastRunSeq = Math.max(
        ...bufferedFrames.map((frame) => ('runSeq' in frame ? frame.runSeq : 0)),
      );

      // A real reconnect with that cursor — the format is `<runId>:<runSeq>`
      // (`encodeCursor`/`decodeCursor` in `live-events.ts`), not a bare
      // number — replays from the SAME buffer over the wire, proving it is
      // reachable through the actual SSE reconnect path, not only through
      // the broker's internal API.
      const reconnectRequest = new Request(
        `http://example.test/api/v1/events?runId=${runId}&since=${encodeURIComponent(runId)}:0`,
      );
      const reconnectResponse = broker.createEventStreamResponse(reconnectRequest, {
        runIds: [runId],
      });
      const reconnectReader = reconnectResponse.body?.getReader();
      expect(reconnectReader).toBeDefined();
      if (!reconnectReader) return;

      // One real frame off the wire, from the very start of the buffer, is
      // enough to prove the reconnect path is live and replaying — the exact
      // frame count/ordering guarantee is AB-15's own regression coverage
      // (`reconnect-replay.test.ts`), not re-proven here.
      const { value, done } = await reconnectReader.read();
      await reconnectReader.cancel();

      expect(done).toBe(false);
      expect(value).toBeDefined();
      const firstChunk = new TextDecoder().decode(value);
      expect(firstChunk).toContain(`id: ${encodeURIComponent(runId)}:1`);
      expect(firstChunk).toContain(runId);

      // And the buffer's own last entry carries the run's terminal
      // `runSeq` — the reconnect a real client performs later would resume
      // from exactly that cursor and see nothing missing.
      expect(lastRunSeq).toBeGreaterThan(0);
    } finally {
      unsubscribe();
      bureau.dispose();
    }
  });
});

// AB-212 AC4 — a WebSocket disconnect follows the same rule through the
// same subscriber mechanism (`packages/gateway/src/websocket/handler.ts`'s
// `close()` calls `broker.removeSubscriber(ws)`, identical to SSE's
// `close()` above) — stated explicitly here rather than duplicated as a
// second full run-lifecycle test.
describe('WebSocket disconnect shares the SSE subscriber-removal mechanism (AB-212 AC4)', () => {
  it('WebSocket handler close() delegates to the same LiveFrameBroker.removeSubscriber() an SSE disconnect uses', () => {
    const broker = new LiveFrameBroker();
    // Exercises the real `createWebSocketHandler` — `open()` then `close()`
    // — rather than calling `broker.removeSubscriber()` directly, so a
    // future change to `close()`'s implementation (not just its current
    // one-line delegation) would still be caught here (Copilot review).
    const handler = createWebSocketHandler({ broker });
    const fakeSocket = { send: () => {} } as unknown as Parameters<typeof handler.open>[0];

    handler.open(fakeSocket);
    expect(broker.subscriberCount).toBe(1);

    handler.close(fakeSocket);
    expect(broker.subscriberCount).toBe(0);
  });
});

function createDurableEnvelope(
  overrides: Partial<DurableEventEnvelope> = {},
): DurableEventEnvelope {
  return {
    kind: 'run.completed',
    owner: { kind: 'run', id: 'run-1' },
    sequence: 1,
    cursor: '1',
    emittedAtMs: 1_000,
    payload: { content: 'done' },
    schemaVersion: 1,
    ...overrides,
  };
}

/**
 * A fake `LiveFrameBrokerDurableEventHistory` (AB-312): delivers every
 * envelope configured for an owner id synchronously, from inside
 * `subscribeEventHistory` itself — sufficient for these unit tests, which
 * exercise the broker's own wiring (what it calls, what it suppresses, what
 * it forwards), not `Bureau.subscribeEventHistory`'s own async timing
 * (covered by `durable-event-history.test.ts` and the conformance suite).
 */
function createFakeDurableEventHistory(envelopesByRunId: Record<string, DurableEventEnvelope[]>) {
  const subscribeCalls: DurableEventOwner[] = [];
  const subscriptions: { owner: DurableEventOwner; closed: boolean }[] = [];

  const history: LiveFrameBrokerDurableEventHistory = {
    subscribeEventHistory(owner, listener) {
      subscribeCalls.push(owner);
      for (const envelope of envelopesByRunId[owner.id] ?? []) {
        listener(envelope);
      }

      const record = { owner, closed: false };
      subscriptions.push(record);
      const subscription: Subscription = {
        unsubscribe: () => {
          record.closed = true;
        },
        get closed() {
          return record.closed;
        },
      };
      return subscription;
    },
  };

  return { history, subscribeCalls, subscriptions };
}

describe('LiveFrameBroker — AB-312 durable-history reconnect fallback', () => {
  it('falls back to durable history when "since" is older than what the buffer holds (buffer empty — e.g. after a restart)', () => {
    const { history, subscribeCalls } = createFakeDurableEventHistory({
      'run-1': [createDurableEnvelope()],
    });
    const broker = new LiveFrameBroker({ durableEventHistory: history });
    const received: ServerFrame[] = [];
    const key = {};

    broker.addSubscriber(key, (frame) => received.push(frame), {});
    const replay = broker.subscribe(key, 'run-1', 5);

    expect(replay).toEqual([]);
    expect(subscribeCalls).toEqual([{ kind: 'run', id: 'run-1' }]);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      type: 'durable-event',
      runId: 'run-1',
      event: 'run.completed',
      detail: { content: 'done' },
      cursor: '1',
    });
    // The durable-event frame carries no `runSeq` — it is not part of the
    // AB-15 in-memory replay cursor space.
    expect(received[0]).not.toHaveProperty('runSeq');
  });

  it('does not fall back when the buffer already covers "since" (today\'s fast path is unchanged)', () => {
    const { history, subscribeCalls } = createFakeDurableEventHistory({});
    const broker = new LiveFrameBroker({ durableEventHistory: history });
    const key = {};

    broker.addSubscriber(key, () => undefined, {});
    broker.broadcast(createRunFrame(1));
    broker.broadcast(createRunFrame(2));

    const replay = broker.subscribe(key, 'run-1', 1);

    expect(subscribeCalls).toEqual([]);
    expect(replay.map((frame) => ('runSeq' in frame ? frame.runSeq : undefined))).toEqual([2]);
  });

  it('falls back when "since" is older than the buffer\'s own floor (evicted, not merely empty)', () => {
    const { history, subscribeCalls } = createFakeDurableEventHistory({ 'run-1': [] });
    const broker = new LiveFrameBroker({ durableEventHistory: history });
    const key = {};

    broker.addSubscriber(key, () => undefined, {});
    // Buffer's oldest frame is runSeq 5 — asking for runSeq > 1 is a gap.
    broker.broadcast(createRunFrame(5));
    broker.broadcast(createRunFrame(6));

    const replay = broker.subscribe(key, 'run-1', 1);

    expect(replay).toEqual([]);
    expect(subscribeCalls).toEqual([{ kind: 'run', id: 'run-1' }]);
  });

  it('suppresses the ordinary live broadcast of a durable action kind for a run in fallback mode, but not other frames', () => {
    const { history } = createFakeDurableEventHistory({ 'run-1': [] });
    const broker = new LiveFrameBroker({ durableEventHistory: history });
    const received: ServerFrame[] = [];
    const key = {};

    broker.addSubscriber(key, (frame) => received.push(frame), {});
    broker.subscribe(key, 'run-1', 5); // gap -> fallback mode for run-1

    broker.broadcast(createRunFrame(6)); // event: 'run.completed' — a durable kind
    broker.broadcast({
      type: 'event',
      runId: 'run-1',
      event: 'step.completed',
      detail: {},
      sequence: 7,
      runSeq: 7,
      timestamp: Date.now(),
    });

    const eventTypes = received.filter((f) => f.type === 'event').map((f) => f.event);
    expect(eventTypes).toEqual(['step.completed']);
  });

  it('does not suppress a durable-kind broadcast for a DIFFERENT run than the one in fallback mode', () => {
    const { history } = createFakeDurableEventHistory({ 'run-1': [] });
    const broker = new LiveFrameBroker({ durableEventHistory: history });
    const received: ServerFrame[] = [];
    const key = {};

    broker.addSubscriber(key, (frame) => received.push(frame), { runIds: ['run-2'] });
    broker.subscribe(key, 'run-1', 5); // gap -> fallback mode for run-1 only

    broker.broadcast({
      type: 'event',
      runId: 'run-2',
      event: 'run.completed',
      detail: {},
      sequence: 1,
      runSeq: 1,
      timestamp: Date.now(),
    });

    expect(received).toHaveLength(1);
  });

  it('degrades gracefully (no throw, still returns []) when no durableEventHistory was configured', () => {
    const broker = new LiveFrameBroker();
    const key = {};

    broker.addSubscriber(key, () => undefined, {});
    expect(() => broker.subscribe(key, 'run-1', 5)).not.toThrow();
    expect(broker.subscribe(key, 'run-1', 5)).toEqual([]);
  });

  it('projects a redacted response.validated durable event for a non-privileged connection (AB-305 applied to the durable path)', () => {
    const secret = 'sk-real-secret-do-not-leak';
    const { history } = createFakeDurableEventHistory({
      'run-1': [
        createDurableEnvelope({
          kind: 'response.validated',
          payload: { step: 0, original: { content: secret, toolCalls: [] }, validated: {} },
        }),
      ],
    });
    const broker = new LiveFrameBroker({ durableEventHistory: history });
    const received: ServerFrame[] = [];
    const key = {};

    broker.addSubscriber(key, (frame) => received.push(frame), { privileged: false });
    broker.subscribe(key, 'run-1', 5);

    const payload = JSON.stringify(received[0]);
    expect(payload).not.toContain(secret);
  });

  it('leaves a response.validated durable event unredacted for a privileged connection', () => {
    const secret = 'sk-real-secret-do-not-leak';
    const { history } = createFakeDurableEventHistory({
      'run-1': [
        createDurableEnvelope({
          kind: 'response.validated',
          payload: { step: 0, original: { content: secret, toolCalls: [] }, validated: {} },
        }),
      ],
    });
    const broker = new LiveFrameBroker({ durableEventHistory: history });
    const received: ServerFrame[] = [];
    const key = {};

    broker.addSubscriber(key, (frame) => received.push(frame), { privileged: true });
    broker.subscribe(key, 'run-1', 5);

    const payload = JSON.stringify(received[0]);
    expect(payload).toContain(secret);
  });

  it('ends the durable subscription on unsubscribe()', () => {
    const { history, subscriptions } = createFakeDurableEventHistory({ 'run-1': [] });
    const broker = new LiveFrameBroker({ durableEventHistory: history });
    const key = {};

    broker.addSubscriber(key, () => undefined, {});
    broker.subscribe(key, 'run-1', 5);
    expect(subscriptions).toHaveLength(1);
    expect(subscriptions[0]?.closed).toBe(false);

    broker.unsubscribe(key, 'run-1');
    expect(subscriptions[0]?.closed).toBe(true);
  });

  it('ends every active durable subscription on removeSubscriber()', () => {
    const { history, subscriptions } = createFakeDurableEventHistory({ 'run-1': [], 'run-2': [] });
    const broker = new LiveFrameBroker({ durableEventHistory: history });
    const key = {};

    broker.addSubscriber(key, () => undefined, {});
    broker.subscribe(key, 'run-1', 5);
    broker.subscribe(key, 'run-2', 5);
    expect(subscriptions).toHaveLength(2);

    broker.removeSubscriber(key);
    expect(subscriptions.every((s) => s.closed)).toBe(true);
  });

  it('is idempotent: a second gap on the same (key, runId) does not open a second durable subscription', () => {
    const { history, subscribeCalls } = createFakeDurableEventHistory({ 'run-1': [] });
    const broker = new LiveFrameBroker({ durableEventHistory: history });
    const key = {};

    broker.addSubscriber(key, () => undefined, {});
    broker.subscribe(key, 'run-1', 5);
    broker.subscribe(key, 'run-1', 5);

    expect(subscribeCalls).toHaveLength(1);
  });

  it('falls back over the SSE reconnect path (createEventStreamResponse) exactly as it does for subscribe()', async () => {
    const { history, subscribeCalls } = createFakeDurableEventHistory({
      'run-1': [createDurableEnvelope()],
    });
    const broker = new LiveFrameBroker({ durableEventHistory: history });

    const request = new Request(
      `http://example.test/api/v1/events?runId=run-1&since=${encodeURIComponent('run-1')}:5`,
    );
    const response = broker.createEventStreamResponse(request, { runIds: ['run-1'] });
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    if (!reader) return;

    const chunk = await reader.read();
    const text = new TextDecoder().decode(chunk.value);
    expect(text).toContain('"type":"durable-event"');
    expect(text).toContain('"event":"run.completed"');
    expect(subscribeCalls).toEqual([{ kind: 'run', id: 'run-1' }]);

    await reader.cancel();
  });
});
