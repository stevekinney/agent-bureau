import { describe, expect, it } from 'bun:test';

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
