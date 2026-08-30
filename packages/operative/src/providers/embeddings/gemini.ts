import type { Embedder, EmbeddingVector } from 'interoperability';

import { ProviderError } from '../errors.ts';

/**
 * Structural interface for the `@google/genai` `models` namespace surface used
 * by the embedder.
 *
 * The maintained SDK takes the model id on every request rather than binding it
 * to a model handle at construction time, and returns a batch of embeddings
 * whose `values` are optional.
 */
export interface GeminiEmbeddingModel {
  embedContent(params: {
    model: string;
    contents: Array<{ parts: Array<{ text: string }> }>;
  }): Promise<{ embeddings?: Array<{ values?: number[] }> }>;
}

/**
 * Structural interface for a `@google/genai` client that can embed content.
 *
 * A real `GoogleGenAI` instance is assignable to this interface — see
 * `providers/gemini-client-assignability.test-d.ts`, which locks that in.
 */
export interface GeminiEmbeddingClient {
  models: GeminiEmbeddingModel;
}

/**
 * Options for createGeminiEmbedder.
 */
export interface GeminiEmbedderOptions {
  client?: GeminiEmbeddingClient;
  apiKey?: string;
  model?: string;
}

/**
 * Creates an Embedder backed by the Gemini Embedding API.
 *
 * When no `client` is provided, dynamically imports `@google/genai`
 * and constructs one using `apiKey`. This embedder does not read an environment
 * variable, so pass `apiKey` (or a `client`) explicitly. (The OpenAI embedder
 * differs: the `openai` SDK falls back to `OPENAI_API_KEY` when no key is given.)
 */
export function createGeminiEmbedder(options: GeminiEmbedderOptions = {}): Embedder {
  const { model = 'gemini-embedding-001' } = options;
  let clientPromise: Promise<GeminiEmbeddingClient> | undefined;

  function getClient(): Promise<GeminiEmbeddingClient> {
    if (options.client) return Promise.resolve(options.client);
    if (!options.apiKey) {
      // This embedder does not read an environment variable. Fail up front with a
      // clear error rather than constructing a client with an empty key, which
      // would surface as a confusing downstream auth failure.
      throw new ProviderError({
        provider: 'gemini',
        cause: new Error('createGeminiEmbedder requires an `apiKey` (or a `client`).'),
      });
    }
    if (!clientPromise) {
      const { apiKey } = options;
      // No cast: a real `GoogleGenAI` satisfies `GeminiEmbeddingClient` as
      // declared, which is the same guarantee a consumer passing their own
      // client relies on. `gemini-client-assignability.test-d.ts` locks it in.
      clientPromise = import('@google/genai').then((module) => new module.GoogleGenAI({ apiKey }));
    }
    return clientPromise;
  }

  return async (texts: string[]): Promise<EmbeddingVector[]> => {
    const client = await getClient();

    try {
      const vectors: EmbeddingVector[] = [];
      for (const text of texts) {
        const result = await client.models.embedContent({
          model,
          contents: [{ parts: [{ text }] }],
        });
        // `@google/genai` returns a batch whose entries and `values` are both
        // optional. A missing vector is a broken response, not an empty
        // embedding — fail loudly rather than pushing a placeholder.
        const values = result.embeddings?.[0]?.values;
        if (!values) {
          throw new Error(
            `Gemini returned no embedding for the text at index ${vectors.length} (model: ${model}).`,
          );
        }
        vectors.push(values);
      }
      return vectors;
    } catch (error) {
      throw new ProviderError({ provider: 'gemini', cause: error });
    }
  };
}
