import { describe, expect, it } from 'bun:test';

import { createTestGateway, requestJSON } from '../test';

const AUTH_TOKEN = 'test-token';
const authHeaders = { authorization: `Bearer ${AUTH_TOKEN}` };

describe('webhook ingress routes', () => {
  it('POST /hooks/:agent fires a run and returns 202', async () => {
    const gateway = await createTestGateway({
      authToken: AUTH_TOKEN,
      generate: async () => ({ content: 'Done.', toolCalls: [] }),
    });

    const response = await requestJSON(gateway, '/hooks/researcher', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ message: 'Run analysis' }),
    });

    expect(response.status).toBe(202);
    const body = await response.json();
    expect(body.runId).toBeString();
    expect(body.sessionId).toBeString();
    expect(body.status).toBeString();
    expect(body.agentName).toBe('researcher');
    expect(body.idempotencyKey).toBeNull();
  });

  it('uses x-idempotency-key as the session id', async () => {
    const gateway = await createTestGateway({
      authToken: AUTH_TOKEN,
      generate: async () => ({ content: 'Done.', toolCalls: [] }),
    });

    const idempotencyKey = 'webhook-abc-123';

    const response = await requestJSON(gateway, '/hooks/researcher', {
      method: 'POST',
      headers: {
        ...authHeaders,
        'x-idempotency-key': idempotencyKey,
      },
      body: JSON.stringify({ message: 'Run analysis' }),
    });

    expect(response.status).toBe(202);
    const body = await response.json();
    expect(body.sessionId).toBe(idempotencyKey);
    expect(body.idempotencyKey).toBe(idempotencyKey);
  });

  it('respects x-agent-name header over path parameter', async () => {
    const gateway = await createTestGateway({
      authToken: AUTH_TOKEN,
      generate: async () => ({ content: 'Done.', toolCalls: [] }),
    });

    const response = await requestJSON(gateway, '/hooks/fallback', {
      method: 'POST',
      headers: {
        ...authHeaders,
        'x-agent-name': 'override-agent',
      },
      body: JSON.stringify({ message: 'Hello' }),
    });

    expect(response.status).toBe(202);
    const body = await response.json();
    expect(body.agentName).toBe('override-agent');
  });

  it('returns 400 when message is missing', async () => {
    const gateway = await createTestGateway({
      authToken: AUTH_TOKEN,
      generate: async () => ({ content: 'Done.', toolCalls: [] }),
    });

    const response = await requestJSON(gateway, '/hooks/researcher', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(400);
  });

  it('returns 400 on invalid JSON body', async () => {
    const gateway = await createTestGateway({
      authToken: AUTH_TOKEN,
      generate: async () => ({ content: 'Done.', toolCalls: [] }),
    });

    const response = await gateway.app.request('/hooks/researcher', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${AUTH_TOKEN}`,
        'content-type': 'application/json',
      },
      body: 'not-json',
    });

    expect(response.status).toBe(400);
  });

  it('forwards optional systemPrompt and maximumSteps', async () => {
    const gateway = await createTestGateway({
      authToken: AUTH_TOKEN,
      generate: async () => ({ content: 'Done.', toolCalls: [] }),
    });

    const response = await requestJSON(gateway, '/hooks/researcher', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        message: 'Run analysis',
        systemPrompt: 'You are a researcher.',
        maximumSteps: 3,
      }),
    });

    expect(response.status).toBe(202);
  });
});
