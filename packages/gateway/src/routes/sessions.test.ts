import { MemoryStorage, textValueStore } from '@lostgradient/weft/storage';
import { describe, expect, it } from 'bun:test';
import { BureauError } from 'bureau';

import { createTestGateway, requestJSON, waitForRunState } from '../test';
import type { Bureau } from '../types';

const AUTH_TOKEN = 'test-token';
const authHeaders = { authorization: `Bearer ${AUTH_TOKEN}` };
const sessionWriteHeaders = { ...authHeaders, 'content-type': 'application/json' };

/** Minimal Bureau stub with no durable engine methods — only methods consumed by createGateway itself are provided. */
function makeStubBureau(overrides: Partial<Record<string, unknown>>): Bureau {
  return {
    store: {},
    kv: undefined,
    ready: true,
    dispose: () => undefined,
    subscribeLiveFrames: () => () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    setRequestAuthorityValidator: () => undefined,
    getConfiguration: () => ({
      provider: undefined,
      maximumSteps: 10,
      systemPrompt: undefined,
      tools: [],
    }),
    ...overrides,
  } as unknown as Bureau;
}

describe('sessions routes', () => {
  it('returns 503 when no persistence adapter is configured', async () => {
    const gateway = await createTestGateway({ authToken: AUTH_TOKEN });
    const response = await requestJSON(gateway, '/api/v1/sessions', {
      headers: authHeaders,
    });
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error.code).toBe('SERVICE_UNAVAILABLE');
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

  it('GET /api/v1/sessions forwards limit and offset pagination', async () => {
    const gateway = await createTestGateway({
      authToken: AUTH_TOKEN,
      persistence: textValueStore(new MemoryStorage()),
      generate: async () => ({ content: 'Done.', toolCalls: [] }),
    });

    const createdIds: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const response = await requestJSON(gateway, '/api/v1/runs', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ message: `Hello ${index}` }),
      });
      const run = await response.json();
      createdIds.push(run.sessionId);
      await waitForRunState(gateway.bureau, run.id);
    }

    const response = await requestJSON(gateway, '/api/v1/sessions?limit=1&offset=1', {
      headers: authHeaders,
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toHaveLength(1);
    expect(createdIds).toContain(body[0].id);
  });

  it('rejects invalid session pagination parameters', async () => {
    const gateway = await createTestGateway({
      authToken: AUTH_TOKEN,
      persistence: textValueStore(new MemoryStorage()),
    });

    const invalidLimit = await requestJSON(gateway, '/api/v1/sessions?limit=0', {
      headers: authHeaders,
    });
    expect(invalidLimit.status).toBe(400);

    const invalidOffset = await requestJSON(gateway, '/api/v1/sessions?offset=-1', {
      headers: authHeaders,
    });
    expect(invalidOffset.status).toBe(400);
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

  it('GET /api/v1/sessions/:id returns 503 when getSession throws BureauError NOT_CONFIGURED', async () => {
    const stubBureau = makeStubBureau({
      getSession: async () => {
        throw new BureauError('No session store configured', 'NOT_CONFIGURED', 'persistence');
      },
    });
    const gateway = await createTestGateway(stubBureau, { authToken: AUTH_TOKEN });

    const response = await requestJSON(gateway, '/api/v1/sessions/any', {
      headers: authHeaders,
    });
    expect(response.status).toBe(503);
  });

  it('DELETE /api/v1/sessions/:id returns 503 when deleteSession throws BureauError NOT_CONFIGURED', async () => {
    const stubBureau = makeStubBureau({
      deleteSession: async () => {
        throw new BureauError('No session store configured', 'NOT_CONFIGURED', 'persistence');
      },
    });
    const gateway = await createTestGateway(stubBureau, { authToken: AUTH_TOKEN });

    const response = await requestJSON(gateway, '/api/v1/sessions/any', {
      method: 'DELETE',
      headers: authHeaders,
    });
    expect(response.status).toBe(503);
  });

  it('GET /api/v1/sessions/:id/events reaches bureau.eventHistory({kind: "session", id}) — AB-312 (501 over KV-only persistence, which has no durable engine)', async () => {
    const gateway = await createTestGateway({
      persistence: textValueStore(new MemoryStorage()),
      authToken: AUTH_TOKEN,
    });

    const response = await requestJSON(gateway, '/api/v1/sessions/my-session/events', {
      headers: authHeaders,
    });
    // KV-only persistence composes no durable engine at all — this proves
    // the route is wired to `bureau.eventHistory` with the right owner
    // kind (deterministically `unsupported-capability` here). The full
    // paged/redacted response shape is covered by `event-history.test.ts`.
    expect(response.status).toBe(501);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('UNSUPPORTED_CAPABILITY');
  });

  describe('signal / update / query (HITL over the wire)', () => {
    it('POST /api/v1/sessions/:id/signal returns 501 when no durable engine is configured', async () => {
      const gateway = await createTestGateway({ authToken: AUTH_TOKEN });

      const response = await requestJSON(gateway, '/api/v1/sessions/my-session/signal', {
        method: 'POST',
        headers: sessionWriteHeaders,
        body: JSON.stringify({ name: 'human-response', payload: { approved: true } }),
      });

      expect(response.status).toBe(501);
      const body = await response.json();
      expect(body.error.code).toBe('NOT_CONFIGURED');
    });

    it('POST /api/v1/sessions/:id/signal returns 400 when name is missing', async () => {
      const gateway = await createTestGateway({ authToken: AUTH_TOKEN });

      const response = await requestJSON(gateway, '/api/v1/sessions/my-session/signal', {
        method: 'POST',
        headers: sessionWriteHeaders,
        body: JSON.stringify({ payload: { approved: true } }),
      });

      expect(response.status).toBe(400);
    });

    it('POST /api/v1/sessions/:id/signal returns 400 for unparseable JSON instead of a raw parse error', async () => {
      const gateway = await createTestGateway({ authToken: AUTH_TOKEN });

      const response = await requestJSON(gateway, '/api/v1/sessions/my-session/signal', {
        method: 'POST',
        headers: sessionWriteHeaders,
        body: '{not valid json',
      });

      expect(response.status).toBe(400);
    });

    it('POST /api/v1/sessions/:id/signal rethrows a BureauError whose code is not NOT_FOUND, CONFLICT, or NOT_CONFIGURED', async () => {
      const stubBureau = makeStubBureau({
        signalSession: async () => {
          throw new BureauError('rate limited', 'RATE_LIMITED');
        },
      });
      const gateway = await createTestGateway(stubBureau, { authToken: AUTH_TOKEN });

      const response = await requestJSON(gateway, '/api/v1/sessions/my-session/signal', {
        method: 'POST',
        headers: sessionWriteHeaders,
        body: JSON.stringify({ name: 'human-response' }),
      });

      expect(response.status).toBe(500);
    });

    it('POST /api/v1/sessions/:id/update returns 501 when no durable engine is configured', async () => {
      const gateway = await createTestGateway({ authToken: AUTH_TOKEN });

      const response = await requestJSON(gateway, '/api/v1/sessions/my-session/update', {
        method: 'POST',
        headers: sessionWriteHeaders,
        body: JSON.stringify({ name: 'adjust-params', payload: { maxSteps: 5 } }),
      });

      expect(response.status).toBe(501);
    });

    it('POST /api/v1/sessions/:id/update returns 400 when name is missing', async () => {
      const gateway = await createTestGateway({ authToken: AUTH_TOKEN });

      const response = await requestJSON(gateway, '/api/v1/sessions/my-session/update', {
        method: 'POST',
        headers: sessionWriteHeaders,
        body: JSON.stringify({ payload: 'something' }),
      });

      expect(response.status).toBe(400);
    });

    it('POST /api/v1/sessions/:id/update returns 400 for unparseable JSON instead of a raw parse error', async () => {
      const gateway = await createTestGateway({ authToken: AUTH_TOKEN });

      const response = await requestJSON(gateway, '/api/v1/sessions/my-session/update', {
        method: 'POST',
        headers: sessionWriteHeaders,
        body: '{not valid json',
      });

      expect(response.status).toBe(400);
    });

    it('POST /api/v1/sessions/:id/update rethrows a BureauError whose code is not NOT_FOUND, CONFLICT, NOT_CONFIGURED, or UNSUPPORTED_CAPABILITY', async () => {
      const stubBureau = makeStubBureau({
        updateSession: async () => {
          throw new BureauError('rate limited', 'RATE_LIMITED');
        },
      });
      const gateway = await createTestGateway(stubBureau, { authToken: AUTH_TOKEN });

      const response = await requestJSON(gateway, '/api/v1/sessions/my-session/update', {
        method: 'POST',
        headers: sessionWriteHeaders,
        body: JSON.stringify({ name: 'adjust-params' }),
      });

      expect(response.status).toBe(500);
    });

    it('GET /api/v1/sessions/:id/query returns 400 when name param is missing', async () => {
      const gateway = await createTestGateway({ authToken: AUTH_TOKEN });

      const response = await requestJSON(gateway, '/api/v1/sessions/my-session/query', {
        headers: authHeaders,
      });

      expect(response.status).toBe(400);
    });

    it('GET /api/v1/sessions/:id/query returns 501 when no durable engine is configured', async () => {
      const gateway = await createTestGateway({ authToken: AUTH_TOKEN });

      const response = await requestJSON(
        gateway,
        '/api/v1/sessions/my-session/query?name=current-step',
        {
          headers: authHeaders,
        },
      );

      expect(response.status).toBe(501);
    });

    it('GET /api/v1/sessions/:id/query returns 400 when input is not valid JSON', async () => {
      const gateway = await createTestGateway({ authToken: AUTH_TOKEN });

      const response = await requestJSON(
        gateway,
        '/api/v1/sessions/my-session/query?name=step&input=not-json',
        {
          headers: authHeaders,
        },
      );

      expect(response.status).toBe(400);
    });

    it('GET /api/v1/sessions/:id/query rethrows a BureauError whose code is not NOT_FOUND, NOT_CONFIGURED, or UNSUPPORTED_CAPABILITY', async () => {
      const stubBureau = makeStubBureau({
        querySession: async () => {
          throw new BureauError('rate limited', 'RATE_LIMITED');
        },
      });
      const gateway = await createTestGateway(stubBureau, { authToken: AUTH_TOKEN });

      const response = await requestJSON(
        gateway,
        '/api/v1/sessions/my-session/query?name=current-step',
        { headers: authHeaders },
      );

      expect(response.status).toBe(500);
    });

    // Regression tests for PRRT_kwDORvupsc6MXEmd and PRRT_kwDORvupsc6MXEmm:
    // signalSession / updateSession / querySession used `undefined` as the "not
    // configured" sentinel, but a successful void signal or a handler that returns
    // undefined also evaluates to undefined, causing the route to respond 501 even
    // on a successful operation. The fix: bureau throws BureauError('NOT_CONFIGURED')
    // when no engine is configured, so the route can distinguish success from absence.
    //
    // These tests use a minimal bureau stub that provides the subset of the Bureau
    // interface consumed by createGateway at construction time, with the target
    // method (signalSession / updateSession / querySession) resolving successfully.

    it('POST /api/v1/sessions/:id/signal returns 202 when signal is delivered (not 501)', async () => {
      // Build a stub bureau where signalSession resolves (simulating a configured
      // durable engine that delivered the signal). Before the fix this route would
      // inspect the void return value, see undefined, and respond 501 NOT_CONFIGURED.
      const stubBureau = makeStubBureau({ signalSession: async () => undefined });
      const gateway = await createTestGateway(stubBureau, { authToken: AUTH_TOKEN });

      const response = await requestJSON(gateway, '/api/v1/sessions/my-session/signal', {
        method: 'POST',
        headers: sessionWriteHeaders,
        body: JSON.stringify({ name: 'human-approved', payload: { ok: true } }),
      });

      expect(response.status).toBe(202);
      const body = await response.json();
      expect(body.status).toBe('delivered');
    });

    it('POST /api/v1/sessions/:id/signal returns 409 for revoked authority', async () => {
      const stubBureau = makeStubBureau({
        signalSession: async () => {
          throw new BureauError('Request authority is no longer valid', 'CONFLICT');
        },
      });
      const gateway = await createTestGateway(stubBureau, { authToken: AUTH_TOKEN });

      const response = await requestJSON(gateway, '/api/v1/sessions/my-session/signal', {
        method: 'POST',
        headers: sessionWriteHeaders,
        body: JSON.stringify({ name: 'human-approved' }),
      });

      expect(response.status).toBe(409);
    });

    it('POST /api/v1/sessions/:id/update returns 200 when handler returns undefined', async () => {
      // A void update handler that intentionally returns undefined must not be
      // misidentified as "not configured". Before the fix the route treated any
      // undefined result as the not-configured sentinel and responded 501.
      const stubBureau = makeStubBureau({ updateSession: async () => undefined });
      const gateway = await createTestGateway(stubBureau, { authToken: AUTH_TOKEN });

      const response = await requestJSON(gateway, '/api/v1/sessions/my-session/update', {
        method: 'POST',
        headers: sessionWriteHeaders,
        body: JSON.stringify({ name: 'void-update' }),
      });

      expect(response.status).toBe(200);
      // undefined serialises as absent key in JSON — the important thing is 200, not 501.
      const body = await response.json();
      expect(body).not.toHaveProperty('error');
    });

    it('POST /api/v1/sessions/:id/update returns 409 for revoked authority', async () => {
      const stubBureau = makeStubBureau({
        updateSession: async () => {
          throw new BureauError('Request authority is no longer valid', 'CONFLICT');
        },
      });
      const gateway = await createTestGateway(stubBureau, { authToken: AUTH_TOKEN });

      const response = await requestJSON(gateway, '/api/v1/sessions/my-session/update', {
        method: 'POST',
        headers: sessionWriteHeaders,
        body: JSON.stringify({ name: 'adjust-params' }),
      });

      expect(response.status).toBe(409);
    });

    // AB-192: updateSession/querySession unconditionally throw
    // BureauError('UNSUPPORTED_CAPABILITY') once a durable engine is
    // configured (the built-in agentRun workflow registers no
    // ctx.onUpdate/ctx.onQuery handler). The gateway must map that code to
    // 501, distinct from the NOT_CONFIGURED-no-engine-at-all 501 case above.

    it('POST /api/v1/sessions/:id/update returns 501 with code UNSUPPORTED_CAPABILITY when the built-in workflow has no update handler', async () => {
      const stubBureau = makeStubBureau({
        updateSession: async () => {
          throw new BureauError(
            'updateSession()/querySession() are unsupported: the built-in agentRun workflow registers no ctx.onUpdate/ctx.onQuery handler.',
            'UNSUPPORTED_CAPABILITY',
          );
        },
      });
      const gateway = await createTestGateway(stubBureau, { authToken: AUTH_TOKEN });

      const response = await requestJSON(gateway, '/api/v1/sessions/my-session/update', {
        method: 'POST',
        headers: sessionWriteHeaders,
        body: JSON.stringify({ name: 'adjust-params' }),
      });

      expect(response.status).toBe(501);
      const body = await response.json();
      expect(body.error.code).toBe('UNSUPPORTED_CAPABILITY');
    });

    it('GET /api/v1/sessions/:id/query returns 501 with code UNSUPPORTED_CAPABILITY when the built-in workflow has no query handler', async () => {
      const stubBureau = makeStubBureau({
        querySession: async () => {
          throw new BureauError(
            'updateSession()/querySession() are unsupported: the built-in agentRun workflow registers no ctx.onUpdate/ctx.onQuery handler.',
            'UNSUPPORTED_CAPABILITY',
          );
        },
      });
      const gateway = await createTestGateway(stubBureau, { authToken: AUTH_TOKEN });

      const response = await requestJSON(gateway, '/api/v1/sessions/my-session/query?name=check', {
        headers: authHeaders,
      });

      expect(response.status).toBe(501);
      const body = await response.json();
      expect(body.error.code).toBe('UNSUPPORTED_CAPABILITY');
    });

    it('GET /api/v1/sessions/:id/query returns 200 when handler returns undefined', async () => {
      // A query handler that legitimately returns undefined must not be treated
      // as "not configured". Before the fix the route responded 501 in this case.
      const stubBureau = makeStubBureau({ querySession: async () => undefined });
      const gateway = await createTestGateway(stubBureau, { authToken: AUTH_TOKEN });

      const response = await requestJSON(gateway, '/api/v1/sessions/my-session/query?name=check', {
        headers: authHeaders,
      });

      expect(response.status).toBe(200);
      // undefined serialises as absent key in JSON — the important thing is 200, not 501.
      const body = await response.json();
      expect(body).not.toHaveProperty('error');
    });
  });

  describe('POST /api/v1/sessions/:id/input (AB-196)', () => {
    const minimalValidBody = {
      deliveryMode: 'steer' as const,
      payload: 'Hello from the caller',
    };

    it('returns 202 with the receipt for an "admitted" outcome', async () => {
      const receipt = {
        id: 'input-1',
        sessionId: 'my-session',
        deliveryMode: 'steer',
        admissionSequence: 1,
        revision: 1,
        state: 'accepted',
        admittedAt: '2026-09-02T00:00:00.000Z',
      };
      const stubBureau = makeStubBureau({
        submitSessionInput: async () => ({ outcome: 'admitted', receipt }),
      });
      const gateway = await createTestGateway(stubBureau, { authToken: AUTH_TOKEN });

      const response = await requestJSON(gateway, '/api/v1/sessions/my-session/input', {
        method: 'POST',
        headers: sessionWriteHeaders,
        body: JSON.stringify(minimalValidBody),
      });

      expect(response.status).toBe(202);
      const body = await response.json();
      expect(body).toEqual({ outcome: 'admitted', receipt });
    });

    it('returns 202 with the receipt for a "replayed" outcome', async () => {
      const receipt = {
        id: 'input-1',
        sessionId: 'my-session',
        deliveryMode: 'steer',
        admissionSequence: 1,
        revision: 1,
        state: 'accepted',
        admittedAt: '2026-09-02T00:00:00.000Z',
      };
      const stubBureau = makeStubBureau({
        submitSessionInput: async () => ({ outcome: 'replayed', receipt }),
      });
      const gateway = await createTestGateway(stubBureau, { authToken: AUTH_TOKEN });

      const response = await requestJSON(gateway, '/api/v1/sessions/my-session/input', {
        method: 'POST',
        headers: sessionWriteHeaders,
        body: JSON.stringify({ ...minimalValidBody, id: 'input-1' }),
      });

      expect(response.status).toBe(202);
      const body = await response.json();
      expect(body).toEqual({ outcome: 'replayed', receipt });
    });

    it('returns 409 with the conflict detail for a "conflict" outcome', async () => {
      const conflict = {
        id: 'input-1',
        reason: 'id-owned-by-other-principal',
        originalReceipt: {
          id: 'input-1',
          sessionId: 'my-session',
          deliveryMode: 'steer',
          admissionSequence: 1,
          revision: 1,
          state: 'accepted',
          admittedAt: '2026-09-02T00:00:00.000Z',
        },
      };
      const stubBureau = makeStubBureau({
        submitSessionInput: async () => ({ outcome: 'conflict', conflict }),
      });
      const gateway = await createTestGateway(stubBureau, { authToken: AUTH_TOKEN });

      const response = await requestJSON(gateway, '/api/v1/sessions/my-session/input', {
        method: 'POST',
        headers: sessionWriteHeaders,
        body: JSON.stringify({ ...minimalValidBody, id: 'input-1' }),
      });

      expect(response.status).toBe(409);
      const body = await response.json();
      expect(body.error.code).toBe('CONFLICT');
      expect(body.error.conflict).toEqual(conflict);
    });

    it('returns 404 for a "not-found" outcome', async () => {
      const stubBureau = makeStubBureau({
        submitSessionInput: async () => ({ outcome: 'not-found' }),
      });
      const gateway = await createTestGateway(stubBureau, { authToken: AUTH_TOKEN });

      const response = await requestJSON(gateway, '/api/v1/sessions/my-session/input', {
        method: 'POST',
        headers: sessionWriteHeaders,
        body: JSON.stringify(minimalValidBody),
      });

      expect(response.status).toBe(404);
    });

    it('returns 410 for a "session-terminal" outcome', async () => {
      const stubBureau = makeStubBureau({
        submitSessionInput: async () => ({
          outcome: 'session-terminal',
          sessionId: 'my-session',
        }),
      });
      const gateway = await createTestGateway(stubBureau, { authToken: AUTH_TOKEN });

      const response = await requestJSON(gateway, '/api/v1/sessions/my-session/input', {
        method: 'POST',
        headers: sessionWriteHeaders,
        body: JSON.stringify(minimalValidBody),
      });

      expect(response.status).toBe(410);
      const body = await response.json();
      expect(body.error.code).toBe('SESSION_TERMINAL');
    });

    it('returns 501 for an "unsupported-capability" outcome', async () => {
      const stubBureau = makeStubBureau({
        submitSessionInput: async () => ({
          outcome: 'unsupported-capability',
          reason: 'durable-mailbox-unavailable',
        }),
      });
      const gateway = await createTestGateway(stubBureau, { authToken: AUTH_TOKEN });

      const response = await requestJSON(gateway, '/api/v1/sessions/my-session/input', {
        method: 'POST',
        headers: sessionWriteHeaders,
        body: JSON.stringify(minimalValidBody),
      });

      expect(response.status).toBe(501);
      const body = await response.json();
      expect(body.error.code).toBe('UNSUPPORTED_CAPABILITY');
      expect(body.error.message).toBe('durable-mailbox-unavailable');
    });

    it('returns 429 for a "backlog-exhausted" outcome', async () => {
      const stubBureau = makeStubBureau({
        submitSessionInput: async () => ({
          outcome: 'backlog-exhausted',
          scope: 'session',
          limit: 64,
        }),
      });
      const gateway = await createTestGateway(stubBureau, { authToken: AUTH_TOKEN });

      const response = await requestJSON(gateway, '/api/v1/sessions/my-session/input', {
        method: 'POST',
        headers: sessionWriteHeaders,
        body: JSON.stringify(minimalValidBody),
      });

      expect(response.status).toBe(429);
      const body = await response.json();
      expect(body.error.code).toBe('BACKLOG_EXHAUSTED');
      expect(body.error.scope).toBe('session');
      expect(body.error.limit).toBe(64);
    });

    it('returns 400 for an invalid JSON body, before submitSessionInput is called', async () => {
      let called = false;
      const stubBureau = makeStubBureau({
        submitSessionInput: async () => {
          called = true;
          return { outcome: 'not-found' };
        },
      });
      const gateway = await createTestGateway(stubBureau, { authToken: AUTH_TOKEN });

      const response = await requestJSON(gateway, '/api/v1/sessions/my-session/input', {
        method: 'POST',
        headers: sessionWriteHeaders,
        body: '{not-json',
      });

      expect(response.status).toBe(400);
      expect(called).toBe(false);
    });

    it('returns 400 for a schema-invalid body (missing deliveryMode), before submitSessionInput is called', async () => {
      let called = false;
      const stubBureau = makeStubBureau({
        submitSessionInput: async () => {
          called = true;
          return { outcome: 'not-found' };
        },
      });
      const gateway = await createTestGateway(stubBureau, { authToken: AUTH_TOKEN });

      const response = await requestJSON(gateway, '/api/v1/sessions/my-session/input', {
        method: 'POST',
        headers: sessionWriteHeaders,
        body: JSON.stringify({ payload: 'Hello' }),
      });

      expect(response.status).toBe(400);
      expect(called).toBe(false);
    });

    it('returns 400 for a non-ISO expiresAt, before submitSessionInput is called', async () => {
      let called = false;
      const stubBureau = makeStubBureau({
        submitSessionInput: async () => {
          called = true;
          return { outcome: 'not-found' };
        },
      });
      const gateway = await createTestGateway(stubBureau, { authToken: AUTH_TOKEN });

      const response = await requestJSON(gateway, '/api/v1/sessions/my-session/input', {
        method: 'POST',
        headers: sessionWriteHeaders,
        body: JSON.stringify({ deliveryMode: 'steer', payload: 'hi', expiresAt: 'never' }),
      });

      expect(response.status).toBe(400);
      expect(called).toBe(false);
    });

    it('accepts an ISO-8601 expiresAt with a numeric offset', async () => {
      let receivedRequest: unknown;
      const stubBureau = makeStubBureau({
        submitSessionInput: async (_sessionId: string, request: unknown) => {
          receivedRequest = request;
          return { outcome: 'not-found' };
        },
      });
      const gateway = await createTestGateway(stubBureau, { authToken: AUTH_TOKEN });

      const response = await requestJSON(gateway, '/api/v1/sessions/my-session/input', {
        method: 'POST',
        headers: sessionWriteHeaders,
        body: JSON.stringify({
          deliveryMode: 'steer',
          payload: 'hi',
          expiresAt: '2026-09-02T00:00:00+02:00',
        }),
      });

      expect(response.status).toBe(404);
      expect((receivedRequest as { expiresAt: string }).expiresAt).toBe(
        '2026-09-02T00:00:00+02:00',
      );
    });

    it('always resolves principal from the authenticated caller, ignoring a body-supplied principal', async () => {
      let receivedRequest: unknown;
      const stubBureau = makeStubBureau({
        submitSessionInput: async (_sessionId: string, request: unknown) => {
          receivedRequest = request;
          return { outcome: 'not-found' };
        },
      });
      const gateway = await createTestGateway(stubBureau, { authToken: AUTH_TOKEN });

      const response = await requestJSON(gateway, '/api/v1/sessions/my-session/input', {
        method: 'POST',
        headers: sessionWriteHeaders,
        body: JSON.stringify({ ...minimalValidBody, principal: 'attacker-supplied-principal' }),
      });

      expect(response.status).toBe(404);
      expect(receivedRequest).toMatchObject({
        deliveryMode: 'steer',
        payload: minimalValidBody.payload,
      });
      // `sessionWriteHeaders` authenticates via the static bearer token, which
      // `resolvePrincipal` (`middleware/authentication.ts:60`) always resolves
      // to the literal string `'static-token'` — assert equality, not just
      // inequality with the spoofed value, so a future regression that swaps
      // in some other wrong-but-not-attacker-supplied principal still fails.
      expect((receivedRequest as { principal: string }).principal).toBe('static-token');
    });

    it('admits a text/image/document payload array (the three UserAdmissibleContent variants)', async () => {
      let receivedRequest: unknown;
      const receipt = {
        id: 'input-1',
        sessionId: 'my-session',
        deliveryMode: 'queue',
        admissionSequence: 1,
        revision: 1,
        state: 'queued',
        admittedAt: '2026-09-02T00:00:00.000Z',
      };
      const stubBureau = makeStubBureau({
        submitSessionInput: async (_sessionId: string, request: unknown) => {
          receivedRequest = request;
          return { outcome: 'admitted', receipt };
        },
      });
      const gateway = await createTestGateway(stubBureau, { authToken: AUTH_TOKEN });

      const payload = [
        { type: 'text', text: 'Look at this' },
        { type: 'image', url: 'https://example.com/cat.png', mimeType: 'image/png' },
        {
          type: 'document',
          name: 'report.pdf',
          mimeType: 'application/pdf',
          source: { kind: 'reference', uri: 'https://example.com/report.pdf' },
        },
        {
          type: 'document',
          name: 'inline.txt',
          mimeType: 'text/plain',
          source: { kind: 'base64', data: 'aGVsbG8=' },
        },
      ];

      const response = await requestJSON(gateway, '/api/v1/sessions/my-session/input', {
        method: 'POST',
        headers: sessionWriteHeaders,
        body: JSON.stringify({ deliveryMode: 'queue', payload }),
      });

      expect(response.status).toBe(202);
      expect((receivedRequest as { payload: unknown }).payload).toEqual(payload);
    });

    // AB-42's coordinator amendments (2026-09-02), applied by AB-202: the six
    // provider-generated/response-only `MultiModalContent` variants are
    // excluded from `UserAdmissibleContent` at the type level, and
    // "enforced at runtime by the gateway request schema (AB-196), which
    // rejects them with 400" (documentation/operative-type-safe-api.md's
    // "Session input admission" section). Table-driven so every excluded
    // discriminant is proven rejected, not just one representative.
    const excludedContentBlocks: Array<{ label: string; block: Record<string, unknown> }> = [
      {
        label: 'thinking',
        block: { type: 'thinking', thinking: 'secret reasoning', signature: 'sig' },
      },
      {
        label: 'redacted_thinking',
        block: { type: 'redacted_thinking', data: 'opaque' },
      },
      {
        label: 'server_tool_use',
        block: { type: 'server_tool_use', id: 'tool-1', name: 'web_search', input: {} },
      },
      {
        label: 'web_search_tool_result',
        block: { type: 'web_search_tool_result', tool_use_id: 'tool-1', content: [] },
      },
      // All four `ServerToolResultType` discriminants (packages/conversationalist/src/multi-modal.ts)
      // are covered individually — the allowlist is enforced purely by `type`
      // discrimination, so each one needs its own failing case to guard
      // against a future schema change accidentally admitting one of them.
      {
        label: 'code_execution_tool_result',
        block: { type: 'code_execution_tool_result', tool_use_id: 'tool-1', content: {} },
      },
      {
        label: 'bash_code_execution_tool_result',
        block: { type: 'bash_code_execution_tool_result', tool_use_id: 'tool-1', content: {} },
      },
      {
        label: 'text_editor_code_execution_tool_result',
        block: {
          type: 'text_editor_code_execution_tool_result',
          tool_use_id: 'tool-1',
          content: {},
        },
      },
      {
        label: 'web_fetch_tool_result',
        block: { type: 'web_fetch_tool_result', tool_use_id: 'tool-1', content: {} },
      },
      {
        label: 'container_upload',
        block: { type: 'container_upload', file_id: 'file-1' },
      },
    ];

    for (const { label, block } of excludedContentBlocks) {
      it(`rejects a "${label}" content block with 400 (excluded by AB-42/AB-202)`, async () => {
        const stubBureau = makeStubBureau({
          submitSessionInput: async () => ({ outcome: 'admitted', receipt: {} }),
        });
        const gateway = await createTestGateway(stubBureau, { authToken: AUTH_TOKEN });

        const response = await requestJSON(gateway, '/api/v1/sessions/my-session/input', {
          method: 'POST',
          headers: sessionWriteHeaders,
          body: JSON.stringify({ deliveryMode: 'steer', payload: [block] }),
        });

        expect(response.status).toBe(400);
      });
    }

    it('rejects a text content block carrying citations with 400 (structurally forbidden)', async () => {
      const stubBureau = makeStubBureau({
        submitSessionInput: async () => ({ outcome: 'admitted', receipt: {} }),
      });
      const gateway = await createTestGateway(stubBureau, { authToken: AUTH_TOKEN });

      const response = await requestJSON(gateway, '/api/v1/sessions/my-session/input', {
        method: 'POST',
        headers: sessionWriteHeaders,
        body: JSON.stringify({
          deliveryMode: 'steer',
          payload: [{ type: 'text', text: 'hi', citations: [{ url: 'https://example.com' }] }],
        }),
      });

      expect(response.status).toBe(400);
    });
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
