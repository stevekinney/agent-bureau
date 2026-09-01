import type { GenerateFunction } from '@lostgradient/operative';
import { describe, expect, it } from 'bun:test';

import {
  attackerRequestContextFixture,
  createGatewayAuthorityTestApiKey,
  createTestGateway,
  expectedPersistedApiKeyAuthority,
  gatewayAuthorityTestScopes,
  requestJSON,
  waitForRunState,
} from '../test';

function createMockGenerate(): GenerateFunction {
  return async () => ({ content: 'Done.', toolCalls: [] });
}

describe('webhook ingress routes (POST /hooks/*)', () => {
  it('returns 422 when agent query parameter is missing', async () => {
    const gateway = await createTestGateway({ generate: createMockGenerate() });
    const response = await requestJSON(gateway, '/hooks/inbound', {
      method: 'POST',
      body: JSON.stringify({ message: 'Hello' }),
    });
    expect(response.status).toBe(422);
    const body = await response.json();
    // Error responses are wrapped in { error: { code, message } }
    expect(body.error.message).toMatch(/agent/i);
  });

  it('returns 422 when agent query parameter is empty string', async () => {
    const gateway = await createTestGateway({ generate: createMockGenerate() });
    const response = await requestJSON(gateway, '/hooks/inbound?agent=', {
      method: 'POST',
      body: JSON.stringify({ message: 'Hello' }),
    });
    expect(response.status).toBe(422);
  });

  it('returns 400 when message is missing from body', async () => {
    const gateway = await createTestGateway({ generate: createMockGenerate() });
    const response = await requestJSON(gateway, '/hooks/inbound?agent=bureau', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(400);
  });

  it('returns 400 with invalid JSON body', async () => {
    const gateway = await createTestGateway({ generate: createMockGenerate() });
    const response = await requestJSON(gateway, '/hooks/inbound?agent=bureau', {
      method: 'POST',
      body: 'not-json',
    });
    expect(response.status).toBe(400);
  });

  it('returns 503 when no generate is configured', async () => {
    const gateway = await createTestGateway();
    const response = await requestJSON(gateway, '/hooks/inbound?agent=bureau', {
      method: 'POST',
      body: JSON.stringify({ message: 'Hello' }),
    });
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error.code).toBe('SERVICE_UNAVAILABLE');
    expect(body.error.requestId).toBeString();
  });

  it('dispatches the run and returns 202 with agent name from query', async () => {
    const gateway = await createTestGateway({ generate: createMockGenerate() });
    const response = await requestJSON(gateway, '/hooks/event?agent=bureau', {
      method: 'POST',
      body: JSON.stringify({ message: 'Trigger an event.' }),
    });
    expect(response.status).toBe(202);
    const body = await response.json();
    expect(body.id).toBeString();
    expect(body.status).toBe('running');
  });

  it('derives request authority from the verified API key and ignores caller context', async () => {
    const gateway = await createTestGateway({
      generate: createMockGenerate(),
      storage: { type: 'memory' },
    });
    const { key, plaintext } = await createGatewayAuthorityTestApiKey(gateway);

    const response = await requestJSON(gateway, '/hooks/event?agent=hook-agent', {
      method: 'POST',
      headers: { authorization: `Bearer ${plaintext}` },
      body: JSON.stringify({
        message: 'Trigger an event.',
        requestContext: attackerRequestContextFixture(),
      }),
    });
    expect(response.status).toBe(202);

    const body = (await response.json()) as { id: string; sessionId: string };
    await waitForRunState(gateway.bureau, body.id);
    const session = await gateway.bureau.getSession(body.sessionId);

    expect(session?.metadata['lastRequestAuthority']).toEqual(
      expectedPersistedApiKeyAuthority(key, 'hook-agent'),
    );
  });

  it('accepts optional session parameter from query string', async () => {
    const gateway = await createTestGateway({ generate: createMockGenerate() });
    const response = await requestJSON(gateway, '/hooks/event?agent=bureau&session=my-session', {
      method: 'POST',
      body: JSON.stringify({ message: 'Hello from session.' }),
    });
    expect(response.status).toBe(202);
    const body = await response.json();
    expect(body.sessionId).toBe('my-session');
  });

  it('returns the original receipt for an identical Idempotency-Key retry', async () => {
    const gateway = await createTestGateway({ generate: createMockGenerate() });

    const first = await requestJSON(gateway, '/hooks/event?agent=bureau', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'unique-key-1' },
      body: JSON.stringify({ message: 'First request.' }),
    });
    expect(first.status).toBe(202);

    const second = await requestJSON(gateway, '/hooks/event?agent=bureau', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'unique-key-1' },
      body: JSON.stringify({ message: 'First request.' }),
    });
    expect(second.status).toBe(202);
    expect(await second.json()).toEqual(await first.json());
  });

  it('fingerprints the normalized session identifier used by Bureau', async () => {
    const gateway = await createTestGateway({ generate: createMockGenerate() });
    const request = (session: string) =>
      requestJSON(gateway, `/hooks/event?agent=bureau&session=${session}`, {
        method: 'POST',
        headers: { 'Idempotency-Key': 'normalized-session-key' },
        body: JSON.stringify({ message: 'Same request.' }),
      });

    const first = await request('%20shared-session%20');
    const replay = await request('shared-session');

    expect(first.status).toBe(202);
    expect(replay.status).toBe(202);
    expect(await replay.json()).toEqual(await first.json());
  });

  it('returns a typed conflict when an Idempotency-Key is reused for another request', async () => {
    const gateway = await createTestGateway({ generate: createMockGenerate() });

    const first = await requestJSON(gateway, '/hooks/event?agent=bureau', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'conflicting-key' },
      body: JSON.stringify({ message: 'First request.' }),
    });
    expect(first.status).toBe(202);

    const conflict = await requestJSON(gateway, '/hooks/event?agent=bureau', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'conflicting-key' },
      body: JSON.stringify({ message: 'Different request.' }),
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({
      error: {
        code: 'IDEMPOTENCY_CONFLICT',
        message: 'Idempotency key "conflicting-key" was reused with a different canonical request.',
      },
    });
  });

  it('returns the original failure receipt for an identical retry', async () => {
    const gateway = await createTestGateway();
    const request = {
      method: 'POST',
      headers: { 'Idempotency-Key': 'failed-key' },
      body: JSON.stringify({ message: 'Cannot run.' }),
    };

    const first = await requestJSON(gateway, '/hooks/event?agent=bureau', request);
    const second = await requestJSON(gateway, '/hooks/event?agent=bureau', request);

    expect(first.status).toBe(503);
    expect(second.status).toBe(503);
    expect(await second.json()).toEqual(await first.json());
  });

  it('allows same agent with different Idempotency-Keys', async () => {
    const gateway = await createTestGateway({ generate: createMockGenerate() });

    const first = await requestJSON(gateway, '/hooks/event?agent=bureau', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'key-a' },
      body: JSON.stringify({ message: 'First.' }),
    });
    expect(first.status).toBe(202);

    const second = await requestJSON(gateway, '/hooks/event?agent=bureau', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'key-b' },
      body: JSON.stringify({ message: 'Second.' }),
    });
    expect(second.status).toBe(202);
  });

  it('scopes the same Idempotency-Key to the authenticated principal', async () => {
    const gateway = await createTestGateway({
      generate: createMockGenerate(),
      storage: { type: 'memory' },
    });
    const firstPrincipal = await createGatewayAuthorityTestApiKey(gateway, {
      name: 'first-principal',
      scopes: [...gatewayAuthorityTestScopes],
    });
    const secondPrincipal = await createGatewayAuthorityTestApiKey(gateway, {
      name: 'second-principal',
      scopes: [...gatewayAuthorityTestScopes],
    });
    const request = (authorization: string) => ({
      method: 'POST',
      headers: {
        authorization: `Bearer ${authorization}`,
        'Idempotency-Key': 'shared-principal-key',
      },
      body: JSON.stringify({ message: 'Same request.' }),
    });

    const first = await requestJSON(
      gateway,
      '/hooks/event?agent=bureau',
      request(firstPrincipal.plaintext),
    );
    const second = await requestJSON(
      gateway,
      '/hooks/event?agent=bureau',
      request(secondPrincipal.plaintext),
    );

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    const firstReceipt = await first.json();
    const secondReceipt = await second.json();
    expect(firstReceipt.id).not.toBe(secondReceipt.id);
  });

  it('does not consume the Idempotency-Key when the body is invalid JSON', async () => {
    const gateway = await createTestGateway({ generate: createMockGenerate() });
    const key = 'retry-after-bad-json';

    // First attempt: malformed JSON — validation must fail without persisting key.
    const bad = await requestJSON(gateway, '/hooks/event?agent=bureau', {
      method: 'POST',
      headers: { 'Idempotency-Key': key },
      body: 'not-json',
    });
    expect(bad.status).toBe(400);

    // Second attempt: corrected request with the same key — must succeed, not 409.
    const good = await requestJSON(gateway, '/hooks/event?agent=bureau', {
      method: 'POST',
      headers: { 'Idempotency-Key': key },
      body: JSON.stringify({ message: 'Corrected.' }),
    });
    expect(good.status).toBe(202);
  });

  it('does not consume the Idempotency-Key when message is missing from body', async () => {
    const gateway = await createTestGateway({ generate: createMockGenerate() });
    const key = 'retry-after-missing-message';

    // First attempt: missing message field — validation must fail without persisting key.
    const bad = await requestJSON(gateway, '/hooks/event?agent=bureau', {
      method: 'POST',
      headers: { 'Idempotency-Key': key },
      body: JSON.stringify({}),
    });
    expect(bad.status).toBe(400);

    // Second attempt: corrected request with the same key — must succeed, not 409.
    const good = await requestJSON(gateway, '/hooks/event?agent=bureau', {
      method: 'POST',
      headers: { 'Idempotency-Key': key },
      body: JSON.stringify({ message: 'Now included.' }),
    });
    expect(good.status).toBe(202);
  });

  it('routes different paths under /hooks/* to the same handler', async () => {
    const gateway = await createTestGateway({ generate: createMockGenerate() });

    const pathA = await requestJSON(gateway, '/hooks/inbound/github?agent=bureau', {
      method: 'POST',
      body: JSON.stringify({ message: 'GitHub webhook.' }),
    });
    expect(pathA.status).toBe(202);

    const pathB = await requestJSON(gateway, '/hooks/stripe?agent=bureau', {
      method: 'POST',
      body: JSON.stringify({ message: 'Stripe webhook.' }),
    });
    expect(pathB.status).toBe(202);
  });

  it('shares one receipt between concurrent identical Idempotency-Key requests', async () => {
    const gateway = await createTestGateway({ generate: createMockGenerate() });
    const key = 'concurrent-key';

    const [first, second] = await Promise.all([
      requestJSON(gateway, '/hooks/event?agent=bureau', {
        method: 'POST',
        headers: { 'Idempotency-Key': key },
        body: JSON.stringify({ message: 'Concurrent request.' }),
      }),
      requestJSON(gateway, '/hooks/event?agent=bureau', {
        method: 'POST',
        headers: { 'Idempotency-Key': key },
        body: JSON.stringify({ message: 'Concurrent request.' }),
      }),
    ]);

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(await second.json()).toEqual(await first.json());
  });
});
