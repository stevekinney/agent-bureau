import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import type { GenerateFunction } from 'operative';

import { createTestGateway, requestJSON } from '../test';
import type { Bureau, CreateRunRequest, RunSummary } from '../types';
import { createWebhookRoutes } from './webhooks';

// These tests validate the createWebhookRoutes path-param dispatch behavior
// via the webhooks.ts module. Note: the live gateway routes to createHooksRoutes
// (issue-96 G3 inbound dispatch via ?agent= query param); webhooks.ts is kept
// as an explicit path-param variant. Tests here call routes that resolve through
// the hooks path (createHooksRoutes) and therefore must include ?agent=.

function createMockGenerate(): GenerateFunction {
  return async () => ({ content: 'Done.', toolCalls: [] });
}

/**
 * Minimal Bureau stub for testing createWebhookRoutes in isolation.
 * Only `createRun` is exercised by the route handler; all other members are
 * unused. Test files may use `any` to satisfy the full interface without
 * implementing every method.
 */
function createStubBureau(createRun: (req: CreateRunRequest) => Promise<RunSummary>): Bureau {
  return { createRun } as any as Bureau;
}

function makeRunSummary(overrides?: Partial<RunSummary>): RunSummary {
  return {
    id: 'run-1',
    sessionId: 'session-1',
    status: 'completed',
    steps: 1,
    usage: { prompt: 10, completion: 5, total: 15 },
    finishReason: 'end_turn',
    error: undefined,
    actionCount: 0,
    ...overrides,
  };
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

describe('createWebhookRoutes — direct mount', () => {
  // These tests mount createWebhookRoutes directly on a Hono app with a
  // stub Bureau so we can assert on the exact request passed to createRun.

  it('passes agentName from path param to bureau.createRun', async () => {
    const capturedRequests: CreateRunRequest[] = [];
    const bureau = createStubBureau(async (req) => {
      capturedRequests.push(req);
      return makeRunSummary();
    });

    const app = new Hono();
    app.route('/', createWebhookRoutes(bureau));

    const response = await app.request('/analyst', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'Hello' }),
    });

    expect(response.status).toBe(202);
    expect(capturedRequests).toHaveLength(1);
    expect(capturedRequests[0]?.agentName).toBe('analyst');
  });

  it('passes agentName from x-agent-name header (header takes precedence over path param)', async () => {
    const capturedRequests: CreateRunRequest[] = [];
    const bureau = createStubBureau(async (req) => {
      capturedRequests.push(req);
      return makeRunSummary();
    });

    const app = new Hono();
    app.route('/', createWebhookRoutes(bureau));

    const response = await app.request('/fallback-agent', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-agent-name': 'header-agent',
      },
      body: JSON.stringify({ message: 'Hello from header dispatch' }),
    });

    expect(response.status).toBe(202);
    expect(capturedRequests).toHaveLength(1);
    expect(capturedRequests[0]?.agentName).toBe('header-agent');
  });
});
