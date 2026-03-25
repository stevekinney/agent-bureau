import { afterEach, describe, expect, it, mock } from 'bun:test';

import { createOllamaEmbedder } from '../../src/embeddings/ollama.ts';
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

describe('createOllamaEmbedder', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns correct vectors from the API response', async () => {
    mockFetch({
      ok: true,
      status: 200,
      body: {
        embeddings: [
          [0.1, 0.2],
          [0.3, 0.4],
        ],
      },
    });
    const embedder = createOllamaEmbedder();

    const result = await embedder(['hello', 'world']);

    expect(result).toEqual([
      [0.1, 0.2],
      [0.3, 0.4],
    ]);
  });

  it('uses the default model nomic-embed-text', async () => {
    const calls = mockFetch({
      ok: true,
      status: 200,
      body: { embeddings: [[0.1]] },
    });
    const embedder = createOllamaEmbedder();

    await embedder(['test']);

    const body = JSON.parse(calls[0].init.body as string);
    expect(body.model).toBe('nomic-embed-text');
  });

  it('uses a custom model when provided', async () => {
    const calls = mockFetch({
      ok: true,
      status: 200,
      body: { embeddings: [[0.1]] },
    });
    const embedder = createOllamaEmbedder({ model: 'mxbai-embed-large' });

    await embedder(['test']);

    const body = JSON.parse(calls[0].init.body as string);
    expect(body.model).toBe('mxbai-embed-large');
  });

  it('sends the request to the default endpoint', async () => {
    const calls = mockFetch({
      ok: true,
      status: 200,
      body: { embeddings: [[0.1]] },
    });
    const embedder = createOllamaEmbedder();

    await embedder(['test']);

    expect(calls[0].url).toBe('http://localhost:11434/api/embed');
  });

  it('uses a custom base URL when provided', async () => {
    const calls = mockFetch({
      ok: true,
      status: 200,
      body: { embeddings: [[0.1]] },
    });
    const embedder = createOllamaEmbedder({ baseURL: 'http://my-server:8080' });

    await embedder(['test']);

    expect(calls[0].url).toBe('http://my-server:8080/api/embed');
  });

  it('strips trailing slashes from the base URL', async () => {
    const calls = mockFetch({
      ok: true,
      status: 200,
      body: { embeddings: [[0.1]] },
    });
    const embedder = createOllamaEmbedder({ baseURL: 'http://my-server:8080/' });

    await embedder(['test']);

    expect(calls[0].url).toBe('http://my-server:8080/api/embed');
  });

  it('passes the input texts in the request body', async () => {
    const calls = mockFetch({
      ok: true,
      status: 200,
      body: { embeddings: [[0.1], [0.2]] },
    });
    const embedder = createOllamaEmbedder();

    await embedder(['alpha', 'beta']);

    const body = JSON.parse(calls[0].init.body as string);
    expect(body.input).toEqual(['alpha', 'beta']);
  });

  it('wraps non-OK responses in HeraldError with provider set to ollama', async () => {
    mockFetch({
      ok: false,
      status: 500,
      body: { error: 'Internal server error' },
    });
    const embedder = createOllamaEmbedder();

    try {
      await embedder(['test']);
      expect.unreachable('Expected embedder to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(HeraldError);
      const heraldError = error as HeraldError;
      expect(heraldError.provider).toBe('ollama');
      expect(heraldError.statusCode).toBe(500);
    }
  });

  it('marks server errors (500) as retryable', async () => {
    mockFetch({
      ok: false,
      status: 500,
      body: { error: 'Internal server error' },
    });
    const embedder = createOllamaEmbedder();

    try {
      await embedder(['test']);
      expect.unreachable('Expected embedder to throw');
    } catch (error) {
      const heraldError = error as HeraldError;
      expect(heraldError.statusCode).toBe(500);
      expect(heraldError.retryable).toBe(true);
    }
  });

  it('wraps fetch network errors in HeraldError', async () => {
    globalThis.fetch = mock(() => {
      return Promise.reject(new Error('Network error'));
    }) as typeof globalThis.fetch;

    const embedder = createOllamaEmbedder();

    try {
      await embedder(['test']);
      expect.unreachable('Expected embedder to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(HeraldError);
      const heraldError = error as HeraldError;
      expect(heraldError.provider).toBe('ollama');
    }
  });
});
