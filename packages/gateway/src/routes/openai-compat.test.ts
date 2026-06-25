import { describe, expect, it } from 'bun:test';

import { createTestGateway, requestJSON } from '../test';

const AUTH_TOKEN = 'test-token';
const authHeaders = { authorization: `Bearer ${AUTH_TOKEN}` };

describe('OpenAI-compat routes', () => {
  it('POST /v1/chat/completions returns a chat completion object', async () => {
    const gateway = await createTestGateway({
      authToken: AUTH_TOKEN,
      generate: async () => ({ content: 'Hello, world!', toolCalls: [] }),
    });

    const response = await requestJSON(gateway, '/v1/chat/completions', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        model: 'researcher',
        messages: [{ role: 'user', content: 'Say hello' }],
      }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.object).toBe('chat.completion');
    expect(Array.isArray(body.choices)).toBe(true);
    expect(body.choices[0].message.role).toBe('assistant');
    expect(typeof body.usage?.prompt_tokens).toBe('number');
    expect(typeof body.usage?.completion_tokens).toBe('number');
    expect(typeof body.usage?.total_tokens).toBe('number');
  });

  it('uses the model field as the agent name (typed dispatch)', async () => {
    const gateway = await createTestGateway({
      authToken: AUTH_TOKEN,
      generate: async () => ({ content: 'Writer response', toolCalls: [] }),
    });

    const response = await requestJSON(gateway, '/v1/chat/completions', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        model: 'writer',
        messages: [{ role: 'user', content: 'Write something' }],
      }),
    });

    expect(response.status).toBe(200);
  });

  it('extracts system message from messages array', async () => {
    const gateway = await createTestGateway({
      authToken: AUTH_TOKEN,
      generate: async () => ({ content: 'Done', toolCalls: [] }),
    });

    const response = await requestJSON(gateway, '/v1/chat/completions', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        model: 'agent',
        messages: [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user', content: 'Hello' },
        ],
      }),
    });

    expect(response.status).toBe(200);
  });

  it('respects the system field override', async () => {
    const gateway = await createTestGateway({
      authToken: AUTH_TOKEN,
      generate: async () => ({ content: 'Done', toolCalls: [] }),
    });

    const response = await requestJSON(gateway, '/v1/chat/completions', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        model: 'agent',
        messages: [{ role: 'user', content: 'Hello' }],
        system: 'You are a custom assistant.',
      }),
    });

    expect(response.status).toBe(200);
  });

  it('returns 400 when model is missing', async () => {
    const gateway = await createTestGateway({
      authToken: AUTH_TOKEN,
      generate: async () => ({ content: 'Done', toolCalls: [] }),
    });

    const response = await requestJSON(gateway, '/v1/chat/completions', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'Hello' }],
      }),
    });

    expect(response.status).toBe(400);
  });

  it('returns 400 when messages is empty', async () => {
    const gateway = await createTestGateway({
      authToken: AUTH_TOKEN,
      generate: async () => ({ content: 'Done', toolCalls: [] }),
    });

    const response = await requestJSON(gateway, '/v1/chat/completions', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        model: 'agent',
        messages: [],
      }),
    });

    expect(response.status).toBe(400);
  });

  it('returns 400 when no user message is present', async () => {
    const gateway = await createTestGateway({
      authToken: AUTH_TOKEN,
      generate: async () => ({ content: 'Done', toolCalls: [] }),
    });

    const response = await requestJSON(gateway, '/v1/chat/completions', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        model: 'agent',
        messages: [{ role: 'system', content: 'You are an assistant.' }],
      }),
    });

    expect(response.status).toBe(400);
  });

  it('returns 400 on invalid JSON', async () => {
    const gateway = await createTestGateway({
      authToken: AUTH_TOKEN,
      generate: async () => ({ content: 'Done', toolCalls: [] }),
    });

    const response = await gateway.app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${AUTH_TOKEN}`, 'content-type': 'application/json' },
      body: 'not-json',
    });

    expect(response.status).toBe(400);
  });

  it('uses session_id for conversation continuity', async () => {
    const gateway = await createTestGateway({
      authToken: AUTH_TOKEN,
      generate: async () => ({ content: 'Session response', toolCalls: [] }),
    });

    const sessionId = 'my-session-123';

    const response = await requestJSON(gateway, '/v1/chat/completions', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        model: 'agent',
        messages: [{ role: 'user', content: 'Hello' }],
        session_id: sessionId,
      }),
    });

    expect(response.status).toBe(200);
  });

  it('stream: true returns SSE data ending with [DONE]', async () => {
    const gateway = await createTestGateway({
      authToken: AUTH_TOKEN,
      generate: async () => ({ content: 'Streaming response', toolCalls: [] }),
    });

    const response = await requestJSON(gateway, '/v1/chat/completions', {
      method: 'POST',
      headers: { ...authHeaders, accept: 'text/event-stream' },
      body: JSON.stringify({
        model: 'agent',
        messages: [{ role: 'user', content: 'Hello' }],
        stream: true,
      }),
    });

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain('[DONE]');
  });
});
