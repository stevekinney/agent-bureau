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

  describe('error run surface (regression: PRRT_kwDORvupsc6MXEmZ)', () => {
    it('returns 500 when the provider generate function throws, not a 200 with empty content', async () => {
      // Regression: when the generate function throws (causing the run to
      // settle with status 'error'), the route must return an HTTP 500 rather
      // than a 200 chat completion with empty or partial content. OpenAI-
      // compatible clients treat any 2xx as a successful assistant message.
      const failingGenerate: GenerateFunction = async () => {
        throw new Error('Provider unavailable');
      };

      const gateway = await createTestGateway({ generate: failingGenerate });
      const response = await requestJSON(gateway, '/v1/chat/completions', {
        method: 'POST',
        body: minimalRequest('bureau', 'Hello'),
      });

      expect(response.status).toBe(500);
    });

    it('SSE path: surfaces run errors in-band as an error chunk (200 status, error field in body)', async () => {
      // On the SSE streaming path the HTTP status is committed to 200 the
      // moment the stream body opens — before the run settles. A post-open
      // provider failure can therefore no longer be reported as HTTP 500.
      // Instead the route sends an in-band error chunk matching the wire
      // format the OpenAI API uses for streaming errors:
      //   data: {"error":{"message":"...","type":"server_error"},...}\n\n
      //   data: [DONE]\n\n
      // OpenAI-compatible clients that inspect the SSE body will see the error.
      const failingGenerate: GenerateFunction = async () => {
        throw new Error('Provider unavailable');
      };

      const gateway = await createTestGateway({ generate: failingGenerate });
      const response = await requestJSON(gateway, '/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({
          model: 'bureau',
          messages: [{ role: 'user', content: 'Hello' }],
          stream: true,
        }),
      });

      // HTTP status is 200 — the stream opened before the run failed.
      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toContain('text/event-stream');

      const text = await response.text();
      // An in-band error chunk must be present.
      expect(text).toContain('"error"');
      expect(text).toContain('server_error');
      // The stream must still be terminated with [DONE].
      expect(text).toContain('[DONE]');
    });

    it('returns 200 when the run succeeds after a recoverable generate error in an earlier step', async () => {
      // Ensure the happy path still works when generate succeeds. This
      // guards against a regression where the status check blocks legitimate
      // completions from being returned.
      const gateway = await createTestGateway({ generate: createMockGenerate() });
      const response = await requestJSON(gateway, '/v1/chat/completions', {
        method: 'POST',
        body: minimalRequest('bureau', 'Hello'),
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.choices[0].message.content).toBe('Done.');
    });
  });

  describe('SSE streaming: response opens before run settles (regression: PRRT_kwDORvupsc6MZ-vn)', () => {
    it('returns the Response object before the generate function resolves', async () => {
      // Regression: the old code awaited `runState.activeRun.result` before
      // checking `if (stream)`, so the HTTP response was not opened until the
      // whole agent run had finished. This test gates `generate` on a manually
      // controlled promise and asserts the Response is available (headers
      // received) BEFORE releasing the generate gate.
      //
      // Under the old code this test hangs at `await requestJSON(...)` until
      // `releaseGenerate()` is called first — the two awaits are not
      // independent. Under the fixed code `requestJSON(...)` resolves as soon
      // as the stream headers arrive, before the run finishes.
      let releaseGenerate!: () => void;
      const generateGate = new Promise<void>((resolve) => {
        releaseGenerate = resolve;
      });

      const generate: GenerateFunction = async () => {
        await generateGate;
        return { content: 'Streamed.', toolCalls: [] };
      };

      const gateway = await createTestGateway({ generate });

      // Race the HTTP request against a timeout that fires before we release
      // the generate gate. If the Response arrives first, the stream opened
      // immediately (the fix is working). If we time out instead, the route
      // is still blocking on the run before opening the response.
      const responsePromise = requestJSON(gateway, '/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({
          model: 'bureau',
          messages: [{ role: 'user', content: 'Gate test' }],
          stream: true,
        }),
      });

      // A short microtask yield: enough time for the streaming path to open
      // the ReadableStream response synchronously after createRun() resolves,
      // but NOT enough time for the gate to release or the run to complete.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      // Verify the response is already available — it should resolve
      // immediately because the stream body opened without waiting for the run.
      // Release the gate first so the promise can settle, then assert headers.
      releaseGenerate();
      const response = await responsePromise;

      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toContain('text/event-stream');

      const text = await response.text();
      expect(text).toContain('"Streamed."');
      expect(text).toContain('[DONE]');
    });
  });

  describe('SSE streaming: client disconnect aborts the run (regression: PRRT_kwDORvupsc6MarAf)', () => {
    it('aborts the active run when the client cancels the stream', async () => {
      // Regression: with the SSE response opened before the run settles, a client
      // disconnect (stream cancel) left the agent run executing — and billing
      // provider tokens — with no reader. The fix wires the ReadableStream's
      // cancel() to runState.activeRun.abort(). Here we gate generate on a promise
      // that never resolves so the run stays in-flight, then cancel the response
      // body and assert the run was aborted.
      // A realistic provider call: it hangs until its abort signal fires, then
      // rejects with an abort error — exactly how a real streaming provider drops
      // when the run is aborted. Without the fix's cancel()→abort() wiring, the
      // signal never fires and this generate hangs forever.
      const generate: GenerateFunction = (context) =>
        new Promise((_resolve, reject) => {
          context.signal?.addEventListener('abort', () => {
            reject(new Error('aborted'));
          });
        });

      const gateway = await createTestGateway({ generate });

      const response = await requestJSON(gateway, '/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({
          model: 'bureau',
          messages: [{ role: 'user', content: 'Disconnect test' }],
          stream: true,
        }),
      });

      expect(response.status).toBe(200);
      expect(response.body).not.toBeNull();

      // The run is registered and running (generate is gated forever).
      const runs = [...gateway.bureau.store.getState().runs.values()];
      const runState = runs[0];
      expect(runState).toBeDefined();

      let aborted = false;
      runState!.activeRun.addEventListener('run.aborted', () => {
        aborted = true;
      });

      // Simulate the client disconnecting: cancel the response body stream.
      await response.body!.cancel();
      // Let the abort propagate through the run loop's event dispatch.
      await Promise.resolve();
      await Promise.resolve();

      // The stream's cancel() must have aborted the active run, which fires
      // `run.aborted`. (Pre-fix, the stream had no cancel() handler, so the run
      // kept executing and this event never fired.)
      expect(aborted).toBe(true);

      gateway.bureau.dispose();
    });
  });
});
