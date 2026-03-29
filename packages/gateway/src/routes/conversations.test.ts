import { describe, expect, it } from 'bun:test';
import { Conversation, toSessionInfo } from 'conversationalist';
import { createMemoryKeyValueStore } from 'storage';

import { createTestGateway, requestJSON } from '../test';

const AUTH_TOKEN = 'test-token';
const authHeaders = { authorization: `Bearer ${AUTH_TOKEN}` };

describe('conversations routes', () => {
  it('returns 501 when no persistence adapter is configured', async () => {
    const gateway = await createTestGateway({ authToken: AUTH_TOKEN });
    const response = await requestJSON(gateway, '/api/v1/conversations', {
      headers: authHeaders,
    });
    expect(response.status).toBe(501);
    const body = await response.json();
    expect(body.error.code).toBe('NOT_IMPLEMENTED');
  });

  it('GET /api/v1/conversations returns session list', async () => {
    const kv = createMemoryKeyValueStore();
    const conversation = new Conversation();
    conversation.appendUserMessage('Hello');
    await kv.set(`session:${conversation.current.id}`, JSON.stringify(conversation.current));
    await kv.set(
      `session-info:${conversation.current.id}`,
      JSON.stringify(toSessionInfo(conversation.current)),
    );

    const gateway = await createTestGateway({ persistence: kv, authToken: AUTH_TOKEN });
    const response = await requestJSON(gateway, '/api/v1/conversations', {
      headers: authHeaders,
    });
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body).toHaveLength(1);
    expect(body[0].id).toBe(conversation.current.id);
  });

  it('GET /api/v1/conversations/:id returns a session', async () => {
    const kv = createMemoryKeyValueStore();
    const conversation = new Conversation();
    conversation.appendUserMessage('Hello');
    await kv.set(`session:${conversation.current.id}`, JSON.stringify(conversation.current));

    const gateway = await createTestGateway({ persistence: kv, authToken: AUTH_TOKEN });
    const response = await requestJSON(
      gateway,
      `/api/v1/conversations/${conversation.current.id}`,
      { headers: authHeaders },
    );
    expect(response.status).toBe(200);
  });

  it('GET /api/v1/conversations/:id returns 404 for missing session', async () => {
    const kv = createMemoryKeyValueStore();
    const gateway = await createTestGateway({ persistence: kv, authToken: AUTH_TOKEN });
    const response = await requestJSON(gateway, '/api/v1/conversations/missing', {
      headers: authHeaders,
    });
    expect(response.status).toBe(404);
  });

  it('DELETE /api/v1/conversations/:id removes a session', async () => {
    const kv = createMemoryKeyValueStore();
    const conversation = new Conversation();
    conversation.appendUserMessage('Hello');
    await kv.set(`session:${conversation.current.id}`, JSON.stringify(conversation.current));
    await kv.set(
      `session-info:${conversation.current.id}`,
      JSON.stringify(toSessionInfo(conversation.current)),
    );
    const sessionId = conversation.current.id;

    const gateway = await createTestGateway({ persistence: kv, authToken: AUTH_TOKEN });
    const deleteResponse = await requestJSON(gateway, `/api/v1/conversations/${sessionId}`, {
      method: 'DELETE',
      headers: authHeaders,
    });
    expect(deleteResponse.status).toBe(204);

    const getResponse = await requestJSON(gateway, `/api/v1/conversations/${sessionId}`, {
      headers: authHeaders,
    });
    expect(getResponse.status).toBe(404);
  });
});
