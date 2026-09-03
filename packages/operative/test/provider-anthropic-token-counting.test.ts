/**
 * Anthropic server-side token counting (AB-167).
 *
 * Spec: `@anthropic-ai/sdk`'s
 * `Messages.countTokens(params: MessageCountTokensParams, options?):
 * APIPromise<MessageTokensCount>` — `{ model, messages, system?, tools?, ... }`
 * in, `{ input_tokens }` out. Stable since SDK 0.31.0 on `client.messages`,
 * not behind `client.beta`; read from the installed declarations, not from
 * documentation.
 *
 * This is the Anthropic sibling AB-159 deliberately left out of scope when it
 * shipped `createGeminiTokenCounter`. Closing it makes
 * `getProviderCapabilities('anthropic').serverSideTokenCounting: true` a
 * truthful claim — it was the only capability the catalog advertised that this
 * package did not back.
 *
 * The SDK declares `input_tokens` **required**, but this package's structural
 * client type declares it optional: `baseURL` accepts any origin including a
 * proxy, so the declared response type is not a runtime guarantee.
 * `createAnthropicTokenCounter` maps that shape onto AB-64's provider-neutral
 * `TokenCountResult` at its own boundary — `totalTokens` is normalized to `0`
 * once there (never pushed onto the caller as a `?? 0`), while `cachedTokens`
 * is never set at all: Anthropic's `messages.countTokens` reports no cache
 * attribution, unlike the Gemini counter's `cachedTokens`.
 *
 * Two kinds of test live here, following `provider-gemini-token-counting.test.ts`.
 *
 * The bulk are hermetic and inject a fake client typed as the structural
 * `AnthropicTokenCountingClient` from `providers/types.ts` — that typing is the
 * point, because a fake that compiles against the same interface a real SDK
 * client satisfies is what makes the interface useful rather than decorative.
 * (`Anthropic` satisfying it is proved separately, at compile time, by
 * `src/providers/anthropic-token-counting-assignability.test-d.ts`.)
 *
 * The rest exercise the "no client injected" branch: the real SDK, dynamically
 * imported and constructed, issuing a real request against a local
 * `Bun.serve`, matching `provider-proxy-contract.test.ts` and
 * `provider-batches.test.ts` rather than `mock.module()`, which mutates the
 * process-global module registry and races other files in this suite.
 */
import { describe, expect, it } from 'bun:test';

import { createAnthropicTokenCounter } from '../src/providers/anthropic.ts';
import { ProviderError } from '../src/providers/errors.ts';
import type {
  AnthropicCountTokensRequest,
  AnthropicTokenCountingClient,
} from '../src/providers/types.ts';

/** The SDK-shaped response `AnthropicTokenCountingClient.messages.countTokens` returns. */
interface AnthropicCountTokensResponse {
  input_tokens?: number;
}

const PLACEHOLDER_TOKEN = 'placeholder-not-a-real-key-0000';

/** One call the fake client recorded. */
interface RecordedCall {
  request: AnthropicCountTokensRequest;
}

/** One request a local stand-in server received. */
interface RecordedRequest {
  method: string;
  path: string;
}

interface RecordingServer {
  baseURL: string;
  requests: RecordedRequest[];
  stop: () => void;
}

/**
 * Starts a local `Bun.serve` that records every request and answers each one
 * with `responseBody`. Bound to the literal loopback IP rather than
 * "localhost" for the reason documented in `provider-proxy-contract.test.ts`:
 * some sandboxed CI network namespaces resolve the hostname to an address the
 * server is not listening on and silently drop the connection.
 */
function createRecordingServer(responseBody: unknown): RecordingServer {
  const requests: RecordedRequest[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(request) {
      requests.push({ method: request.method, path: new URL(request.url).pathname });
      return new Response(JSON.stringify(responseBody), {
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  return {
    baseURL: `http://127.0.0.1:${server.port}`,
    requests,
    stop: () => server.stop(),
  };
}

const COUNT_RESPONSE: AnthropicCountTokensResponse = { input_tokens: 2095 };

function createFakeAnthropicClient(failure?: unknown): {
  client: AnthropicTokenCountingClient;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  return {
    calls,
    client: {
      messages: {
        async countTokens(request) {
          calls.push({ request });
          if (failure !== undefined) throw failure;
          return COUNT_RESPONSE;
        },
      },
    },
  };
}

describe('createAnthropicTokenCounter — injected client', () => {
  it('counts tokens for messages, passing the request through verbatim', async () => {
    const { client, calls } = createFakeAnthropicClient();
    const counter = createAnthropicTokenCounter({ client });
    const request: AnthropicCountTokensRequest = {
      model: 'claude-sonnet-5',
      messages: [{ role: 'user', content: 'The quick brown fox jumps over the lazy dog.' }],
    };

    const result = await counter.countTokens(request);
    expect(result).toStrictEqual({
      totalTokens: COUNT_RESPONSE.input_tokens!,
      provider: 'anthropic',
      model: request.model,
    });
    expect(result).not.toHaveProperty('cachedTokens');
    expect(calls).toEqual([{ request }]);
  });

  it('passes system and tools through when supplied, since both count toward the total', async () => {
    const { client, calls } = createFakeAnthropicClient();
    const counter = createAnthropicTokenCounter({ client });
    const request: AnthropicCountTokensRequest = {
      model: 'claude-sonnet-5',
      messages: [{ role: 'user', content: 'hello' }],
      system: 'be terse',
      tools: [{ name: 'get_weather', description: 'Look up weather', input_schema: {} }],
      tool_choice: { type: 'auto' },
    };

    await counter.countTokens(request);

    expect(calls).toEqual([{ request }]);
  });

  it('normalizes totalTokens to 0 when the response omits input_tokens', async () => {
    // The SDK declares `input_tokens` required, but `baseURL` accepts any
    // origin — a proxy can answer with a body that omits it. AB-64's
    // `TokenCountResult.totalTokens` is required, so the absent case is
    // normalized to `0` at this mapping boundary.
    const bareClient: AnthropicTokenCountingClient = {
      messages: {
        async countTokens() {
          return {};
        },
      },
    };
    const counter = createAnthropicTokenCounter({ client: bareClient });

    const result = await counter.countTokens({
      model: 'claude-sonnet-5',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(result).toStrictEqual({
      totalTokens: 0,
      provider: 'anthropic',
      model: 'claude-sonnet-5',
    });
    expect(result).not.toHaveProperty('cachedTokens');
  });

  it('preserves a zero count as zero rather than collapsing it into absent', async () => {
    const zeroClient: AnthropicTokenCountingClient = {
      messages: {
        async countTokens() {
          return { input_tokens: 0 };
        },
      },
    };
    const counter = createAnthropicTokenCounter({ client: zeroClient });

    const result = await counter.countTokens({
      model: 'claude-sonnet-5',
      messages: [{ role: 'user', content: '' }],
    });

    expect(result.totalTokens).toBe(0);
  });

  it('wraps an SDK failure in a ProviderError', async () => {
    const { client } = createFakeAnthropicClient(new Error('permission denied'));
    const counter = createAnthropicTokenCounter({ client });

    const error = await counter
      .countTokens({ model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'hi' }] })
      .then(
        () => undefined,
        (thrown: unknown) => thrown,
      );

    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).provider).toBe('anthropic');
  });

  it('passes an already-thrown ProviderError through unwrapped', async () => {
    const original = new ProviderError({
      provider: 'anthropic',
      cause: undefined,
      message: 'boom',
    });
    const { client } = createFakeAnthropicClient(original);
    const counter = createAnthropicTokenCounter({ client });

    const error = await counter
      .countTokens({ model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'hi' }] })
      .then(
        () => undefined,
        (thrown: unknown) => thrown,
      );

    expect(error).toBe(original);
  });
});

describe('createAnthropicTokenCounter — SDK construction', () => {
  it('constructs a real @anthropic-ai/sdk client from apiKey and baseURL, lazily', async () => {
    const server = createRecordingServer(COUNT_RESPONSE);
    try {
      const counter = createAnthropicTokenCounter({
        apiKey: PLACEHOLDER_TOKEN,
        baseURL: server.baseURL,
      });

      expect(server.requests).toEqual([]);

      const result = await counter.countTokens({
        model: 'claude-sonnet-5',
        messages: [{ role: 'user', content: 'hi' }],
      });

      expect(result).toStrictEqual({
        totalTokens: COUNT_RESPONSE.input_tokens!,
        provider: 'anthropic',
        model: 'claude-sonnet-5',
      });
      expect(server.requests).toHaveLength(1);
      expect(server.requests[0]?.method).toBe('POST');
      expect(server.requests[0]?.path).toContain('count_tokens');

      // A second call reuses the memoized client rather than reconstructing it.
      await counter.countTokens({
        model: 'claude-sonnet-5',
        messages: [{ role: 'user', content: 'again' }],
      });
      expect(server.requests).toHaveLength(2);
    } finally {
      server.stop();
    }
  });

  it('wraps a construction failure in a ProviderError when no key is available', async () => {
    // Unlike the Gemini counter, this factory has no eager key resolver: the
    // SDK constructor itself rejects a missing key, from inside the same try
    // that guards the request. Either way the caller sees a ProviderError.
    const previousKey = process.env['ANTHROPIC_API_KEY'];
    delete process.env['ANTHROPIC_API_KEY'];
    try {
      const counter = createAnthropicTokenCounter();
      const error = await counter
        .countTokens({ model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'hi' }] })
        .then(
          () => undefined,
          (thrown: unknown) => thrown,
        );

      expect(error).toBeInstanceOf(ProviderError);
      expect((error as ProviderError).provider).toBe('anthropic');
    } finally {
      if (previousKey !== undefined) process.env['ANTHROPIC_API_KEY'] = previousKey;
    }
  });
});
