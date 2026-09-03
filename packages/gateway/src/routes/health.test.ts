import type { GenerateFunction } from '@lostgradient/operative';
import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';

import { LiveFrameBroker } from '../live-events';
import { createManualLiveFrameBrokerClock, createTestGateway, requestJSON } from '../test';
import type { Bureau, ReadyResponse } from '../types';
import { createHealthRoutes } from './health';

/**
 * `createHealthRoutes` only reads `bureau.ready` — a minimal stub, matching
 * the `as unknown as Bureau` convention already used elsewhere in this
 * package's tests (see `routes/events.test.ts`), avoids constructing a full
 * `Bureau`.
 */
function createBureauStub(ready: boolean): Bureau {
  return { ready } as unknown as Bureau;
}

describe('health routes', () => {
  it('GET /api/v1/health/live returns 200', async () => {
    const gateway = await createTestGateway();
    const response = await requestJSON(gateway, '/api/v1/health/live');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe('ok');
  });

  it('GET /api/v1/health/ready returns 503 when no generate is configured', async () => {
    const gateway = await createTestGateway();
    const response = await requestJSON(gateway, '/api/v1/health/ready');
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.status).toBe('unavailable');
  });

  it('GET /api/v1/health/ready returns 200 when generate is configured', async () => {
    const generate: GenerateFunction = async () => ({ content: '', toolCalls: [] });
    const gateway = await createTestGateway({ generate });
    const response = await requestJSON(gateway, '/api/v1/health/ready');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe('ok');
  });
});

describe('health routes — /ready named subsystem evidence (AB-219)', () => {
  it('reports subsystems.bureau ok and all-zero connections with no open connections', async () => {
    const broker = new LiveFrameBroker();
    const app = new Hono();
    app.route('/api/v1/health', createHealthRoutes(createBureauStub(true), broker));

    const response = await app.request('/api/v1/health/ready');
    expect(response.status).toBe(200);
    const body = (await response.json()) as ReadyResponse;
    expect(body).toEqual({
      status: 'ok',
      subsystems: { bureau: 'ok', connections: { total: 0, late: 0, unreachable: 0 } },
    });
  });

  it('returns 503 with subsystems.bureau unavailable when bureau is not ready (no regression)', async () => {
    const broker = new LiveFrameBroker();
    const app = new Hono();
    app.route('/api/v1/health', createHealthRoutes(createBureauStub(false), broker));

    const response = await app.request('/api/v1/health/ready');
    expect(response.status).toBe(503);
    const body = (await response.json()) as ReadyResponse;
    expect(body.status).toBe('unavailable');
    expect(body.subsystems.bureau).toBe('unavailable');
  });

  it('returns 200 with status degraded when bureau is ready but a connection is unreachable', async () => {
    const clock = createManualLiveFrameBrokerClock();
    const broker = new LiveFrameBroker({ clock });
    broker.addSubscriber({}, () => {}, { heartbeatIntervalMs: 8_000 });
    // checkIntervalMs = 8000 + 4000 + 800 = 12800; missedPulseThreshold: 2.
    clock.advance(12_800);
    clock.advance(12_800);

    const app = new Hono();
    app.route('/api/v1/health', createHealthRoutes(createBureauStub(true), broker));

    const response = await app.request('/api/v1/health/ready');
    expect(response.status).toBe(200);
    const body = (await response.json()) as ReadyResponse;
    expect(body.status).toBe('degraded');
    expect(body.subsystems.connections).toEqual({ total: 1, late: 0, unreachable: 1 });
  });

  it('counts a late (not yet unreachable) connection without flipping status to degraded', async () => {
    const clock = createManualLiveFrameBrokerClock();
    const broker = new LiveFrameBroker({ clock });
    broker.addSubscriber({}, () => {}, { heartbeatIntervalMs: 8_000 });
    clock.advance(12_800);

    const app = new Hono();
    app.route('/api/v1/health', createHealthRoutes(createBureauStub(true), broker));

    const response = await app.request('/api/v1/health/ready');
    expect(response.status).toBe(200);
    const body = (await response.json()) as ReadyResponse;
    expect(body.status).toBe('ok');
    expect(body.subsystems.connections).toEqual({ total: 1, late: 1, unreachable: 0 });
  });

  it('aggregates multiple connections into the connections subsystem totals', async () => {
    const clock = createManualLiveFrameBrokerClock();
    const broker = new LiveFrameBroker({ clock });
    broker.addSubscriber({}, () => {}, { heartbeatIntervalMs: 8_000 });
    broker.addSubscriber({}, () => {}, { heartbeatIntervalMs: 8_000 });
    const healthyKey = {};
    broker.addSubscriber(healthyKey, () => {}, { heartbeatIntervalMs: 8_000 });

    clock.advance(12_800);
    clock.advance(12_800);
    broker.recordTransportKeepalive(healthyKey); // keeps this one's missedPulseCount at 0

    const app = new Hono();
    app.route('/api/v1/health', createHealthRoutes(createBureauStub(true), broker));

    const response = await app.request('/api/v1/health/ready');
    const body = (await response.json()) as ReadyResponse;
    expect(body.subsystems.connections.total).toBe(3);
    expect(body.subsystems.connections.unreachable).toBe(2);
  });
});
