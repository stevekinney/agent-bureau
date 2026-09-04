/**
 * Real Gateway awaitable-stop teardown conformance (AB-274 / AB-98's
 * tst-07d slice), exercising AB-235's shipped bounded drain and force-close
 * rather than reimplementing it: real SSE and WebSocket clients are left
 * OPEN through `stop()` (never pre-closed, unlike the existing
 * `transport.test.ts` "leaves the connection registry ... clean" scenario,
 * which closes its clients before calling `stop()` and so never exercises
 * the drain path itself) so this suite actually proves the drain-then-
 * teardown sequence.
 */
import { createAgent } from '@lostgradient/operative';
import { describe, expect, it } from 'bun:test';

import { startLoopbackGateway } from '../test/loopback';

function immediateGenerate(content = 'ok') {
  return async () => ({ content, toolCalls: [] });
}

describe('Gateway awaitable-stop teardown conformance', () => {
  it('LoopbackGateway.stop() drains open SSE and WebSocket connections and, once it resolves, every teardown surface is clean', async () => {
    const gateway = await startLoopbackGateway({
      agents: { echo: createAgent({ name: 'echo', generate: immediateGenerate() }) },
      generate: immediateGenerate(),
    });
    const { url } = gateway;

    const sse = await gateway.openEventStream('/api/v1/events', {
      headers: { authorization: `Bearer ${gateway.authToken}` },
    });
    const ws = await gateway.openWebSocket(`/ws?token=${gateway.authToken}`);

    // Public evidence, BEFORE stop: AB-219's `/ready` connection accounting
    // through `live-events.ts`'s own subscriber registry — the "every
    // 'connection'-kind leak is discovered through the gateway's public
    // subscriber accounting" surface the acceptance criteria name — proves
    // both real clients are actually registered, so the drain below has
    // something real to drain.
    const beforeReadyResponse = await gateway.fetch('/api/v1/health/ready', {
      headers: { authorization: `Bearer ${gateway.authToken}` },
    });
    const beforeReady = (await beforeReadyResponse.json()) as {
      subsystems: { connections: { total: number } };
    };
    expect(beforeReady.subsystems.connections.total).toBeGreaterThanOrEqual(2);

    // Neither client is closed here — `stop()` itself must drain them.
    const { gateway: gatewayReport, bureau: bureauReport } = await gateway.stop();

    // AB-235: a clean, bounded drain — every connection closed via the
    // subscriber registry's own `closeConnection`, never a forced close on
    // an ordinary shutdown with no lingering client.
    expect(gatewayReport.drained).toBe(true);
    expect(gatewayReport.forcedConnections).toBe(0);

    // Both real clients observe their own connection actually ending —
    // never a private read, the transport's own public completion signal.
    const sseFrameAfterStop = await sse.next();
    expect(sseFrameAfterStop).toBeUndefined();
    const wsClose = await ws.waitForClose();
    expect(wsClose).toBeDefined();

    // The listening port is released: a fresh connection refuses.
    let refused = false;
    try {
      await fetch(`${url}/api/v1/health/live`);
    } catch {
      refused = true;
    }
    expect(refused).toBe(true);

    // No `RuntimeServices.timers` handle remains — the SSE heartbeat
    // interval and every connection watchdog (AB-219/AB-303) route through
    // this same manual runtime, so a leaked timer shows up here directly,
    // publicly, with no private field read.
    expect(gateway.runtime.pendingTimers()).toEqual([]);

    // The Bureau quiescence report (AB-207/AB-256's `BureauShutdownReport`)
    // is empty or names only deliberately detached work — read AFTER
    // `stop()` has already resolved, from the report `stop()` itself
    // returned, never a second call chasing an already-idempotent result.
    for (const owner of bureauReport.owners) {
      expect(owner.outcome).not.toBe('failed');
      expect(owner.outcome).not.toBe('unresolved');
    }
  });

  it('LoopbackGateway.stop() is idempotent and safe to await a second time', async () => {
    const gateway = await startLoopbackGateway({
      agents: { echo: createAgent({ name: 'echo', generate: immediateGenerate() }) },
      generate: immediateGenerate(),
    });

    const first = await gateway.stop();
    expect(first.gateway.drained).toBe(true);

    const second = await gateway.stop();
    expect(second.gateway.drained).toBe(true);
    expect(second.gateway.forcedConnections).toBe(0);
  });
});
