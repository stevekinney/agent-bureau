import { describe, expect, it } from 'bun:test';

import type { GeminiEmbeddingClient } from '../../src/embeddings/gemini.ts';
import { createGeminiEmbedder } from '../../src/embeddings/gemini.ts';
import { HeraldError } from '../../src/errors.ts';

function createMockClient(
  embeddings: number[][],
  error?: Error,
): GeminiEmbeddingClient & { _calls: Array<{ model: string; text: string }> } {
  const _calls: Array<{ model: string; text: string }> = [];
  let callIndex = 0;

  return {
    _calls,
    getGenerativeModel(params: { model: string }) {
      const model = params.model;
      return {
        embedContent(contentParams: { content: { parts: Array<{ text: string }> } }) {
          const text = contentParams.content.parts[0].text;
          _calls.push({ model, text });
          if (error) throw error;
          const embedding = embeddings[callIndex];
          callIndex += 1;
          return Promise.resolve({ embedding: { values: embedding } });
        },
      };
    },
  };
}

describe('createGeminiEmbedder', () => {
  it('returns correct vectors from the client response', async () => {
    const client = createMockClient([
      [0.1, 0.2],
      [0.3, 0.4],
    ]);
    const embedder = createGeminiEmbedder({ client });

    const result = await embedder(['hello', 'world']);

    expect(result).toEqual([
      [0.1, 0.2],
      [0.3, 0.4],
    ]);
  });

  it('uses the default model gemini-embedding-001', async () => {
    const client = createMockClient([[0.1]]);
    const embedder = createGeminiEmbedder({ client });

    await embedder(['test']);

    expect(client._calls[0].model).toBe('gemini-embedding-001');
  });

  it('uses a custom model when provided', async () => {
    const client = createMockClient([[0.1]]);
    const embedder = createGeminiEmbedder({ client, model: 'text-embedding-004' });

    await embedder(['test']);

    expect(client._calls[0].model).toBe('text-embedding-004');
  });

  it('calls embedContent for each text individually', async () => {
    const client = createMockClient([[0.1], [0.2], [0.3]]);
    const embedder = createGeminiEmbedder({ client });

    await embedder(['alpha', 'beta', 'gamma']);

    expect(client._calls).toHaveLength(3);
    expect(client._calls[0].text).toBe('alpha');
    expect(client._calls[1].text).toBe('beta');
    expect(client._calls[2].text).toBe('gamma');
  });

  it('wraps SDK errors in HeraldError with provider set to gemini', async () => {
    const sdkError = new Error('API failure');
    const client = createMockClient([], sdkError);
    const embedder = createGeminiEmbedder({ client });

    try {
      await embedder(['test']);
      expect.unreachable('Expected embedder to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(HeraldError);
      const heraldError = error as HeraldError;
      expect(heraldError.provider).toBe('gemini');
      expect(heraldError.cause).toBe(sdkError);
    }
  });

  it('marks rate limit errors (429) as retryable', async () => {
    const rateLimitError = Object.assign(new Error('Rate limited'), { status: 429 });
    const client = createMockClient([], rateLimitError);
    const embedder = createGeminiEmbedder({ client });

    try {
      await embedder(['test']);
      expect.unreachable('Expected embedder to throw');
    } catch (error) {
      const heraldError = error as HeraldError;
      expect(heraldError.statusCode).toBe(429);
      expect(heraldError.retryable).toBe(true);
    }
  });

  it('loads the SDK when no client is provided', async () => {
    const embedder = createGeminiEmbedder({ apiKey: 'sk-test-invalid' });

    try {
      await embedder(['test']);
      expect.unreachable('Expected embedder to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(HeraldError);
      expect((error as HeraldError).provider).toBe('gemini');
    }
  });

  it('throws a clear HeraldError when neither client nor apiKey is provided', async () => {
    const embedder = createGeminiEmbedder();

    try {
      await embedder(['test']);
      expect.unreachable('Expected embedder to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(HeraldError);
      const heraldError = error as HeraldError;
      expect(heraldError.provider).toBe('gemini');
      expect(heraldError.message).toContain('apiKey');
    }
  });
});
