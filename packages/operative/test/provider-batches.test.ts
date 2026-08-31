/**
 * Cross-provider batch inference (AB-156).
 *
 * Two kinds of test live here.
 *
 * The bulk are hermetic and inject a fake client typed as the structural
 * interface from `providers/types.ts` — that typing is the point, because a
 * fake that compiles against the same interface a real SDK client satisfies is
 * what makes the interface useful rather than decorative. (`Anthropic`,
 * `OpenAI`, and `GoogleGenAI` satisfying it is proved separately, at compile
 * time, by `src/providers/batch-client-assignability.test-d.ts`.)
 *
 * The rest exercise the "no client injected" branch: the real SDK, dynamically
 * imported and constructed, issuing a real request against a local `Bun.serve`.
 * That follows `provider-proxy-contract.test.ts` rather than `mock.module()`,
 * which mutates the process-global module registry and races other files in
 * this suite. `createOpenAIBatchClient` deliberately exposes no `baseURL`
 * option, so its local server is reached through the `openai` SDK's own
 * documented `OPENAI_BASE_URL` default instead, set and restored around the one
 * test that needs it.
 */
import { describe, expect, it } from 'bun:test';

import { createAnthropicBatchClient } from '../src/providers/batches/anthropic.ts';
import { createGeminiBatchClient } from '../src/providers/batches/gemini.ts';
import { createOpenAIBatchClient } from '../src/providers/batches/openai.ts';
import { getProviderCapabilities } from '../src/providers/capabilities.ts';
import { ProviderError } from '../src/providers/errors.ts';
import type {
  AnthropicBatchClient,
  AnthropicMessageBatch,
  AnthropicMessageBatchIndividualResponse,
  GeminiBatchClient,
  GeminiBatchJob,
  GeminiDeleteResourceJob,
  OpenAIBatch,
  OpenAIBatchClient,
} from '../src/providers/types.ts';

const PLACEHOLDER_TOKEN = 'placeholder-not-a-real-key-0000';

/** One call a fake client recorded: the method name and its argument. */
interface RecordedCall {
  method: string;
  argument: unknown;
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

/** Collects an async iterable into an array. */
async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of source) items.push(item);
  return items;
}

// ── Anthropic ───────────────────────────────────────────────────────

const ANTHROPIC_BATCH: AnthropicMessageBatch = {
  id: 'msgbatch_01',
  processing_status: 'ended',
  request_counts: { canceled: 0, errored: 0, expired: 0, processing: 0, succeeded: 2 },
  results_url: 'https://api.anthropic.com/v1/messages/batches/msgbatch_01/results',
  created_at: '2026-08-30T00:00:00Z',
  ended_at: '2026-08-30T01:00:00Z',
  expires_at: '2026-08-31T00:00:00Z',
};

const ANTHROPIC_RESULTS: AnthropicMessageBatchIndividualResponse[] = [
  { custom_id: 'first', result: { type: 'succeeded', message: { id: 'msg_01' } } },
  { custom_id: 'second', result: { type: 'errored', error: { type: 'invalid_request_error' } } },
];

function createFakeAnthropicClient(failure?: unknown): {
  client: AnthropicBatchClient;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];

  function record(method: string, argument: unknown): void {
    calls.push({ method, argument });
    if (failure !== undefined) throw failure;
  }

  return {
    calls,
    client: {
      messages: {
        batches: {
          async create(params) {
            record('create', params);
            return ANTHROPIC_BATCH;
          },
          async retrieve(messageBatchId) {
            record('retrieve', messageBatchId);
            return ANTHROPIC_BATCH;
          },
          list(query) {
            record('list', query);
            return (async function* () {
              yield ANTHROPIC_BATCH;
              yield { ...ANTHROPIC_BATCH, id: 'msgbatch_02' };
            })();
          },
          async cancel(messageBatchId) {
            record('cancel', messageBatchId);
            return { ...ANTHROPIC_BATCH, processing_status: 'canceling' };
          },
          async results(messageBatchId) {
            record('results', messageBatchId);
            return (async function* () {
              yield* ANTHROPIC_RESULTS;
            })();
          },
        },
      },
    },
  };
}

describe('createAnthropicBatchClient — injected client', () => {
  it('submits a batch and returns the created MessageBatch', async () => {
    const { client, calls } = createFakeAnthropicClient();
    const batches = createAnthropicBatchClient({ client });
    const request = {
      requests: [{ custom_id: 'first', params: { model: 'claude-opus-5', max_tokens: 16 } }],
    };

    expect(await batches.create(request)).toEqual(ANTHROPIC_BATCH);
    expect(calls).toEqual([{ method: 'create', argument: request }]);
  });

  it('retrieves one batch by id', async () => {
    const { client, calls } = createFakeAnthropicClient();
    const batches = createAnthropicBatchClient({ client });

    expect(await batches.retrieve('msgbatch_01')).toEqual(ANTHROPIC_BATCH);
    expect(calls).toEqual([{ method: 'retrieve', argument: 'msgbatch_01' }]);
  });

  it('iterates every listed batch and forwards the page query', async () => {
    const { client, calls } = createFakeAnthropicClient();
    const batches = createAnthropicBatchClient({ client });

    const listed = await collect(batches.list({ limit: 2 }));

    expect(listed.map((batch) => batch.id)).toEqual(['msgbatch_01', 'msgbatch_02']);
    expect(calls).toEqual([{ method: 'list', argument: { limit: 2 } }]);
  });

  it('cancels one batch by id', async () => {
    const { client, calls } = createFakeAnthropicClient();
    const batches = createAnthropicBatchClient({ client });

    const cancelled = await batches.cancel('msgbatch_01');

    expect(cancelled.processing_status).toBe('canceling');
    expect(calls).toEqual([{ method: 'cancel', argument: 'msgbatch_01' }]);
  });

  it('streams every result line, keeping the succeeded/errored discriminant', async () => {
    const { client, calls } = createFakeAnthropicClient();
    const batches = createAnthropicBatchClient({ client });

    const results = await collect(batches.results('msgbatch_01'));

    expect(results.map((entry) => entry.result.type)).toEqual(['succeeded', 'errored']);
    expect(calls).toEqual([{ method: 'results', argument: 'msgbatch_01' }]);
  });

  it('wraps an SDK failure from every operation in a ProviderError', async () => {
    const { client } = createFakeAnthropicClient(
      Object.assign(new Error('rate limited'), {
        status: 429,
      }),
    );
    const batches = createAnthropicBatchClient({ client });

    const failures = [
      batches.create({ requests: [] }),
      batches.retrieve('msgbatch_01'),
      collect(batches.list()),
      batches.cancel('msgbatch_01'),
      collect(batches.results('msgbatch_01')),
    ];

    for (const failure of failures) {
      const error = await failure.then(
        () => undefined,
        (thrown: unknown) => thrown,
      );
      expect(error).toBeInstanceOf(ProviderError);
      expect((error as ProviderError).provider).toBe('anthropic');
      expect((error as ProviderError).retryable).toBe(true);
    }
  });

  it('passes an existing ProviderError through rather than nesting it', async () => {
    const original = new ProviderError({ provider: 'anthropic', cause: new Error('boom') });
    const { client } = createFakeAnthropicClient(original);
    const batches = createAnthropicBatchClient({ client });

    await expect(batches.retrieve('msgbatch_01')).rejects.toBe(original);
  });
});

describe('createAnthropicBatchClient — SDK construction', () => {
  it('constructs a real @anthropic-ai/sdk client from apiKey and baseURL, lazily', async () => {
    const server = createRecordingServer(ANTHROPIC_BATCH);
    try {
      const batches = createAnthropicBatchClient({
        apiKey: PLACEHOLDER_TOKEN,
        baseURL: server.baseURL,
      });

      // Nothing has been imported or requested yet — construction is deferred
      // to the first call.
      expect(server.requests).toEqual([]);

      const batch = await batches.retrieve('msgbatch_01');

      expect(batch.id).toBe('msgbatch_01');
      expect(server.requests).toEqual([
        { method: 'GET', path: '/v1/messages/batches/msgbatch_01' },
      ]);

      // The constructed client is memoized, not rebuilt per call.
      await batches.retrieve('msgbatch_01');
      expect(server.requests).toHaveLength(2);
    } finally {
      server.stop();
    }
  });
});

// ── OpenAI ──────────────────────────────────────────────────────────

const OPENAI_BATCH: OpenAIBatch = {
  id: 'batch_01',
  object: 'batch',
  endpoint: '/v1/chat/completions',
  input_file_id: 'file_01',
  completion_window: '24h',
  created_at: 1_756_512_000,
  status: 'completed',
  output_file_id: 'file_02',
  request_counts: { completed: 2, failed: 0, total: 2 },
};

function createFakeOpenAIClient(failure?: unknown): {
  client: OpenAIBatchClient;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];

  function record(method: string, argument: unknown): void {
    calls.push({ method, argument });
    if (failure !== undefined) throw failure;
  }

  return {
    calls,
    client: {
      batches: {
        async create(body) {
          record('create', body);
          return OPENAI_BATCH;
        },
        async retrieve(batchId) {
          record('retrieve', batchId);
          return OPENAI_BATCH;
        },
        list(query) {
          record('list', query);
          return (async function* () {
            yield OPENAI_BATCH;
            yield { ...OPENAI_BATCH, id: 'batch_02' };
          })();
        },
        async cancel(batchId) {
          record('cancel', batchId);
          return { ...OPENAI_BATCH, status: 'cancelling' };
        },
      },
    },
  };
}

describe('createOpenAIBatchClient — injected client', () => {
  it('creates a batch from an uploaded input file', async () => {
    const { client, calls } = createFakeOpenAIClient();
    const batches = createOpenAIBatchClient({ client });
    const request = {
      completion_window: '24h',
      endpoint: '/v1/chat/completions',
      input_file_id: 'file_01',
    } as const;

    expect(await batches.create(request)).toEqual(OPENAI_BATCH);
    expect(calls).toEqual([{ method: 'create', argument: request }]);
  });

  it('retrieves one batch by id', async () => {
    const { client, calls } = createFakeOpenAIClient();
    const batches = createOpenAIBatchClient({ client });

    const batch = await batches.retrieve('batch_01');

    expect(batch.output_file_id).toBe('file_02');
    expect(calls).toEqual([{ method: 'retrieve', argument: 'batch_01' }]);
  });

  it('iterates every listed batch and forwards the cursor query', async () => {
    const { client, calls } = createFakeOpenAIClient();
    const batches = createOpenAIBatchClient({ client });

    const listed = await collect(batches.list({ after: 'batch_00', limit: 2 }));

    expect(listed.map((batch) => batch.id)).toEqual(['batch_01', 'batch_02']);
    expect(calls).toEqual([{ method: 'list', argument: { after: 'batch_00', limit: 2 } }]);
  });

  it('cancels one batch by id', async () => {
    const { client, calls } = createFakeOpenAIClient();
    const batches = createOpenAIBatchClient({ client });

    const cancelled = await batches.cancel('batch_01');

    expect(cancelled.status).toBe('cancelling');
    expect(calls).toEqual([{ method: 'cancel', argument: 'batch_01' }]);
  });

  it('wraps an SDK failure from every operation in a ProviderError', async () => {
    const { client } = createFakeOpenAIClient(new Error('bad request'));
    const batches = createOpenAIBatchClient({ client });

    const failures = [
      batches.create({ completion_window: '24h', endpoint: '/v1/responses', input_file_id: 'f' }),
      batches.retrieve('batch_01'),
      collect(batches.list()),
      batches.cancel('batch_01'),
    ];

    for (const failure of failures) {
      const error = await failure.then(
        () => undefined,
        (thrown: unknown) => thrown,
      );
      expect(error).toBeInstanceOf(ProviderError);
      expect((error as ProviderError).provider).toBe('openai');
    }
  });

  it('passes an existing ProviderError through rather than nesting it', async () => {
    const original = new ProviderError({ provider: 'openai', cause: new Error('boom') });
    const { client } = createFakeOpenAIClient(original);
    const batches = createOpenAIBatchClient({ client });

    await expect(batches.retrieve('batch_01')).rejects.toBe(original);
  });
});

describe('createOpenAIBatchClient — SDK construction', () => {
  it('constructs a real openai client from an apiKey, lazily', async () => {
    const server = createRecordingServer(OPENAI_BATCH);
    // The factory exposes no `baseURL` on purpose (a custom OpenAI base URL is
    // the local-server case that has no batches endpoint), so the local stand-in
    // is reached through the SDK's own documented `OPENAI_BASE_URL` default.
    const previousBaseUrl = process.env['OPENAI_BASE_URL'];
    process.env['OPENAI_BASE_URL'] = `${server.baseURL}/v1`;
    try {
      const batches = createOpenAIBatchClient({ apiKey: PLACEHOLDER_TOKEN });

      expect(server.requests).toEqual([]);

      const batch = await batches.retrieve('batch_01');

      expect(batch.id).toBe('batch_01');
      expect(server.requests).toEqual([{ method: 'GET', path: '/v1/batches/batch_01' }]);
    } finally {
      if (previousBaseUrl === undefined) delete process.env['OPENAI_BASE_URL'];
      else process.env['OPENAI_BASE_URL'] = previousBaseUrl;
      server.stop();
    }
  });
});

// ── Gemini ──────────────────────────────────────────────────────────

const GEMINI_JOB: GeminiBatchJob = {
  name: 'batches/abc123',
  displayName: 'nightly-scoring',
  state: 'JOB_STATE_SUCCEEDED',
  model: 'gemini-2.0-flash',
  createTime: '2026-08-30T00:00:00Z',
  endTime: '2026-08-30T01:00:00Z',
};

const GEMINI_DELETED: GeminiDeleteResourceJob = { name: 'batches/abc123', done: true };

function createFakeGeminiClient(failure?: unknown): {
  client: GeminiBatchClient;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];

  function record(method: string, argument: unknown): void {
    calls.push({ method, argument });
    if (failure !== undefined) throw failure;
  }

  return {
    calls,
    client: {
      batches: {
        async create(params) {
          record('create', params);
          return GEMINI_JOB;
        },
        async get(params) {
          record('get', params);
          return GEMINI_JOB;
        },
        async list(params) {
          record('list', params);
          return (async function* () {
            yield GEMINI_JOB;
            yield { ...GEMINI_JOB, name: 'batches/def456' };
          })();
        },
        async cancel(params) {
          record('cancel', params);
        },
        async delete(params) {
          record('delete', params);
          return GEMINI_DELETED;
        },
      },
    },
  };
}

describe('createGeminiBatchClient — injected client', () => {
  it('creates a batch job from a source and model, keeping Gemini’s own request shape', async () => {
    const { client, calls } = createFakeGeminiClient();
    const batches = createGeminiBatchClient({ client });
    const request = {
      model: 'gemini-2.0-flash',
      src: { gcsUri: 'gs://bucket/input.jsonl', format: 'jsonl' },
    };

    expect(await batches.create(request)).toEqual(GEMINI_JOB);
    expect(calls).toEqual([{ method: 'create', argument: request }]);
  });

  it('gets one job by resource name rather than a bare id', async () => {
    const { client, calls } = createFakeGeminiClient();
    const batches = createGeminiBatchClient({ client });

    const job = await batches.get({ name: 'batches/abc123' });

    expect(job.state).toBe('JOB_STATE_SUCCEEDED');
    expect(calls).toEqual([{ method: 'get', argument: { name: 'batches/abc123' } }]);
  });

  it('flattens the pager into an async iterable of jobs', async () => {
    const { client, calls } = createFakeGeminiClient();
    const batches = createGeminiBatchClient({ client });

    const listed = await collect(batches.list({ config: { pageSize: 2 } }));

    expect(listed.map((job) => job.name)).toEqual(['batches/abc123', 'batches/def456']);
    expect(calls).toEqual([{ method: 'list', argument: { config: { pageSize: 2 } } }]);
  });

  it('cancels a job and resolves to nothing, as Gemini returns no body', async () => {
    const { client, calls } = createFakeGeminiClient();
    const batches = createGeminiBatchClient({ client });

    expect(await batches.cancel({ name: 'batches/abc123' })).toBeUndefined();
    expect(calls).toEqual([{ method: 'cancel', argument: { name: 'batches/abc123' } }]);
  });

  it('deletes a job — the one operation only Gemini offers', async () => {
    const { client, calls } = createFakeGeminiClient();
    const batches = createGeminiBatchClient({ client });

    expect(await batches.delete({ name: 'batches/abc123' })).toEqual(GEMINI_DELETED);
    expect(calls).toEqual([{ method: 'delete', argument: { name: 'batches/abc123' } }]);
  });

  it('wraps an SDK failure from every operation in a ProviderError', async () => {
    const { client } = createFakeGeminiClient(new Error('permission denied'));
    const batches = createGeminiBatchClient({ client });

    const failures = [
      batches.create({ src: 'files/input' }),
      batches.get({ name: 'batches/abc123' }),
      collect(batches.list()),
      batches.cancel({ name: 'batches/abc123' }),
      batches.delete({ name: 'batches/abc123' }),
    ];

    for (const failure of failures) {
      const error = await failure.then(
        () => undefined,
        (thrown: unknown) => thrown,
      );
      expect(error).toBeInstanceOf(ProviderError);
      expect((error as ProviderError).provider).toBe('gemini');
    }
  });
});

describe('createGeminiBatchClient — SDK construction', () => {
  it('constructs a real @google/genai client from apiKey and baseURL, lazily', async () => {
    const server = createRecordingServer({ name: 'batches/abc123' });
    try {
      const batches = createGeminiBatchClient({
        apiKey: PLACEHOLDER_TOKEN,
        baseURL: server.baseURL,
      });

      expect(server.requests).toEqual([]);

      await batches.get({ name: 'batches/abc123' });

      expect(server.requests).toHaveLength(1);
      expect(server.requests[0]?.method).toBe('GET');
      expect(server.requests[0]?.path).toContain('batches/abc123');
    } finally {
      server.stop();
    }
  });

  it('fails with a ProviderError when no apiKey and no GOOGLE_API_KEY are available', async () => {
    const previousKey = process.env['GOOGLE_API_KEY'];
    delete process.env['GOOGLE_API_KEY'];
    try {
      const batches = createGeminiBatchClient();
      const error = await batches.get({ name: 'batches/abc123' }).then(
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

// ── Capability reporting ────────────────────────────────────────────

describe('getProviderCapabilities', () => {
  it('reports every capability for anthropic', () => {
    expect(getProviderCapabilities('anthropic')).toEqual({
      batchInference: true,
      explicitThinkingRequest: true,
      requestControlledContextCaching: true,
      serverSideTokenCounting: true,
    });
  });

  it('reports batch inference only for openai on its default base URL', () => {
    expect(getProviderCapabilities('openai')).toEqual({
      batchInference: true,
      explicitThinkingRequest: false,
      requestControlledContextCaching: false,
      serverSideTokenCounting: false,
    });
  });

  it('withholds batch inference for openai behind a custom base URL', () => {
    expect(getProviderCapabilities('openai', { baseURL: 'http://localhost:11434/v1' })).toEqual({
      batchInference: false,
      explicitThinkingRequest: false,
      requestControlledContextCaching: false,
      serverSideTokenCounting: false,
    });
  });

  it('treats an empty-string base URL as the default openai endpoint', () => {
    // Client construction writes the option through `if (baseURL)`, so an empty
    // string never reaches the SDK and the default endpoint is used. The
    // capability report has to agree with that or it would contradict the
    // request the caller will actually make.
    expect(getProviderCapabilities('openai', { baseURL: '' }).batchInference).toBe(true);
  });

  it('reports batching, caching, and token counting — but not thinking — for gemini', () => {
    expect(getProviderCapabilities('gemini')).toEqual({
      batchInference: true,
      explicitThinkingRequest: false,
      requestControlledContextCaching: true,
      serverSideTokenCounting: true,
    });
  });

  it('reports nothing for the embedding-only providers', () => {
    const none = {
      batchInference: false,
      explicitThinkingRequest: false,
      requestControlledContextCaching: false,
      serverSideTokenCounting: false,
    };

    expect(getProviderCapabilities('voyage')).toEqual(none);
    expect(getProviderCapabilities('ollama')).toEqual(none);
  });

  it('ignores a base URL for providers whose baseURL means a forwarding proxy', () => {
    // Anthropic's and Gemini's `baseURL` document a credential-injecting proxy
    // origin, which still speaks the full provider API — unlike OpenAI's, which
    // is the documented OpenAI-compatible-server escape hatch.
    expect(getProviderCapabilities('anthropic', { baseURL: 'https://proxy.internal' })).toEqual(
      getProviderCapabilities('anthropic'),
    );
    expect(getProviderCapabilities('gemini', { baseURL: 'https://proxy.internal' })).toEqual(
      getProviderCapabilities('gemini'),
    );
  });
});
