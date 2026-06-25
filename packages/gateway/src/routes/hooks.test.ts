import { describe, expect, it } from 'bun:test';
import type { GenerateFunction } from 'operative';

import { createTestGateway, requestJSON } from '../test';

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

  it('rejects duplicate Idempotency-Key with 409', async () => {
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
      body: JSON.stringify({ message: 'Duplicate.' }),
    });
    expect(second.status).toBe(409);
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

  it('rejects one of two concurrent requests with the same Idempotency-Key (TOCTOU fix)', async () => {
    // Both requests are dispatched concurrently via Promise.all. Without the fix,
    // both pass idempotencyKeys.has() before either reaches idempotencyKeys.add()
    // (the await on json() yields the event loop between check and add). With the
    // fix, the key is reserved synchronously before the first await, so exactly
    // one request wins and the other gets 409.
    const gateway = await createTestGateway({ generate: createMockGenerate() });
    const key = 'concurrent-key';

    const [first, second] = await Promise.all([
      requestJSON(gateway, '/hooks/event?agent=bureau', {
        method: 'POST',
        headers: { 'Idempotency-Key': key },
        body: JSON.stringify({ message: 'Concurrent request A.' }),
      }),
      requestJSON(gateway, '/hooks/event?agent=bureau', {
        method: 'POST',
        headers: { 'Idempotency-Key': key },
        body: JSON.stringify({ message: 'Concurrent request B.' }),
      }),
    ]);

    const statuses = [first.status, second.status].sort();
    // Exactly one should succeed (202) and one should be rejected (409).
    expect(statuses).toEqual([202, 409]);
  });
});
