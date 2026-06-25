import { describe, expect, it } from 'bun:test';
import type { GenerateFunction } from 'operative';

import { createTestGateway, requestJSON } from '../test';

function createMockGenerate(): GenerateFunction {
  return async () => ({ content: 'Done.', toolCalls: [] });
}

/** Minimal valid chat completion request body. */
function minimalRequest(model: string, userMessage: string): string {
  return JSON.stringify({
    model,
    messages: [{ role: 'user', content: userMessage }],
  });
}

describe('OpenAI-compat route (POST /v1/chat/completions)', () => {
  it('returns 422 when model field is missing', async () => {
    const gateway = await createTestGateway({ generate: createMockGenerate() });
    const response = await requestJSON(gateway, '/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ messages: [{ role: 'user', content: 'Hi' }] }),
    });
    expect(response.status).toBe(422);
  });

  it('returns 422 when model field is an empty string', async () => {
    const gateway = await createTestGateway({ generate: createMockGenerate() });
    const response = await requestJSON(gateway, '/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        model: '',
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    });
    expect(response.status).toBe(422);
  });

  it('returns 422 when messages array is empty', async () => {
    const gateway = await createTestGateway({ generate: createMockGenerate() });
    const response = await requestJSON(gateway, '/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'bureau', messages: [] }),
    });
    expect(response.status).toBe(422);
  });

  it('returns 400 with invalid JSON body', async () => {
    const gateway = await createTestGateway({ generate: createMockGenerate() });
    const response = await requestJSON(gateway, '/v1/chat/completions', {
      method: 'POST',
      body: 'not-json',
    });
    expect(response.status).toBe(400);
  });

  it('returns 503 when no generate is configured', async () => {
    const gateway = await createTestGateway();
    const response = await requestJSON(gateway, '/v1/chat/completions', {
      method: 'POST',
      body: minimalRequest('bureau', 'Hello'),
    });
    expect(response.status).toBe(503);
  });

  it('dispatches using model field as agent name and returns 200', async () => {
    const gateway = await createTestGateway({ generate: createMockGenerate() });
    const response = await requestJSON(gateway, '/v1/chat/completions', {
      method: 'POST',
      body: minimalRequest('bureau', 'What is 2 + 2?'),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.object).toBe('chat.completion');
    expect(body.model).toBe('bureau');
    expect(body.choices).toBeArrayOfSize(1);
    expect(body.choices[0].message.role).toBe('assistant');
    expect(body.id).toBeString();
    expect(body.created).toBeNumber();
  });

  it('returns SSE stream when stream: true is set', async () => {
    const gateway = await createTestGateway({ generate: createMockGenerate() });
    const response = await requestJSON(gateway, '/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        model: 'bureau',
        messages: [{ role: 'user', content: 'Stream this' }],
        stream: true,
      }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('text/event-stream');
    const text = await response.text();
    expect(text).toContain('data:');
    expect(text).toContain('[DONE]');
  });

  it('handles system messages by extracting them as the system prompt', async () => {
    const gateway = await createTestGateway({ generate: createMockGenerate() });
    const response = await requestJSON(gateway, '/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        model: 'bureau',
        messages: [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user', content: 'Hello' },
        ],
      }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.choices[0].message.role).toBe('assistant');
  });

  it('handles multi-turn conversation by including prior context in the message', async () => {
    const gateway = await createTestGateway({ generate: createMockGenerate() });
    const response = await requestJSON(gateway, '/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        model: 'bureau',
        messages: [
          { role: 'user', content: 'What is the capital of France?' },
          { role: 'assistant', content: 'Paris.' },
          { role: 'user', content: 'And Germany?' },
        ],
      }),
    });
    expect(response.status).toBe(200);
  });

  it('typed dispatch: model field names the agent directly with no routing', async () => {
    // Demonstrates that the model field is used as-is for dispatch — any
    // valid non-empty string is accepted and passed as the agent name.
    // The bureau currently has a single "bureau" agent; using a different
    // name goes through but may produce a run with that name metadata.
    const gateway = await createTestGateway({ generate: createMockGenerate() });
    const response = await requestJSON(gateway, '/v1/chat/completions', {
      method: 'POST',
      body: minimalRequest('my-custom-agent', 'Hello'),
    });
    // The gateway dispatches the name directly — validation of whether the
    // agent exists happens at the bureau layer (currently single-agent).
    // A non-existent agent in the current single-agent bureau still runs
    // (the name is carried as metadata). This test verifies the dispatch
    // shape, not multi-agent resolution (which is Phase E work).
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.model).toBe('my-custom-agent');
  });
});
