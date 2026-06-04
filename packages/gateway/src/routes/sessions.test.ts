import { MemoryStorage, textValueStore } from '@lostgradient/weft/storage';
import { describe, expect, it } from 'bun:test';

import { createTestGateway, requestJSON, waitForRunState } from '../test';

const AUTH_TOKEN = 'test-token';
const authHeaders = { authorization: `Bearer ${AUTH_TOKEN}` };

describe('sessions routes', () => {
  it('returns 501 when no persistence adapter is configured', async () => {
    const gateway = await createTestGateway({ authToken: AUTH_TOKEN });
    const response = await requestJSON(gateway, '/api/v1/sessions', {
      headers: authHeaders,
    });
    expect(response.status).toBe(501);
    const body = await response.json();
    expect(body.error.code).toBe('NOT_IMPLEMENTED');
  });

  it('GET /api/v1/sessions returns session list', async () => {
    const gateway = await createTestGateway({
      authToken: AUTH_TOKEN,
      persistence: textValueStore(new MemoryStorage()),
      generate: async () => ({ content: 'Done.', toolCalls: [] }),
    });

    const createResponse = await requestJSON(gateway, '/api/v1/runs', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ message: 'Hello' }),
    });
    const createdRun = await createResponse.json();
    await waitForRunState(gateway.bureau, createdRun.id);

    const response = await requestJSON(gateway, '/api/v1/sessions', {
      headers: authHeaders,
    });
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body).toHaveLength(1);
    expect(body[0].id).toBe(createdRun.sessionId);
  });

  it('GET /api/v1/sessions/:id returns a session', async () => {
    const gateway = await createTestGateway({
      authToken: AUTH_TOKEN,
      persistence: textValueStore(new MemoryStorage()),
      generate: async () => ({ content: 'Done.', toolCalls: [] }),
    });

    const createResponse = await requestJSON(gateway, '/api/v1/runs', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ message: 'Hello' }),
    });
    const createdRun = await createResponse.json();
    await waitForRunState(gateway.bureau, createdRun.id);

    const response = await requestJSON(gateway, `/api/v1/sessions/${createdRun.sessionId}`, {
      headers: authHeaders,
    });
    expect(response.status).toBe(200);
  });

  it('GET /api/v1/sessions/:id returns 404 for missing session', async () => {
    const gateway = await createTestGateway({
      persistence: textValueStore(new MemoryStorage()),
      authToken: AUTH_TOKEN,
    });

    const response = await requestJSON(gateway, '/api/v1/sessions/missing', {
      headers: authHeaders,
    });
    expect(response.status).toBe(404);
  });

  it('DELETE /api/v1/sessions/:id removes a session', async () => {
    const gateway = await createTestGateway({
      authToken: AUTH_TOKEN,
      persistence: textValueStore(new MemoryStorage()),
      generate: async () => ({ content: 'Done.', toolCalls: [] }),
    });

    const createResponse = await requestJSON(gateway, '/api/v1/runs', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ message: 'Hello' }),
    });
    const createdRun = await createResponse.json();
    await waitForRunState(gateway.bureau, createdRun.id);

    const deleteResponse = await requestJSON(gateway, `/api/v1/sessions/${createdRun.sessionId}`, {
      method: 'DELETE',
      headers: authHeaders,
    });
    expect(deleteResponse.status).toBe(204);

    const getResponse = await requestJSON(gateway, `/api/v1/sessions/${createdRun.sessionId}`, {
      headers: authHeaders,
    });
    expect(getResponse.status).toBe(404);
  });
});
