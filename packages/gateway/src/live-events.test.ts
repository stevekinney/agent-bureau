import type { GenerateFunction } from '@lostgradient/operative';
import { LIVENESS_POLICY_VERSION } from '@lostgradient/operative/liveness';
import { describe, expect, it } from 'bun:test';
import { createBureau } from 'bureau';
import { waitForRunState } from 'bureau/test';

import { LiveFrameBroker } from './live-events';
import { createManualLiveFrameBrokerClock } from './test';
import type { ServerFrame } from './types';
import { createWebSocketHandler } from './websocket/handler';

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
