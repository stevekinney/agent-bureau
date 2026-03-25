import { describe, expect, it } from 'bun:test';

import type { OpenAIEmbeddingClient } from '../../src/embeddings/openai.ts';
import { createOpenAIEmbedder } from '../../src/embeddings/openai.ts';
import { HeraldError } from '../../src/errors.ts';

function createMockClient(
  responses: Array<{ data: Array<{ embedding: number[] }> }>,
  errors: Error[] = [],
): OpenAIEmbeddingClient & { _calls: Record<string, unknown>[] } {
  let callIndex = 0;
  const _calls: Record<string, unknown>[] = [];

  return {
    _calls,
    embeddings: {
      create(params: Record<string, unknown>) {
        _calls.push(params);
        if (errors[callIndex]) {
          throw errors[callIndex];
        }
        const response = responses[callIndex];
        callIndex += 1;
        return Promise.resolve(response);
      },
    },
  };
}

describe('createOpenAIEmbedder', () => {
  it('returns correct vectors from the client response', async () => {
    const client = createMockClient([
      { data: [{ embedding: [0.1, 0.2] }, { embedding: [0.3, 0.4] }] },
    ]);
    const embedder = createOpenAIEmbedder({ client });

    const result = await embedder(['hello', 'world']);

    expect(result).toEqual([
      [0.1, 0.2],
      [0.3, 0.4],
    ]);
  });

  it('uses the default model text-embedding-3-small', async () => {
    const client = createMockClient([{ data: [{ embedding: [0.1] }] }]);
    const embedder = createOpenAIEmbedder({ client });

    await embedder(['test']);

    expect(client._calls[0]['model']).toBe('text-embedding-3-small');
  });

  it('uses a custom model when provided', async () => {
    const client = createMockClient([{ data: [{ embedding: [0.1] }] }]);
    const embedder = createOpenAIEmbedder({ client, model: 'text-embedding-3-large' });

    await embedder(['test']);

    expect(client._calls[0]['model']).toBe('text-embedding-3-large');
  });

  it('passes the input texts to the client', async () => {
    const client = createMockClient([{ data: [{ embedding: [0.1] }, { embedding: [0.2] }] }]);
    const embedder = createOpenAIEmbedder({ client });

    await embedder(['alpha', 'beta']);

    expect(client._calls[0]['input']).toEqual(['alpha', 'beta']);
  });

  it('wraps SDK errors in HeraldError with provider set to openai', async () => {
    const sdkError = new Error('API failure');
    const client = createMockClient([], [sdkError]);
    const embedder = createOpenAIEmbedder({ client });

    try {
      await embedder(['test']);
      expect.unreachable('Expected embedder to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(HeraldError);
      const heraldError = error as HeraldError;
      expect(heraldError.provider).toBe('openai');
      expect(heraldError.cause).toBe(sdkError);
    }
  });

  it('marks rate limit errors (429) as retryable', async () => {
    const rateLimitError = Object.assign(new Error('Rate limited'), { status: 429 });
    const client = createMockClient([], [rateLimitError]);
    const embedder = createOpenAIEmbedder({ client });

    try {
      await embedder(['test']);
      expect.unreachable('Expected embedder to throw');
    } catch (error) {
      const heraldError = error as HeraldError;
      expect(heraldError.statusCode).toBe(429);
      expect(heraldError.retryable).toBe(true);
    }
  });
});
