import { createTool, createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import type { GenerateContext, GenerateFunction } from 'operative';
import { noToolCalls } from 'operative/conditions';
import { z } from 'zod';

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

  it('response content reflects the run output, not an empty string (regression: race with async provider loop)', async () => {
    // Regression: the route previously called bureau.getRun() synchronously
    // after createRun() returned, before the provider loop completed. This
    // caused stepDetails to be empty and content to be "" with any real async
    // provider. The route must await the run's result before reading content.
    const gateway = await createTestGateway({ generate: createMockGenerate() });
    const response = await requestJSON(gateway, '/v1/chat/completions', {
      method: 'POST',
      body: minimalRequest('bureau', 'What is 2 + 2?'),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.choices[0].message.content).toBe('Done.');
  });

  it('SSE stream content reflects the run output, not an empty string (regression: race with async provider loop)', async () => {
    // Regression: same race as above but for the SSE path.
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
    const text = await response.text();
    // The content chunk must contain the actual provider output, not an
    // empty string produced before the run settled.
    expect(text).toContain('"Done."');
  });

  describe('max_tokens regression: must not cap agent loop ITERATIONS', () => {
    it('a tool-using run completes multiple steps when max_tokens is set (was broken: maximumSteps:1)', async () => {
      // Regression: the old code mapped max_tokens → maximumSteps:1, which
      // stopped the agent loop after ONE STEP even when the agent needed to
      // call tools and observe the results. The fix maps max_tokens →
      // maximumTokens (a PER-CALL output cap), allowing the loop to run to
      // natural completion.
      //
      // This test is RED on the old `maximumSteps: 1` mapping and GREEN on the
      // new `maximumTokens` mapping.
      const callCount = { value: 0 };
      const echoPingTool = createTool({
        name: 'echo_ping',
        description: 'ping',
        input: z.object({}),
        execute: async () => 'pong',
      });

      // Step 0: return a tool call. Step 1: return the final text (no tool calls → noToolCalls fires).
      const generate: GenerateFunction = async (context: GenerateContext) => {
        callCount.value++;
        if (context.step === 0) {
          return { content: '', toolCalls: [{ name: 'echo_ping', arguments: {} }] };
        }
        return { content: 'Finished after tool.', toolCalls: [] };
      };

      const gateway = await createTestGateway({
        generate,
        toolbox: createToolbox([echoPingTool]),
        stopWhen: noToolCalls(),
      });

      const response = await requestJSON(gateway, '/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({
          model: 'bureau',
          messages: [{ role: 'user', content: 'Use the ping tool.' }],
          max_tokens: 256,
        }),
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      // The run must have gone to step 1 (two generate calls) to produce
      // the final content. Under the old maximumSteps:1 bug, callCount.value
      // would be 1 and content would be empty/missing.
      expect(callCount.value).toBe(2);
      expect(body.choices[0].message.content).toBe('Finished after tool.');
    });

    it('max_tokens value flows as maximumTokens on the CreateRunRequest (not maximumSteps)', async () => {
      // Verify the actual mapping at the gateway layer. The captured generate
      // context should carry maximumTokens (the provider receives it).
      const capturedContexts: GenerateContext[] = [];
      const generate: GenerateFunction = async (context: GenerateContext) => {
        capturedContexts.push(context);
        return { content: 'ok', toolCalls: [] };
      };

      const gateway = await createTestGateway({
        generate,
        stopWhen: noToolCalls(),
      });
      const response = await requestJSON(gateway, '/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({
          model: 'bureau',
          messages: [{ role: 'user', content: 'Hello' }],
          max_tokens: 128,
        }),
      });

      expect(response.status).toBe(200);
      expect(capturedContexts.length).toBeGreaterThanOrEqual(1);
      // The GenerateContext must carry maximumTokens=128 (not undefined)
      for (const ctx of capturedContexts) {
        expect(ctx.maximumTokens).toBe(128);
      }
    });
  });
});
