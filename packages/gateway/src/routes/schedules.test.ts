import { describe, expect, it, spyOn } from 'bun:test';
import { createRuntimeComposition } from 'bureau';

import { createTestGateway, requestJSON } from '../test';

const AUTH_TOKEN = 'test-token';
const authHeaders = { authorization: `Bearer ${AUTH_TOKEN}` };

describe('schedules routes', () => {
  it('POST /schedules returns 501 when no durable engine is configured', async () => {
    const gateway = await createTestGateway({ authToken: AUTH_TOKEN });

    const response = await requestJSON(gateway, '/schedules', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        agentName: 'researcher',
        input: 'Daily analysis',
        spec: '0 9 * * *',
      }),
    });

    expect(response.status).toBe(501);
    const body = await response.json();
    expect(body.error.code).toBe('NOT_CONFIGURED');
  });

  it('GET /schedules returns 501 when no durable engine is configured', async () => {
    const gateway = await createTestGateway({ authToken: AUTH_TOKEN });

    const response = await requestJSON(gateway, '/schedules', {
      headers: authHeaders,
    });

    expect(response.status).toBe(501);
    const body = await response.json();
    expect(body.error.code).toBe('NOT_CONFIGURED');
  });

  it('GET /schedules/:id returns 501 when no durable engine is configured', async () => {
    const gateway = await createTestGateway({ authToken: AUTH_TOKEN });

    const response = await requestJSON(gateway, '/schedules/some-id', {
      headers: authHeaders,
    });

    expect(response.status).toBe(501);
    const body = await response.json();
    expect(body.error.code).toBe('NOT_CONFIGURED');
  });

  it('DELETE /schedules/:id returns 501 when no durable engine is configured', async () => {
    const gateway = await createTestGateway({ authToken: AUTH_TOKEN });

    const response = await requestJSON(gateway, '/schedules/some-id', {
      method: 'DELETE',
      headers: authHeaders,
    });

    expect(response.status).toBe(501);
    const body = await response.json();
    expect(body.error.code).toBe('NOT_CONFIGURED');
  });

  it('POST /schedules returns 400 when agentName is missing', async () => {
    const gateway = await createTestGateway({ authToken: AUTH_TOKEN });

    const response = await requestJSON(gateway, '/schedules', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        input: 'Daily analysis',
        spec: '0 9 * * *',
      }),
    });

    expect(response.status).toBe(400);
  });

  it('POST /schedules returns 400 when spec is missing', async () => {
    const gateway = await createTestGateway({ authToken: AUTH_TOKEN });

    const response = await requestJSON(gateway, '/schedules', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        agentName: 'researcher',
        input: 'Daily analysis',
      }),
    });

    expect(response.status).toBe(400);
  });

  it('POST /schedules/id/pause returns 501 when no durable engine is configured', async () => {
    const gateway = await createTestGateway({ authToken: AUTH_TOKEN });

    const response = await requestJSON(gateway, '/schedules/my-schedule/pause', {
      method: 'POST',
      headers: authHeaders,
    });

    expect(response.status).toBe(501);
  });

  it('POST /schedules/id/resume returns 501 when no durable engine is configured', async () => {
    const gateway = await createTestGateway({ authToken: AUTH_TOKEN });

    const response = await requestJSON(gateway, '/schedules/my-schedule/resume', {
      method: 'POST',
      headers: authHeaders,
    });

    expect(response.status).toBe(501);
  });
});

describe('schedules routes with durable engine (regression PRRT_kwDORvupsc6MXEmg)', () => {
  // Before the fix, pauseSchedule/resumeSchedule/cancelSchedule returned void
  // (undefined) on success, which was indistinguishable from the undefined sentinel
  // used to signal "no durable engine". Routes checking `result === undefined` would
  // therefore return 501 even when the durable operation succeeded.

  it('POST /schedules returns 201 with the created summary when a durable engine is configured (#109)', async () => {
    // The durable scheduled-fire path is now wired (#109): createSchedule registers
    // a native weft schedule and returns its ScheduleSummary, which the route
    // surfaces as 201 Created.
    const gateway = await createTestGateway({
      authToken: AUTH_TOKEN,
      storage: { type: 'memory' },
      durableExecution: true,
    });

    const response = await requestJSON(gateway, '/schedules', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        agentName: 'researcher',
        input: 'Daily analysis',
        spec: '0 9 * * *',
      }),
    });

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.workflowType).toBe('agentRun');
    expect(body.status).toBe('active');
    expect(typeof body.id).toBe('string');
    gateway.bureau.dispose();
  });

  it('POST /schedules/:id/pause returns 200 when durable engine is configured', async () => {
    // Probe the bundled Engine prototype so we can spy at the engine level —
    // this exercises the real bureau wrapper, which is where the bug lived.
    const probe = await createRuntimeComposition({
      generate: async () => ({ content: 'Done.', toolCalls: [] }),
      storage: { type: 'memory' },
      durableExecution: true,
    });
    const realEngineProto = Object.getPrototypeOf(probe.durable!.engine) as object;
    probe.durable!.engine[Symbol.dispose]?.();
    probe.disposeStorage?.();

    const pauseSpy = spyOn(
      realEngineProto as { pauseSchedule: (id: string) => Promise<void> },
      'pauseSchedule',
    ).mockResolvedValue(undefined);

    try {
      const gateway = await createTestGateway({
        authToken: AUTH_TOKEN,
        storage: { type: 'memory' },
        durableExecution: true,
      });

      const response = await requestJSON(gateway, '/schedules/my-schedule/pause', {
        method: 'POST',
        headers: authHeaders,
      });

      // Must be 200 (operation performed), not 501 (falsely treated as no engine).
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.status).toBe('paused');

      gateway.bureau.dispose();
    } finally {
      pauseSpy.mockRestore();
    }
  });

  it('POST /schedules/:id/resume returns 200 when durable engine is configured', async () => {
    const probe = await createRuntimeComposition({
      generate: async () => ({ content: 'Done.', toolCalls: [] }),
      storage: { type: 'memory' },
      durableExecution: true,
    });
    const realEngineProto = Object.getPrototypeOf(probe.durable!.engine) as object;
    probe.durable!.engine[Symbol.dispose]?.();
    probe.disposeStorage?.();

    const resumeSpy = spyOn(
      realEngineProto as { resumeSchedule: (id: string) => Promise<void> },
      'resumeSchedule',
    ).mockResolvedValue(undefined);

    try {
      const gateway = await createTestGateway({
        authToken: AUTH_TOKEN,
        storage: { type: 'memory' },
        durableExecution: true,
      });

      const response = await requestJSON(gateway, '/schedules/my-schedule/resume', {
        method: 'POST',
        headers: authHeaders,
      });

      // Must be 200 (operation performed), not 501 (falsely treated as no engine).
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.status).toBe('resumed');

      gateway.bureau.dispose();
    } finally {
      resumeSpy.mockRestore();
    }
  });

  it('DELETE /schedules/:id returns 204 when durable engine is configured', async () => {
    const probe = await createRuntimeComposition({
      generate: async () => ({ content: 'Done.', toolCalls: [] }),
      storage: { type: 'memory' },
      durableExecution: true,
    });
    const realEngineProto = Object.getPrototypeOf(probe.durable!.engine) as object;
    probe.durable!.engine[Symbol.dispose]?.();
    probe.disposeStorage?.();

    const cancelSpy = spyOn(
      realEngineProto as { cancelSchedule: (id: string) => Promise<void> },
      'cancelSchedule',
    ).mockResolvedValue(undefined);

    try {
      const gateway = await createTestGateway({
        authToken: AUTH_TOKEN,
        storage: { type: 'memory' },
        durableExecution: true,
      });

      const response = await requestJSON(gateway, '/schedules/my-schedule', {
        method: 'DELETE',
        headers: authHeaders,
      });

      // Must be 204 (schedule deleted), not 501 (falsely treated as no engine).
      expect(response.status).toBe(204);

      gateway.bureau.dispose();
    } finally {
      cancelSpy.mockRestore();
    }
  });
});
