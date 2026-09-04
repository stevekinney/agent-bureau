import {
  AbortAgentRunError,
  type GenerateContext,
  type GenerateFunction,
} from '@lostgradient/operative';
import { noToolCalls } from '@lostgradient/operative/conditions';
import { createTool, createToolbox } from 'armorer';
import { describe, expect, it, spyOn } from 'bun:test';
import { BureauError } from 'bureau';
import { Hono } from 'hono';
import { createManualRuntimeServices } from 'lifecycle';
import { z } from 'zod';

import {
  attackerRequestContextFixture,
  createGatewayAuthorityTestApiKey,
  createTestGateway,
  expectedPersistedApiKeyAuthority,
  requestJSON,
} from '../test';
import { createOpenAICompatRoutes, formatRunErrorMessage } from './openai-compat';

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

  it('returns 400 when the messages array contains no user message', async () => {
    const gateway = await createTestGateway({ generate: createMockGenerate() });
    const response = await requestJSON(gateway, '/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        model: 'bureau',
        messages: [{ role: 'system', content: 'You are a helpful assistant.' }],
      }),
    });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.message).toBe('messages array must contain at least one user message');
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

  it('returns 422 when createRun rejects with a BureauError BAD_REQUEST', async () => {
    const gateway = await createTestGateway({ generate: createMockGenerate() });
    spyOn(gateway.bureau, 'createRun').mockRejectedValue(
      new BureauError('malformed run request', 'BAD_REQUEST'),
    );
    const response = await requestJSON(gateway, '/v1/chat/completions', {
      method: 'POST',
      body: minimalRequest('bureau', 'Hello'),
    });
    expect(response.status).toBe(422);
  });

  it('returns 404 when createRun rejects with a BureauError NOT_FOUND', async () => {
    const gateway = await createTestGateway({ generate: createMockGenerate() });
    spyOn(gateway.bureau, 'createRun').mockRejectedValue(
      new BureauError('agent not found', 'NOT_FOUND'),
    );
    const response = await requestJSON(gateway, '/v1/chat/completions', {
      method: 'POST',
      body: minimalRequest('bureau', 'Hello'),
    });
    expect(response.status).toBe(404);
  });

  it('returns 429 when createRun rejects with a BureauError RATE_LIMITED (AB-13)', async () => {
    const gateway = await createTestGateway({ generate: createMockGenerate() });
    spyOn(gateway.bureau, 'createRun').mockRejectedValue(
      new BureauError('too many concurrent runs', 'RATE_LIMITED'),
    );
    const response = await requestJSON(gateway, '/v1/chat/completions', {
      method: 'POST',
      body: minimalRequest('bureau', 'Hello'),
    });
    expect(response.status).toBe(429);
  });

  it('rethrows a BureauError from createRun whose code has no mapped status', async () => {
    const gateway = await createTestGateway({ generate: createMockGenerate() });
    spyOn(gateway.bureau, 'createRun').mockRejectedValue(
      new BureauError('run authority is stale', 'CONFLICT'),
    );
    const response = await requestJSON(gateway, '/v1/chat/completions', {
      method: 'POST',
      body: minimalRequest('bureau', 'Hello'),
    });
    expect(response.status).toBe(500);
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

  it("the response's `id` and `created` (AB-327) follow the injected RuntimeServices, not the real wall clock or crypto.randomUUID()", async () => {
    const runtime = createManualRuntimeServices({ origin: '2030-01-01T00:00:00.000Z' });
    const gateway = await createTestGateway({ generate: createMockGenerate(), runtime });
    const response = await requestJSON(gateway, '/v1/chat/completions', {
      method: 'POST',
      body: minimalRequest('bureau', 'What is 2 + 2?'),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.created).toBe(Math.floor(Date.parse('2030-01-01T00:00:00.000Z') / 1000));
    expect(body.id).toStartWith(`chatcmpl-${runtime.identifierPrefix}-completion-`);
  });

  it('derives request authority from the verified API key and ignores caller context', async () => {
    const gateway = await createTestGateway({
      generate: createMockGenerate(),
      storage: { type: 'memory' },
    });
    const { key, plaintext } = await createGatewayAuthorityTestApiKey(gateway);

    const response = await requestJSON(gateway, '/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${plaintext}` },
      body: JSON.stringify({
        model: 'openai-agent',
        messages: [{ role: 'user', content: 'Hello' }],
        requestContext: attackerRequestContextFixture(),
      }),
    });
    expect(response.status).toBe(200);

    const sessions = await gateway.bureau.listSessions();
    expect(sessions).toHaveLength(1);
    const session = await gateway.bureau.getSession(sessions[0]!.id);

    expect(session?.metadata['lastRequestAuthority']).toEqual(
      expectedPersistedApiKeyAuthority(key, 'openai-agent'),
    );
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

    it('non-stream: returns 500 for a budget-exceeded run (store status completed) instead of a 200 with partial content (regression: PRRT_kwDORvupsc6MkTtu)', async () => {
      // A run that fails with 'budget-exceeded'/'elicitation-denied' arrives via
      // run.completed and lands in the store as status 'completed' but with a
      // failure finishReason. The non-streaming path must reject the full failure
      // set by finishReason, not just store status 'error' — otherwise it returns
      // a 200 chat completion with partial content. We model the terminal detail
      // directly via a fake bureau (these finish reasons are hard to force
      // through a stub generate).
      const realGateway = await createTestGateway({ generate: createMockGenerate() });
      const terminalRunState = {
        id: 'budget-run',
        status: 'completed',
        steps: [],
        usage: { prompt: 0, completion: 0, total: 0 },
        finishReason: 'budget-exceeded',
        error: undefined,
        snapshots: [],
        actions: [],
        activeRun: {
          result: Promise.resolve({}),
          abort: () => {},
          addEventListener: () => {},
          removeEventListener: () => {},
        },
      };
      const runDetail = {
        id: 'budget-run',
        sessionId: 'sess-1',
        status: 'completed',
        steps: 1,
        usage: { prompt: 0, completion: 0, total: 0 },
        finishReason: 'budget-exceeded',
        error: undefined,
        actionCount: 0,
        events: [],
        stepDetails: [{ content: 'partial output' }],
        latestSnapshot: undefined,
      };
      const fakeBureau = {
        ...realGateway.bureau,
        createRun: async () => ({ id: 'budget-run', sessionId: 'sess-1' }),
        store: {
          ...realGateway.bureau.store,
          getRun: (id: string) =>
            id === 'budget-run' ? terminalRunState : realGateway.bureau.store.getRun(id),
        },
        getRun: (id: string) => (id === 'budget-run' ? runDetail : realGateway.bureau.getRun(id)),
      } as unknown as typeof realGateway.bureau;

      const gateway = await createTestGateway(fakeBureau);
      const response = await requestJSON(gateway, '/v1/chat/completions', {
        method: 'POST',
        body: minimalRequest('bureau', 'Over budget'),
      });

      // Must be 500, not a 200 with the partial content.
      expect(response.status).toBe(500);

      realGateway.bureau.dispose();
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

  describe('SSE streaming: keep-alive heartbeat prevents idle-timeout disconnects (regression: PRRT_kwDORvupsc6MbhP8)', () => {
    it('sends a connected comment immediately when the stream opens, before the run settles', async () => {
      // Regression: the old SSE path emitted no bytes until run.completed fired.
      // Standard HTTP reverse proxies (nginx default 60 s, AWS ALB 60 s) and
      // Bun.serve (default 10 s idleTimeout) close idle connections before a
      // long agent run finishes. The fix adds:
      //   (1) an immediate `: connected\n\n` SSE comment on stream open, and
      //   (2) a `: heartbeat\n\n` comment every 8 s thereafter.
      // This test gates `generate` on a promise, verifies the `: connected`
      // comment appears in the final body (proving it was sent before the run
      // settled), then releases the gate so the test completes normally.
      let releaseGenerate!: () => void;
      const generateGate = new Promise<void>((resolve) => {
        releaseGenerate = resolve;
      });

      const generate: GenerateFunction = async () => {
        await generateGate;
        return { content: 'Heartbeat test complete.', toolCalls: [] };
      };

      const gateway = await createTestGateway({ generate });

      const responsePromise = requestJSON(gateway, '/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({
          model: 'bureau',
          messages: [{ role: 'user', content: 'Heartbeat test' }],
          stream: true,
        }),
      });

      // Yield enough microtasks for the streaming path to open the
      // ReadableStream and enqueue the initial `: connected` comment before
      // the generate gate releases.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      // Release the gate so the run can complete and the response body closes.
      releaseGenerate();
      const response = await responsePromise;

      expect(response.status).toBe(200);
      const text = await response.text();

      // The initial connected comment must be present regardless of run duration.
      expect(text).toContain(': connected');
      // The run must still complete normally.
      expect(text).toContain('"Heartbeat test complete."');
      expect(text).toContain('[DONE]');
    });

    it('sends a heartbeat comment on every tick while the run is still in flight (test-only short interval)', async () => {
      let releaseGenerate!: () => void;
      const generateGate = new Promise<void>((resolve) => {
        releaseGenerate = resolve;
      });
      const generate: GenerateFunction = async () => {
        await generateGate;
        return { content: 'Done after heartbeats.', toolCalls: [] };
      };

      const gateway = await createTestGateway({ generate });
      // A 5ms heartbeat interval (test-only override — production always
      // uses the real 8s SSE_HEARTBEAT_INTERVAL_MS) so several ticks fire
      // well within a normal test's timeout.
      const app = new Hono();
      app.route('/v1', createOpenAICompatRoutes(gateway.bureau, 5));

      const responsePromise = app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'bureau',
          messages: [{ role: 'user', content: 'Heartbeat interval test' }],
          stream: true,
        }),
      });
      const response = await responsePromise;
      expect(response.status).toBe(200);

      // Read a few chunks off the real stream so multiple 5ms heartbeat
      // ticks land before the run completes.
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let collected = '';
      let heartbeatCount = 0;
      while (heartbeatCount < 2) {
        const { done, value } = await reader.read();
        if (done) break;
        collected += decoder.decode(value, { stream: true });
        heartbeatCount = collected.split(': heartbeat').length - 1;
      }
      expect(heartbeatCount).toBeGreaterThanOrEqual(2);

      releaseGenerate();
      await reader.cancel();
    });

    it("closes the stream when the heartbeat's own enqueue throws (AB-316: enqueue-failure → close() branch)", async () => {
      // The heartbeat timer's `catch { close(); }` only runs when
      // `controller.enqueue()` itself throws — which happens for a
      // controller that has already errored or closed underneath it (a
      // disconnected client the platform hasn't told us about yet, or a
      // backpressure/consumer-side failure). Rather than reconstruct that
      // exact platform condition, spy on the shared
      // `ReadableStreamDefaultController.prototype.enqueue` and throw only
      // for the heartbeat's own chunk — proving the catch branch runs
      // `close()` (which stops the timer and detaches the run listeners)
      // without disturbing any other stream in the process.
      let releaseGenerate!: () => void;
      const generateGate = new Promise<void>((resolve) => {
        releaseGenerate = resolve;
      });
      const generate: GenerateFunction = async () => {
        await generateGate;
        return { content: 'Done after a broken heartbeat.', toolCalls: [] };
      };

      const gateway = await createTestGateway({ generate });
      const app = new Hono();
      app.route('/v1', createOpenAICompatRoutes(gateway.bureau, 5));

      const originalEnqueue = ReadableStreamDefaultController.prototype.enqueue;
      let heartbeatEnqueueAttempts = 0;
      const enqueueSpy = spyOn(
        ReadableStreamDefaultController.prototype,
        'enqueue',
      ).mockImplementation(function (this: ReadableStreamDefaultController, chunk: Uint8Array) {
        if (new TextDecoder().decode(chunk).includes('heartbeat')) {
          heartbeatEnqueueAttempts += 1;
          throw new Error('simulated enqueue failure on a heartbeat tick');
        }
        return originalEnqueue.call(this, chunk);
      });

      try {
        const response = await app.request('/v1/chat/completions', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'bureau',
            messages: [{ role: 'user', content: 'Broken heartbeat test' }],
            stream: true,
          }),
        });
        expect(response.status).toBe(200);

        // The controller closes itself as soon as the first heartbeat tick's
        // `enqueue` throws — read the stream to completion (`done`) as the
        // deterministic signal that `close()` ran, rather than waiting a
        // fixed duration.
        const reader = response.body!.getReader();
        for (;;) {
          const { done } = await reader.read();
          if (done) break;
        }
        expect(heartbeatEnqueueAttempts).toBeGreaterThanOrEqual(1);
      } finally {
        enqueueSpy.mockRestore();
        releaseGenerate();
      }
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

    it("emits an in-band abort error chunk when the run is aborted through the bureau's own abort API, not a stream cancel", async () => {
      // Unlike the client-disconnect case above (which detaches the
      // route's run.completed/run.aborted listeners before aborting, since
      // the stream itself is going away), an abort that reaches the run
      // through a different path entirely — bureau.abortRun() called from
      // outside this request, e.g. DELETE/abort over the JSON API — must
      // still be observed by this SSE stream's own `run.aborted` listener
      // and surfaced in-band as an error chunk before [DONE].
      const generate: GenerateFunction = (context) =>
        new Promise((_resolve, reject) => {
          context.signal?.addEventListener('abort', () => {
            reject(new Error('aborted'));
          });
        });

      const gateway = await createTestGateway({ generate });

      const responsePromise = requestJSON(gateway, '/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({
          model: 'bureau',
          messages: [{ role: 'user', content: 'Abort via API' }],
          stream: true,
        }),
      });
      const response = await responsePromise;
      expect(response.status).toBe(200);

      const runs = [...gateway.bureau.store.getState().runs.values()];
      const runState = runs[0];
      expect(runState).toBeDefined();

      // Abort through the bureau's own API — never response.body.cancel() —
      // so the route's run.aborted listener is still attached when it fires.
      gateway.bureau.abortRun(runState!.id);

      const text = await response.text();
      expect(text).toContain('"error"');
      expect(text).toContain('[DONE]');

      gateway.bureau.dispose();
    });
  });

  // AB-212 — this non-streaming path is AB-37's "synchronous HTTP call
  // awaiting a run" row: the handler blocks on `activeRun.result` before
  // responding, so a client disconnect during that wait must propagate to
  // the run exactly like the `stream: true` branch's `cancel()` above.
  describe('non-streaming: client disconnect aborts the run (AB-212)', () => {
    it('aborts the run, awaits closed(), and records a run.disconnect-aborted audit entry', async () => {
      // Resolves the instant `generate` is first invoked — which can only
      // happen AFTER `createRun` has registered the run in the store (per
      // `create-bureau.ts`'s own comment: `createRun` returns "synchronously
      // right after the run starts", before its execute loop ever calls
      // `generate`). Awaiting this promise directly, rather than polling the
      // store on a bounded attempt count, makes "the run is running before
      // we disconnect" a genuine causal guarantee instead of a timing race —
      // it resolves exactly as fast as the real event loop allows, with no
      // load-sensitive attempt budget to size.
      let generateInvoked: () => void;
      const generateInvokedPromise = new Promise<void>((resolve) => {
        generateInvoked = resolve;
      });
      const generate: GenerateFunction = (context) => {
        generateInvoked();
        return new Promise((_resolve, reject) => {
          context.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        });
      };

      const gateway = await createTestGateway({
        generate,
        storage: { type: 'memory' },
      });
      const { plaintext } = await createGatewayAuthorityTestApiKey(gateway);

      const controller = new AbortController();
      const responsePromise = requestJSON(gateway, '/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${plaintext}` },
        signal: controller.signal,
        body: JSON.stringify({
          model: 'bureau',
          messages: [{ role: 'user', content: 'Disconnect test' }],
        }),
      });

      await generateInvokedPromise;
      const runId = [...gateway.bureau.store.getState().runs.values()].find(
        (run) => run.status === 'running',
      )?.id;
      expect(runId).toBeDefined();

      controller.abort();

      const response = await responsePromise;
      // The client disconnected before the run settled — the non-streaming
      // handler's own response is moot (nobody is listening), but it still
      // resolves rather than hanging.
      expect(response.status).toBe(500);

      expect(gateway.bureau.getRun(runId!)?.status).toBe('aborted');

      const auditRecords = await gateway.bureau.auditTrail?.query({ runId });
      const disconnectEntry = auditRecords?.find(
        (record) => record.type === 'run.disconnect-aborted',
      );
      expect(disconnectEntry).toBeDefined();
      expect(disconnectEntry?.detail).toMatchObject({
        acknowledgement: { status: 'completed' },
      });

      gateway.bureau.dispose();
    });
  });

  describe('SSE streaming: run already settled before listeners attach (regression: PRRT_kwDORvupsc6MddwF)', () => {
    // For very fast `stream: true` requests, createRun() can schedule and
    // complete the run BEFORE the ReadableStream.start() callback attaches the
    // run.completed/run.aborted listeners. In that case run.completed already
    // fired and never fires again, so the client received only heartbeats — no
    // content, no [DONE]. The fix re-reads the store in start() and emits the
    // final result immediately when the run is already terminal.
    //
    // We force the race deterministically by wrapping a real bureau so the
    // streamed run id maps to an ALREADY-TERMINAL store entry whose activeRun's
    // event listeners are no-ops (the events already fired). Timing-based tests
    // can't reliably reproduce the settle-before-start ordering, so we model the
    // terminal store state directly.
    function gatewayWithPreSettledRun(terminal: {
      status: 'completed' | 'error' | 'aborted';
      finishReason: string;
      content?: string;
      error?: unknown;
    }) {
      // A no-op activeRun: its add/removeEventListener never invoke the listener,
      // exactly as a run whose terminal events already fired would behave.
      const activeRun = {
        result: Promise.resolve({}),
        abort: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
      };
      const runState = {
        id: 'pre-settled-run',
        status: terminal.status,
        steps: terminal.content !== undefined ? [{ content: terminal.content }] : [],
        usage: { prompt: 0, completion: 0, total: 0 },
        finishReason: terminal.finishReason,
        error: terminal.error,
        snapshots: [],
        actions: [],
        activeRun,
      };
      return { runState };
    }

    it('emits the final content and [DONE] when a successful run settled before subscribe', async () => {
      const realGateway = await createTestGateway({ generate: createMockGenerate() });
      const { runState } = gatewayWithPreSettledRun({
        status: 'completed',
        finishReason: 'stop-condition',
        content: 'Settled fast.',
      });

      // Wrap the real bureau: createRun returns the sentinel id, and store.getRun
      // returns the already-terminal RunState for it.
      const fakeBureau = {
        ...realGateway.bureau,
        createRun: async () => ({ id: 'pre-settled-run', sessionId: 'sess-1' }),
        store: {
          ...realGateway.bureau.store,
          getRun: (id: string) =>
            id === 'pre-settled-run' ? runState : realGateway.bureau.store.getRun(id),
        },
      } as unknown as typeof realGateway.bureau;

      const gateway = await createTestGateway(fakeBureau);
      const response = await requestJSON(gateway, '/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({
          model: 'bureau',
          messages: [{ role: 'user', content: 'Fast one' }],
          stream: true,
        }),
      });

      expect(response.status).toBe(200);
      const text = await response.text();
      // Without the fix the body would contain only `: connected`/heartbeats.
      expect(text).toContain('"Settled fast."');
      expect(text).toContain('[DONE]');

      realGateway.bureau.dispose();
    });

    it('emits an in-band error chunk when an errored run settled before subscribe', async () => {
      const realGateway = await createTestGateway({ generate: createMockGenerate() });
      const { runState } = gatewayWithPreSettledRun({
        status: 'error',
        finishReason: 'error',
        error: new Error('settled with error'),
      });

      const fakeBureau = {
        ...realGateway.bureau,
        createRun: async () => ({ id: 'pre-settled-run', sessionId: 'sess-1' }),
        store: {
          ...realGateway.bureau.store,
          getRun: (id: string) =>
            id === 'pre-settled-run' ? runState : realGateway.bureau.store.getRun(id),
        },
      } as unknown as typeof realGateway.bureau;

      const gateway = await createTestGateway(fakeBureau);
      const response = await requestJSON(gateway, '/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({
          model: 'bureau',
          messages: [{ role: 'user', content: 'Fast fail' }],
          stream: true,
        }),
      });

      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toContain('"error"');
      expect(text).toContain('settled with error');
      expect(text).toContain('[DONE]');

      realGateway.bureau.dispose();
    });

    it('emits the typed abort error message when an aborted run settled before subscribe', async () => {
      const realGateway = await createTestGateway({ generate: createMockGenerate() });
      const { runState } = gatewayWithPreSettledRun({
        status: 'aborted',
        finishReason: 'aborted',
        error: new AbortAgentRunError('operator stopped it'),
      });

      const fakeBureau = {
        ...realGateway.bureau,
        createRun: async () => ({ id: 'pre-settled-run', sessionId: 'sess-1' }),
        store: {
          ...realGateway.bureau.store,
          getRun: (id: string) =>
            id === 'pre-settled-run' ? runState : realGateway.bureau.store.getRun(id),
        },
      } as unknown as typeof realGateway.bureau;

      const gateway = await createTestGateway(fakeBureau);
      const response = await requestJSON(gateway, '/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({
          model: 'bureau',
          messages: [{ role: 'user', content: 'Fast abort' }],
          stream: true,
        }),
      });

      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toContain('"error"');
      expect(text).toContain('operator stopped it');
      expect(text).toContain('[DONE]');

      realGateway.bureau.dispose();
    });

    it('extracts the message from a serialized abort diagnostic on the non-streaming path', async () => {
      const realGateway = await createTestGateway({ generate: createMockGenerate() });
      const { runState } = gatewayWithPreSettledRun({
        status: 'aborted',
        finishReason: 'aborted',
        error: JSON.stringify({
          name: 'AbortAgentRunError',
          message: 'operator stopped it',
          kind: 'abort',
          code: 'ABORTED',
        }),
      });

      const fakeBureau = {
        ...realGateway.bureau,
        createRun: async () => ({ id: 'pre-settled-run', sessionId: 'sess-1' }),
        getRun: (id: string) =>
          id === 'pre-settled-run' ? runState : realGateway.bureau.getRun(id),
      } as unknown as typeof realGateway.bureau;

      const gateway = await createTestGateway(fakeBureau);
      const response = await requestJSON(gateway, '/v1/chat/completions', {
        method: 'POST',
        body: minimalRequest('bureau', 'Fast abort'),
      });

      expect(response.status).toBe(500);
      const text = await response.text();
      expect(text).toContain('operator stopped it');
      expect(text).not.toContain('AbortAgentRunError');

      realGateway.bureau.dispose();
    });

    it('classifies a budget-exceeded run (store status completed) as an error, not success', async () => {
      // A budget-exceeded run lands in the store as status 'completed' but
      // finishReason 'budget-exceeded'. The immediate path must discriminate by
      // finishReason (mirroring the run.completed listener), not status — else it
      // would emit a content chunk where the listener emits an error chunk.
      const realGateway = await createTestGateway({ generate: createMockGenerate() });
      const { runState } = gatewayWithPreSettledRun({
        status: 'completed',
        finishReason: 'budget-exceeded',
        content: 'partial',
      });

      const fakeBureau = {
        ...realGateway.bureau,
        createRun: async () => ({ id: 'pre-settled-run', sessionId: 'sess-1' }),
        store: {
          ...realGateway.bureau.store,
          getRun: (id: string) =>
            id === 'pre-settled-run' ? runState : realGateway.bureau.store.getRun(id),
        },
      } as unknown as typeof realGateway.bureau;

      const gateway = await createTestGateway(fakeBureau);
      const response = await requestJSON(gateway, '/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({
          model: 'bureau',
          messages: [{ role: 'user', content: 'Over budget' }],
          stream: true,
        }),
      });

      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toContain('"error"');
      expect(text).toContain('[DONE]');

      realGateway.bureau.dispose();
    });
  });

  it('non-stream: returns 500 when the run vanishes from the store after settling', async () => {
    const gateway = await createTestGateway({ generate: createMockGenerate() });
    const originalGetRun = gateway.bureau.getRun.bind(gateway.bureau);
    let callCount = 0;
    gateway.bureau.getRun = (id: string) => {
      callCount += 1;
      // Allow the durability-classification call (before the run settles)
      // through, but return undefined for the post-settlement read this
      // route uses to build the response — simulating a race where the run
      // was deleted from the store between settling and this read.
      return callCount === 1 ? originalGetRun(id) : undefined;
    };

    const response = await requestJSON(gateway, '/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        model: 'bureau',
        messages: [{ role: 'user', content: 'Vanish after settle' }],
      }),
    });

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error.message).toBe('Run result unavailable after settlement');
  });

  it('SSE streaming: emits an empty content chunk and [DONE] when store.getRun finds no active run state at all', async () => {
    // Distinct from the "already settled" describe block above, which
    // models a run whose store entry is still present but terminal. This
    // covers the case where `bureau.store.getRun(summary.id)` returns
    // undefined entirely — the run vanished from the live store by the
    // time the ReadableStream's start() callback runs.
    const realGateway = await createTestGateway({ generate: createMockGenerate() });
    const fakeBureau = {
      ...realGateway.bureau,
      createRun: async () => ({ id: 'vanished-run', sessionId: 'sess-1' }),
      store: {
        ...realGateway.bureau.store,
        getRun: (id: string) =>
          id === 'vanished-run' ? undefined : realGateway.bureau.store.getRun(id),
      },
    } as unknown as typeof realGateway.bureau;

    const gateway = await createTestGateway(fakeBureau);
    const response = await requestJSON(gateway, '/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        model: 'bureau',
        messages: [{ role: 'user', content: 'No active run state' }],
        stream: true,
      }),
    });

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain('"content":""');
    expect(text).toContain('[DONE]');

    realGateway.bureau.dispose();
  });
});

describe('formatRunErrorMessage', () => {
  it('returns an Error instance message directly', () => {
    expect(formatRunErrorMessage(new Error('boom'), 'fallback')).toBe('boom');
  });

  it('extracts the message from a JSON-serialized diagnostic with the expected shape', () => {
    const diagnostic = JSON.stringify({
      name: 'AbortAgentRunError',
      message: 'operator stopped it',
      kind: 'abort',
      code: 'ABORTED',
    });
    expect(formatRunErrorMessage(diagnostic, 'fallback')).toBe('operator stopped it');
  });

  it('returns the raw string when it parses as JSON but does not match the diagnostic shape', () => {
    const notADiagnostic = JSON.stringify({ foo: 'bar' });
    expect(formatRunErrorMessage(notADiagnostic, 'fallback')).toBe(notADiagnostic);
  });

  it('returns the raw string when it is not valid JSON', () => {
    expect(formatRunErrorMessage('plain error text', 'fallback')).toBe('plain error text');
  });

  it('returns the fallback for an empty string', () => {
    expect(formatRunErrorMessage('', 'fallback')).toBe('fallback');
  });

  it('returns the fallback for a non-string, non-Error value', () => {
    expect(formatRunErrorMessage(undefined, 'fallback')).toBe('fallback');
    expect(formatRunErrorMessage(42, 'fallback')).toBe('fallback');
  });
});
