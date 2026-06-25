import { describe, expect, it } from 'bun:test';

import { createTestGateway, requestJSON, waitForRunState } from '../test';

const AUTH_TOKEN = 'test-token';
const authHeaders = { authorization: `Bearer ${AUTH_TOKEN}` };

// Usage is mounted at /api/v1/usage
const USAGE_PATH = '/api/v1/usage';

describe('usage routes', () => {
  it('GET /api/v1/usage returns aggregate with zero totals when no runs exist', async () => {
    const gateway = await createTestGateway({ authToken: AUTH_TOKEN });

    const response = await requestJSON(gateway, USAGE_PATH, { headers: authHeaders });
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.aggregate.runCount).toBe(0);
    expect(body.aggregate.totalTokens).toBe(0);
    expect(Array.isArray(body.runs)).toBe(true);
    expect(body.runs).toHaveLength(0);
  });

  it('GET /api/v1/usage includes run usage after a completed run', async () => {
    const gateway = await createTestGateway({
      authToken: AUTH_TOKEN,
      generate: async () => ({ content: 'Done.', toolCalls: [] }),
    });

    const createResponse = await requestJSON(gateway, '/api/v1/runs', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ message: 'Hello' }),
    });
    const createdRun = await createResponse.json();
    await waitForRunState(gateway.bureau, createdRun.id);

    const response = await requestJSON(gateway, USAGE_PATH, { headers: authHeaders });
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.aggregate.runCount).toBeGreaterThan(0);
    expect(body.runs.length).toBeGreaterThan(0);

    const runUsage = body.runs[0];
    expect(runUsage.runId).toBeString();
    expect(runUsage.sessionId).toBeString();
    expect(typeof runUsage.usage.promptTokens).toBe('number');
    expect(typeof runUsage.usage.completionTokens).toBe('number');
    expect(typeof runUsage.usage.totalTokens).toBe('number');
    expect(typeof runUsage.steps).toBe('number');
  });

  it('GET /api/v1/usage?status=completed only returns completed runs', async () => {
    const gateway = await createTestGateway({
      authToken: AUTH_TOKEN,
      generate: async () => ({ content: 'Done.', toolCalls: [] }),
    });

    const createResponse = await requestJSON(gateway, '/api/v1/runs', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ message: 'Hello' }),
    });
    const createdRun = await createResponse.json();
    await waitForRunState(gateway.bureau, createdRun.id);

    const response = await requestJSON(gateway, `${USAGE_PATH}?status=completed`, {
      headers: authHeaders,
    });
    expect(response.status).toBe(200);
    const body = await response.json();

    for (const run of body.runs) {
      expect(run.status).toBe('completed');
    }
  });

  it('GET /api/v1/usage?sessionId=... filters by session', async () => {
    const gateway = await createTestGateway({
      authToken: AUTH_TOKEN,
      generate: async () => ({ content: 'Done.', toolCalls: [] }),
    });

    const createResponse = await requestJSON(gateway, '/api/v1/runs', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ message: 'Hello', sessionId: 'my-session' }),
    });
    const createdRun = await createResponse.json();
    await waitForRunState(gateway.bureau, createdRun.id);

    // Filter by the specific session
    const response = await requestJSON(gateway, `${USAGE_PATH}?sessionId=my-session`, {
      headers: authHeaders,
    });
    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body.runs.every((r: { sessionId: string }) => r.sessionId === 'my-session')).toBe(true);

    // Filter by a non-existent session → empty
    const emptyResponse = await requestJSON(gateway, `${USAGE_PATH}?sessionId=other-session`, {
      headers: authHeaders,
    });
    const emptyBody = await emptyResponse.json();
    expect(emptyBody.runs).toHaveLength(0);
  });
});
