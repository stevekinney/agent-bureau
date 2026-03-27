import { describe, expect, it } from 'bun:test';
import { Conversation, toSessionInfo } from 'conversationalist';
import { createMemoryKeyValueStore } from 'storage';

import { createTestGateway, requestJSON } from '../test';

describe('conversations routes', () => {
  it('returns 501 when no persistence adapter is configured', async () => {
    const gateway = await createTestGateway();
    const response = await requestJSON(gateway, '/api/v1/conversations');
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

    const gateway = await createTestGateway({ persistence: kv });
    const response = await requestJSON(gateway, '/api/v1/conversations');
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

    const gateway = await createTestGateway({ persistence: kv });
    const response = await requestJSON(gateway, `/api/v1/conversations/${conversation.current.id}`);
    expect(response.status).toBe(200);
  });

  it('GET /api/v1/conversations/:id returns 404 for missing session', async () => {
    const kv = createMemoryKeyValueStore();
    const gateway = await createTestGateway({ persistence: kv });
    const response = await requestJSON(gateway, '/api/v1/conversations/missing');
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

    const gateway = await createTestGateway({ persistence: kv });
    const deleteResponse = await requestJSON(gateway, `/api/v1/conversations/${sessionId}`, {
      method: 'DELETE',
    });
    expect(deleteResponse.status).toBe(204);

    const getResponse = await requestJSON(gateway, `/api/v1/conversations/${sessionId}`);
    expect(getResponse.status).toBe(404);
  });
});
