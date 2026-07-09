/**
 * Providers behind a credential-injecting proxy (AB-93).
 *
 * These tests run the REAL provider SDKs (no injected mock client) against a
 * local `Bun.serve` mock standing in for a credential-injecting proxy. That's
 * required for both halves of the contract:
 *
 * 1. The placeholder token must actually reach the wire (an injected mock
 *    client never forms an HTTP request or an auth header, so it can't prove
 *    this).
 * 2. The exact `(method, path)` endpoint set a provider issues is only
 *    observable on the wire — it's the allowlist an embedder's proxy needs.
 *
 * The endpoint sets asserted here are documented in `README.md` under
 * "Providers Behind a Proxy". To neuter-verify the contract test: add a
 * stray call (e.g. `client.messages.countTokens(...)` for Anthropic) inside
 * the provider's generate function on a scratch branch, rebuild, rerun this
 * file, and confirm the affected `it('issues only ...')` test fails on the
 * exact-set assertion; then restore.
 */
import { createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';

import {
  createAnthropicProvider,
  createAnthropicProviderStream,
} from '../src/providers/anthropic.ts';
import { createGeminiProvider } from '../src/providers/gemini.ts';
import { createOpenAIProvider } from '../src/providers/openai.ts';
import type { GenerateContext, StreamingHandle } from '../src/types.ts';

const PLACEHOLDER_TOKEN = 'placeholder-not-a-real-key-0000';

interface RecordedRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  query: string;
}

interface RecordingProxy {
  baseURL: string;
  requests: RecordedRequest[];
  stop: () => void;
}

/**
 * Starts a local `Bun.serve` standing in for a credential-injecting proxy.
 * Records every request it receives and replies with `responseBody` for
 * every call, regardless of path — good enough for a multi-step loop where
 * every step's generate call gets the same shape of reply.
 */
function createRecordingProxy(responseBody: unknown): RecordingProxy {
  const requests: RecordedRequest[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      requests.push({
        method: request.method,
        path: url.pathname,
        query: url.search,
        headers: Object.fromEntries(request.headers.entries()),
      });
      return new Response(JSON.stringify(responseBody), {
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  return {
    baseURL: `http://localhost:${server.port}`,
    requests,
    stop: () => server.stop(),
  };
}

function twoStepConversation(): Conversation {
  const conversation = new Conversation();
  conversation.appendUserMessage('What is the weather in Paris?');
  return conversation;
}

function makeContext(conversation: Conversation): GenerateContext {
  return { conversation, step: 0, toolbox: createToolbox([]) };
}

function makeStreamingHandle(): StreamingHandle {
  return { update: () => {} };
}

/** Runs `generate` twice over a growing conversation — the "loop" shape. */
async function runTwoStepLoop(
  generate: (context: GenerateContext) => Promise<unknown>,
): Promise<void> {
  const conversation = twoStepConversation();
  await generate(makeContext(conversation));
  conversation.appendAssistantMessage('Checking...');
  conversation.appendUserMessage('And in London?');
  await generate(makeContext(conversation));
}

async function runTwoStepStreamingLoop(
  generate: (context: GenerateContext & { streaming: StreamingHandle }) => Promise<unknown>,
): Promise<void> {
  const conversation = twoStepConversation();
  await generate({ ...makeContext(conversation), streaming: makeStreamingHandle() });
  conversation.appendAssistantMessage('Checking...');
  conversation.appendUserMessage('And in London?');
  await generate({ ...makeContext(conversation), streaming: makeStreamingHandle() });
}

describe('Anthropic provider behind a proxy', () => {
  const anthropicResponseBody = {
    id: 'msg_proxy_test',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: 'Sunny.' }],
    model: 'claude-3-5-sonnet-20241022',
    stop_reason: 'end_turn',
    usage: { input_tokens: 5, output_tokens: 3 },
  };

  it('sends the placeholder token, not a real key', async () => {
    const proxy = createRecordingProxy(anthropicResponseBody);
    try {
      const generate = createAnthropicProvider({
        model: 'claude-3-5-sonnet-20241022',
        apiKey: PLACEHOLDER_TOKEN,
        baseURL: proxy.baseURL,
      });
      await generate(makeContext(twoStepConversation()));

      expect(proxy.requests).toHaveLength(1);
      expect(proxy.requests[0]?.headers['x-api-key']).toBe(PLACEHOLDER_TOKEN);
      expect(proxy.requests[0]?.headers['authorization']).toBeUndefined();
    } finally {
      proxy.stop();
    }
  });

  it('issues only POST /v1/messages across a multi-step run', async () => {
    const proxy = createRecordingProxy(anthropicResponseBody);
    try {
      const generate = createAnthropicProvider({
        model: 'claude-3-5-sonnet-20241022',
        apiKey: PLACEHOLDER_TOKEN,
        baseURL: proxy.baseURL,
      });
      await runTwoStepLoop(generate);

      const endpoints = new Set(
        proxy.requests.map((request) => `${request.method} ${request.path}`),
      );
      expect(endpoints).toEqual(new Set(['POST /v1/messages']));
      expect(proxy.requests).toHaveLength(2);
    } finally {
      proxy.stop();
    }
  });

  it('the streaming variant issues only POST /v1/messages as well', async () => {
    // The SSE stream body below is minimal but well-formed so the SDK's
    // streaming parser completes cleanly instead of throwing mid-stream —
    // what's under test here is the endpoint/method the streaming client
    // targets, which the non-streaming test above already asserted, so this
    // just confirms the streaming factory doesn't add extra requests.
    const sseBody = [
      'event: message_start',
      `data: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 0 } } })}`,
      '',
      'event: content_block_start',
      `data: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}`,
      '',
      'event: content_block_delta',
      `data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Sunny.' } })}`,
      '',
      'event: content_block_stop',
      `data: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}`,
      '',
      'event: message_delta',
      `data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } })}`,
      '',
      'event: message_stop',
      `data: ${JSON.stringify({ type: 'message_stop' })}`,
      '',
    ].join('\n');

    const requests: RecordedRequest[] = [];
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        requests.push({
          method: request.method,
          path: url.pathname,
          query: url.search,
          headers: Object.fromEntries(request.headers.entries()),
        });
        return new Response(sseBody, {
          headers: { 'content-type': 'text/event-stream' },
        });
      },
    });

    try {
      const generate = createAnthropicProviderStream({
        model: 'claude-3-5-sonnet-20241022',
        apiKey: PLACEHOLDER_TOKEN,
        baseURL: `http://localhost:${server.port}`,
      });
      await runTwoStepStreamingLoop(generate);

      const endpoints = new Set(requests.map((request) => `${request.method} ${request.path}`));
      expect(endpoints).toEqual(new Set(['POST /v1/messages']));
      expect(requests).toHaveLength(2);
    } finally {
      server.stop();
    }
  });
});

describe('OpenAI provider behind a proxy', () => {
  const openAIResponseBody = {
    id: 'chatcmpl_proxy_test',
    object: 'chat.completion',
    created: 0,
    model: 'gpt-4o-mini',
    choices: [
      { index: 0, message: { role: 'assistant', content: 'Sunny.' }, finish_reason: 'stop' },
    ],
    usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
  };

  it('sends the placeholder token, not a real key', async () => {
    const proxy = createRecordingProxy(openAIResponseBody);
    try {
      const generate = createOpenAIProvider({
        model: 'gpt-4o-mini',
        apiKey: PLACEHOLDER_TOKEN,
        baseURL: proxy.baseURL,
      });
      await generate(makeContext(twoStepConversation()));

      expect(proxy.requests).toHaveLength(1);
      expect(proxy.requests[0]?.headers['authorization']).toBe(`Bearer ${PLACEHOLDER_TOKEN}`);
    } finally {
      proxy.stop();
    }
  });

  it('issues only POST /chat/completions across a multi-step run', async () => {
    const proxy = createRecordingProxy(openAIResponseBody);
    try {
      const generate = createOpenAIProvider({
        model: 'gpt-4o-mini',
        apiKey: PLACEHOLDER_TOKEN,
        baseURL: proxy.baseURL,
      });
      await runTwoStepLoop(generate);

      const endpoints = new Set(
        proxy.requests.map((request) => `${request.method} ${request.path}`),
      );
      expect(endpoints).toEqual(new Set(['POST /chat/completions']));
      expect(proxy.requests).toHaveLength(2);
    } finally {
      proxy.stop();
    }
  });
});

describe('Gemini provider behind a proxy', () => {
  const geminiResponseBody = {
    candidates: [
      {
        content: { role: 'model', parts: [{ text: 'Sunny.' }] },
        finishReason: 'STOP',
        index: 0,
      },
    ],
    usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, totalTokenCount: 8 },
  };

  it('sends the placeholder token, not a real key', async () => {
    const proxy = createRecordingProxy(geminiResponseBody);
    try {
      const generate = createGeminiProvider({
        model: 'gemini-1.5-flash',
        apiKey: PLACEHOLDER_TOKEN,
        baseURL: proxy.baseURL,
      });
      await generate(makeContext(twoStepConversation()));

      expect(proxy.requests).toHaveLength(1);
      expect(proxy.requests[0]?.headers['x-goog-api-key']).toBe(PLACEHOLDER_TOKEN);
    } finally {
      proxy.stop();
    }
  });

  it('issues only POST /v1beta/models/{model}:generateContent across a multi-step run', async () => {
    const proxy = createRecordingProxy(geminiResponseBody);
    try {
      const generate = createGeminiProvider({
        model: 'gemini-1.5-flash',
        apiKey: PLACEHOLDER_TOKEN,
        baseURL: proxy.baseURL,
      });
      await runTwoStepLoop(generate);

      const endpoints = new Set(
        proxy.requests.map((request) => `${request.method} ${request.path}`),
      );
      expect(endpoints).toEqual(new Set(['POST /v1beta/models/gemini-1.5-flash:generateContent']));
      expect(proxy.requests).toHaveLength(2);
    } finally {
      proxy.stop();
    }
  });
});
