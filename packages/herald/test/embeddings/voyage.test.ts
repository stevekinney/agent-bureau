import { afterEach, describe, expect, it, mock } from 'bun:test';

import { createVoyageEmbedder } from '../../src/embeddings/voyage.ts';
import { HeraldError } from '../../src/errors.ts';

const originalFetch = globalThis.fetch;

function mockFetch(response: { ok: boolean; status: number; body: unknown }) {
  const calls: Array<{ url: string; init: RequestInit }> = [];

  globalThis.fetch = mock((url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve({
      ok: response.ok,
      status: response.status,
      json: () => Promise.resolve(response.body),
      text: () => Promise.resolve(JSON.stringify(response.body)),
    } as Response);
  }) as typeof globalThis.fetch;

  return calls;
}

describe('createVoyageEmbedder', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns correct vectors from the API response', async () => {
    mockFetch({
      ok: true,
      status: 200,
      body: { data: [{ embedding: [0.1, 0.2] }, { embedding: [0.3, 0.4] }] },
    });
    const embedder = createVoyageEmbedder({ apiKey: 'test-key' });

    const result = await embedder(['hello', 'world']);

    expect(result).toEqual([
      [0.1, 0.2],
      [0.3, 0.4],
    ]);
  });

  it('uses the default model voyage-3', async () => {
    const calls = mockFetch({
      ok: true,
      status: 200,
      body: { data: [{ embedding: [0.1] }] },
    });
    const embedder = createVoyageEmbedder({ apiKey: 'test-key' });

    await embedder(['test']);

    const body = JSON.parse(calls[0].init.body as string);
    expect(body.model).toBe('voyage-3');
  });

  it('uses a custom model when provided', async () => {
    const calls = mockFetch({
      ok: true,
      status: 200,
      body: { data: [{ embedding: [0.1] }] },
    });
    const embedder = createVoyageEmbedder({ apiKey: 'test-key', model: 'voyage-3-lite' });

    await embedder(['test']);

    const body = JSON.parse(calls[0].init.body as string);
    expect(body.model).toBe('voyage-3-lite');
  });

  it('sends the request to the default endpoint', async () => {
    const calls = mockFetch({
      ok: true,
      status: 200,
      body: { data: [{ embedding: [0.1] }] },
    });
    const embedder = createVoyageEmbedder({ apiKey: 'test-key' });

    await embedder(['test']);

    expect(calls[0].url).toBe('https://api.voyageai.com/v1/embeddings');
  });

  it('sends the Authorization header with the API key', async () => {
    const calls = mockFetch({
      ok: true,
      status: 200,
      body: { data: [{ embedding: [0.1] }] },
    });
    const embedder = createVoyageEmbedder({ apiKey: 'my-secret-key' });

    await embedder(['test']);

    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer my-secret-key');
  });

  it('passes the input texts in the request body', async () => {
    const calls = mockFetch({
      ok: true,
      status: 200,
      body: { data: [{ embedding: [0.1] }, { embedding: [0.2] }] },
    });
    const embedder = createVoyageEmbedder({ apiKey: 'test-key' });

    await embedder(['alpha', 'beta']);

    const body = JSON.parse(calls[0].init.body as string);
    expect(body.input).toEqual(['alpha', 'beta']);
  });

  it('wraps non-OK responses in HeraldError with provider set to voyage', async () => {
    mockFetch({
      ok: false,
      status: 401,
      body: { error: 'Unauthorized' },
    });
    const embedder = createVoyageEmbedder({ apiKey: 'bad-key' });

    try {
      await embedder(['test']);
      expect.unreachable('Expected embedder to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(HeraldError);
      const heraldError = error as HeraldError;
      expect(heraldError.provider).toBe('voyage');
      expect(heraldError.statusCode).toBe(401);
    }
  });

  it('marks rate limit errors (429) as retryable', async () => {
    mockFetch({
      ok: false,
      status: 429,
      body: { error: 'Rate limited' },
    });
    const embedder = createVoyageEmbedder({ apiKey: 'test-key' });

    try {
      await embedder(['test']);
      expect.unreachable('Expected embedder to throw');
    } catch (error) {
      const heraldError = error as HeraldError;
      expect(heraldError.statusCode).toBe(429);
      expect(heraldError.retryable).toBe(true);
    }
  });

  it('uses a custom endpoint when provided', async () => {
    const calls = mockFetch({
      ok: true,
      status: 200,
      body: { data: [{ embedding: [0.1] }] },
    });
    const embedder = createVoyageEmbedder({
      apiKey: 'test-key',
      endpoint: 'https://custom.api.com/embed',
    });

    await embedder(['test']);

    expect(calls[0].url).toBe('https://custom.api.com/embed');
  });
});
