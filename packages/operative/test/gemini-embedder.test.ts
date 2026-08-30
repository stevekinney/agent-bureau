/**
 * Tests for createGeminiEmbedder against `@google/genai`'s client shape.
 *
 * The maintained SDK embeds through `client.models.embedContent({ model,
 * contents })` and answers with a batch whose entries — and whose `values`
 * arrays — are both optional, so the embedder has to narrow before it can
 * hand back an EmbeddingVector.
 *
 * The lazy-construction test calls the embedder with an empty array on
 * purpose: that runs the real dynamic `import('@google/genai')` and the
 * `new GoogleGenAI(...)` construction (both local, no network) without ever
 * reaching `embedContent`, so the SDK-backed branch is covered hermetically.
 */
import { describe, expect, it } from 'bun:test';

import type { GeminiEmbeddingClient } from '../src/providers/embeddings/gemini.ts';
import { createGeminiEmbedder } from '../src/providers/embeddings/gemini.ts';
import { ProviderError } from '../src/providers/errors.ts';

type EmbedRequest = { model: string; contents: Array<{ parts: Array<{ text: string }> }> };
type EmbedResponse = { embeddings?: Array<{ values?: number[] }> };

interface FakeEmbeddingClient extends GeminiEmbeddingClient {
  calls: EmbedRequest[];
}

function createFakeEmbeddingClient(responses: EmbedResponse[]): FakeEmbeddingClient {
  const calls: EmbedRequest[] = [];
  let index = 0;

  return {
    calls,
    models: {
      async embedContent(params: EmbedRequest): Promise<EmbedResponse> {
        calls.push(params);
        return responses[index++] ?? {};
      },
    },
  };
}

describe('createGeminiEmbedder — client injection', () => {
  it('embeds each text in its own request and returns the vectors in order', async () => {
    const client = createFakeEmbeddingClient([
      { embeddings: [{ values: [1, 2] }] },
      { embeddings: [{ values: [3, 4] }] },
    ]);
    const embed = createGeminiEmbedder({ client });

    expect(await embed(['alpha', 'beta'])).toEqual([
      [1, 2],
      [3, 4],
    ]);
    expect(client.calls).toEqual([
      { model: 'gemini-embedding-001', contents: [{ parts: [{ text: 'alpha' }] }] },
      { model: 'gemini-embedding-001', contents: [{ parts: [{ text: 'beta' }] }] },
    ]);
  });

  it('sends the model named in options', async () => {
    const client = createFakeEmbeddingClient([{ embeddings: [{ values: [0] }] }]);
    const embed = createGeminiEmbedder({ client, model: 'text-embedding-004' });

    await embed(['alpha']);

    expect(client.calls[0]?.model).toBe('text-embedding-004');
  });

  it('returns an empty result without calling the API when given no texts', async () => {
    const client = createFakeEmbeddingClient([]);
    const embed = createGeminiEmbedder({ client });

    expect(await embed([])).toEqual([]);
    expect(client.calls).toHaveLength(0);
  });

  it('throws a ProviderError when the response carries no embeddings at all', async () => {
    const client = createFakeEmbeddingClient([{}]);
    const embed = createGeminiEmbedder({ client });

    await expect(embed(['alpha'])).rejects.toBeInstanceOf(ProviderError);
  });

  it('throws a ProviderError when the returned embedding has no values', async () => {
    const client = createFakeEmbeddingClient([{ embeddings: [{}] }]);
    const embed = createGeminiEmbedder({ client });

    const error = await embed(['alpha']).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).provider).toBe('gemini');
    expect((error as ProviderError).message).toContain('gemini');
  });

  it('surfaces an API failure as a ProviderError', async () => {
    const embed = createGeminiEmbedder({
      client: {
        models: {
          embedContent: () => Promise.reject(new Error('embed failed')),
        },
      },
    });

    await expect(embed(['alpha'])).rejects.toBeInstanceOf(ProviderError);
  });
});

describe('createGeminiEmbedder — SDK construction', () => {
  it('throws a ProviderError when neither a client nor an apiKey is given', async () => {
    const embed = createGeminiEmbedder();

    const error = await embed(['alpha']).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).provider).toBe('gemini');
  });

  it('does not read GOOGLE_API_KEY from the environment', async () => {
    const saved = Bun.env['GOOGLE_API_KEY'];
    Bun.env['GOOGLE_API_KEY'] = 'set-but-ignored-by-this-embedder';
    try {
      await expect(createGeminiEmbedder()(['alpha'])).rejects.toBeInstanceOf(ProviderError);
    } finally {
      if (saved === undefined) delete Bun.env['GOOGLE_API_KEY'];
      else Bun.env['GOOGLE_API_KEY'] = saved;
    }
  });

  it('constructs a real @google/genai client from an apiKey, lazily', async () => {
    // An empty text list exercises the dynamic import and client construction
    // and stops before any request would be issued.
    const embed = createGeminiEmbedder({ apiKey: 'placeholder-not-a-real-key-0000' });

    expect(await embed([])).toEqual([]);
    // The second call reuses the memoized client rather than re-importing.
    expect(await embed([])).toEqual([]);
  });
});
