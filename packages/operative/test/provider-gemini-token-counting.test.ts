/**
 * Gemini server-side token counting (AB-159).
 *
 * Spec: `@google/genai`'s `Models.countTokens(params: CountTokensParameters):
 * Promise<CountTokensResponse>` — `{ model, contents, config? }` in,
 * `{ totalTokens?, cachedContentTokenCount? }` out, both fields optional and
 * never fabricated when the SDK genuinely reports neither. This is Gemini-only
 * per AB-155: Anthropic's own `messages.countTokens` is a real sibling
 * capability but out of scope for this factory, and OpenAI has nothing to
 * import — no synthesized character-ratio estimate stands in for it here.
 *
 * Two kinds of test live here, following `provider-batches.test.ts`'s split.
 *
 * The bulk are hermetic and inject a fake client typed as the structural
 * `GeminiTokenCountingClient` from `providers/types.ts` — that typing is the
 * point, because a fake that compiles against the same interface a real SDK
 * client satisfies is what makes the interface useful rather than decorative.
 * (`GoogleGenAI` satisfying it is proved separately, at compile time, by
 * `src/providers/gemini-client-assignability.test-d.ts`.)
 *
 * The rest exercise the "no client injected" branch: the real SDK, dynamically
 * imported and constructed, issuing a real request against a local
 * `Bun.serve`, matching `provider-proxy-contract.test.ts` and
 * `provider-batches.test.ts` rather than `mock.module()`, which mutates the
 * process-global module registry and races other files in this suite.
 */
import { describe, expect, it } from 'bun:test';

import { ProviderError } from '../src/providers/errors.ts';
import { createGeminiTokenCounter } from '../src/providers/gemini.ts';
import type {
  GeminiCountTokensRequest,
  GeminiCountTokensResponse,
  GeminiTokenCountingClient,
} from '../src/providers/types.ts';

const PLACEHOLDER_TOKEN = 'placeholder-not-a-real-key-0000';

/** One call the fake client recorded. */
interface RecordedCall {
  request: GeminiCountTokensRequest;
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

const COUNT_RESPONSE: GeminiCountTokensResponse = {
  totalTokens: 42,
  cachedContentTokenCount: 10,
};

function createFakeGeminiClient(failure?: unknown): {
  client: GeminiTokenCountingClient;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  return {
    calls,
    client: {
      models: {
        async countTokens(request) {
          calls.push({ request });
          if (failure !== undefined) throw failure;
          return COUNT_RESPONSE;
        },
      },
    },
  };
}

describe('createGeminiTokenCounter — injected client', () => {
  it('counts tokens for contents, passing the request through verbatim', async () => {
    const { client, calls } = createFakeGeminiClient();
    const counter = createGeminiTokenCounter({ client });
    const request: GeminiCountTokensRequest = {
      model: 'gemini-2.0-flash',
      contents: 'The quick brown fox jumps over the lazy dog.',
    };

    expect(await counter.countTokens(request)).toEqual(COUNT_RESPONSE);
    expect(calls).toEqual([{ request }]);
  });

  it('passes config through when supplied, for system instructions or tools', async () => {
    const { client, calls } = createFakeGeminiClient();
    const counter = createGeminiTokenCounter({ client });
    const request: GeminiCountTokensRequest = {
      model: 'gemini-2.0-flash',
      contents: 'hello',
      config: { systemInstruction: 'be terse' },
    };

    await counter.countTokens(request);

    expect(calls).toEqual([{ request }]);
  });

  it('never fabricates totalTokens when the SDK reports neither field', async () => {
    const bareClient: GeminiTokenCountingClient = {
      models: {
        async countTokens() {
          return {};
        },
      },
    };
    const counter = createGeminiTokenCounter({ client: bareClient });

    const result = await counter.countTokens({ model: 'gemini-2.0-flash', contents: 'hi' });

    expect(result).toEqual({});
    expect(result.totalTokens).toBeUndefined();
    expect(result.cachedContentTokenCount).toBeUndefined();
  });

  it('wraps an SDK failure in a ProviderError', async () => {
    const { client } = createFakeGeminiClient(new Error('permission denied'));
    const counter = createGeminiTokenCounter({ client });

    const error = await counter.countTokens({ model: 'gemini-2.0-flash', contents: 'hi' }).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).provider).toBe('gemini');
  });

  it('passes an already-thrown ProviderError through unwrapped', async () => {
    const original = new ProviderError({ provider: 'gemini', cause: undefined, message: 'boom' });
    const { client } = createFakeGeminiClient(original);
    const counter = createGeminiTokenCounter({ client });

    const error = await counter.countTokens({ model: 'gemini-2.0-flash', contents: 'hi' }).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    expect(error).toBe(original);
  });
});

describe('createGeminiTokenCounter — SDK construction', () => {
  it('constructs a real @google/genai client from apiKey and baseURL, lazily', async () => {
    const server = createRecordingServer(COUNT_RESPONSE);
    try {
      const counter = createGeminiTokenCounter({
        apiKey: PLACEHOLDER_TOKEN,
        baseURL: server.baseURL,
      });

      expect(server.requests).toEqual([]);

      const result = await counter.countTokens({ model: 'gemini-2.0-flash', contents: 'hi' });

      // Not a strict toEqual: the real SDK response is a `CountTokensResponse`
      // class instance carrying an extra `sdkHttpResponse` field alongside the
      // two named here — only those two are this package's concern.
      expect(result.totalTokens).toBe(COUNT_RESPONSE.totalTokens);
      expect(result.cachedContentTokenCount).toBe(COUNT_RESPONSE.cachedContentTokenCount);
      expect(server.requests).toHaveLength(1);
      expect(server.requests[0]?.path).toContain('countTokens');

      // A second call reuses the memoized client rather than reconstructing it.
      await counter.countTokens({ model: 'gemini-2.0-flash', contents: 'again' });
      expect(server.requests).toHaveLength(2);
    } finally {
      server.stop();
    }
  });

  it('fails with a ProviderError when no apiKey and no GOOGLE_API_KEY are available', async () => {
    const previousKey = process.env['GOOGLE_API_KEY'];
    delete process.env['GOOGLE_API_KEY'];
    try {
      const counter = createGeminiTokenCounter();
      const error = await counter.countTokens({ model: 'gemini-2.0-flash', contents: 'hi' }).then(
        () => undefined,
        (thrown: unknown) => thrown,
      );

      expect(error).toBeInstanceOf(ProviderError);
      expect((error as ProviderError).message).toContain('Missing API key');
    } finally {
      if (previousKey !== undefined) process.env['GOOGLE_API_KEY'] = previousKey;
    }
  });
});
