import { describe, expect, it } from 'bun:test';
import type { GenerateFunction } from 'operative';

import { createTestGateway, requestJSON } from '../test';

// These tests validate the createWebhookRoutes path-param dispatch behavior
// via the webhooks.ts module. Note: the live gateway routes to createHooksRoutes
// (issue-96 G3 inbound dispatch via ?agent= query param); webhooks.ts is kept
// as an explicit path-param variant. Tests here call routes that resolve through
// the hooks path (createHooksRoutes) and therefore must include ?agent=.

function createMockGenerate(): GenerateFunction {
  return async () => ({ content: 'Done.', toolCalls: [] });
}

describe('webhook ingress routes', () => {
  it('POST /hooks/* fires a run and returns 202 when agent is named via query param', async () => {
    const gateway = await createTestGateway({
      authToken: 'test-token',
      generate: createMockGenerate(),
    });

    const response = await requestJSON(gateway, '/hooks/researcher?agent=researcher', {
      method: 'POST',
      headers: { authorization: 'Bearer test-token' },
      body: JSON.stringify({ message: 'Run analysis' }),
    });

    expect(response.status).toBe(202);
    const body = await response.json();
    expect(body.id).toBeString();
    expect(body.status).toBeString();
  });

  it('returns 422 when agent query parameter is missing', async () => {
    const gateway = await createTestGateway({
      authToken: 'test-token',
      generate: createMockGenerate(),
    });

    const response = await requestJSON(gateway, '/hooks/researcher', {
      method: 'POST',
      headers: { authorization: 'Bearer test-token' },
      body: JSON.stringify({ message: 'Run analysis' }),
    });

    expect(response.status).toBe(422);
  });

  it('uses Idempotency-Key header for deduplication', async () => {
    const gateway = await createTestGateway({
      authToken: 'test-token',
      generate: createMockGenerate(),
    });

    const idempotencyKey = 'webhook-abc-123';

    const first = await requestJSON(gateway, '/hooks/researcher?agent=researcher', {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-token',
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify({ message: 'Run analysis' }),
    });

    expect(first.status).toBe(202);

    const second = await requestJSON(gateway, '/hooks/researcher?agent=researcher', {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-token',
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify({ message: 'Run analysis again' }),
    });

    expect(second.status).toBe(409);
  });

  it('returns 400 when message is missing', async () => {
    const gateway = await createTestGateway({
      authToken: 'test-token',
      generate: createMockGenerate(),
    });

    const response = await requestJSON(gateway, '/hooks/researcher?agent=researcher', {
      method: 'POST',
      headers: { authorization: 'Bearer test-token' },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(400);
  });

  it('returns 400 on invalid JSON body', async () => {
    const gateway = await createTestGateway({
      authToken: 'test-token',
      generate: createMockGenerate(),
    });

    const response = await gateway.app.request('/hooks/researcher?agent=researcher', {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-token',
        'content-type': 'application/json',
      },
      body: 'not-json',
    });

    expect(response.status).toBe(400);
  });

  it('forwards optional systemPrompt and maximumSteps via request body', async () => {
    const gateway = await createTestGateway({
      authToken: 'test-token',
      generate: createMockGenerate(),
    });

    const response = await requestJSON(gateway, '/hooks/researcher?agent=researcher', {
      method: 'POST',
      headers: { authorization: 'Bearer test-token' },
      body: JSON.stringify({
        message: 'Run analysis',
        systemPrompt: 'You are a researcher.',
        maximumSteps: 3,
      }),
    });

    expect(response.status).toBe(202);
  });
});
