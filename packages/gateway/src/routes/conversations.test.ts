import { describe, expect, it } from 'bun:test';
import { Conversation, createInMemoryPersistenceAdapter } from 'conversationalist';

import { createTestGateway, requestJSON } from '../test';

describe('conversations routes', () => {
  it('returns 501 when no persistence adapter is configured', async () => {
    const gateway = createTestGateway();
    const response = await requestJSON(gateway, '/api/v1/conversations');
    expect(response.status).toBe(501);
    const body = await response.json();
    expect(body.error.code).toBe('NOT_IMPLEMENTED');
  });

  it('GET /api/v1/conversations returns session list', async () => {
    const persistence = createInMemoryPersistenceAdapter();
    const conversation = new Conversation();
    conversation.appendUserMessage('Hello');
    await persistence.save(conversation.current);

    const gateway = createTestGateway({ persistence });
    const response = await requestJSON(gateway, '/api/v1/conversations');
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body).toHaveLength(1);
    expect(body[0].id).toBe(conversation.current.id);
  });

  it('GET /api/v1/conversations/:id returns a session', async () => {
    const persistence = createInMemoryPersistenceAdapter();
    const conversation = new Conversation();
    conversation.appendUserMessage('Hello');
    await persistence.save(conversation.current);

    const gateway = createTestGateway({ persistence });
    const response = await requestJSON(gateway, `/api/v1/conversations/${conversation.current.id}`);
    expect(response.status).toBe(200);
  });

  it('GET /api/v1/conversations/:id returns 404 for missing session', async () => {
    const persistence = createInMemoryPersistenceAdapter();
    const gateway = createTestGateway({ persistence });
    const response = await requestJSON(gateway, '/api/v1/conversations/missing');
    expect(response.status).toBe(404);
  });

  it('DELETE /api/v1/conversations/:id removes a session', async () => {
    const persistence = createInMemoryPersistenceAdapter();
    const conversation = new Conversation();
    conversation.appendUserMessage('Hello');
    await persistence.save(conversation.current);
    const sessionId = conversation.current.id;

    const gateway = createTestGateway({ persistence });
    const deleteResponse = await requestJSON(gateway, `/api/v1/conversations/${sessionId}`, {
      method: 'DELETE',
    });
    expect(deleteResponse.status).toBe(204);

    const getResponse = await requestJSON(gateway, `/api/v1/conversations/${sessionId}`);
    expect(getResponse.status).toBe(404);
  });
});
