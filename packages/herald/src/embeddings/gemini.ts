import type { Embedder, EmbeddingVector } from 'interoperability';

import { HeraldError } from '../errors.ts';

/**
 * Structural interface for the Gemini embedding model surface used by the embedder.
 */
export interface GeminiEmbeddingModel {
  embedContent(params: { content: { parts: Array<{ text: string }> } }): Promise<{
    embedding: { values: number[] };
  }>;
}

/**
 * Structural interface for a Gemini client that can produce embedding models.
 */
export interface GeminiEmbeddingClient {
  getGenerativeModel(params: { model: string }): GeminiEmbeddingModel;
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
 * When no `client` is provided, dynamically imports `@google/generative-ai`
 * and constructs one using `apiKey`. This embedder does not read an environment
 * variable, so pass `apiKey` (or a `client`) explicitly. (The OpenAI embedder
 * differs: the `openai` SDK falls back to `OPENAI_API_KEY` when no key is given.)
 */
export function createGeminiEmbedder(options: GeminiEmbedderOptions = {}): Embedder {
  const { model = 'gemini-embedding-001' } = options;
  let clientPromise: Promise<GeminiEmbeddingClient> | undefined;

  function getClient(): Promise<GeminiEmbeddingClient> {
    if (options.client) return Promise.resolve(options.client);
    if (!clientPromise) {
      clientPromise = import('@google/generative-ai').then((module) => {
        const GoogleGenerativeAI = module.GoogleGenerativeAI;
        const apiKey = options.apiKey ?? '';
        return new GoogleGenerativeAI(apiKey) as unknown as GeminiEmbeddingClient;
      });
    }
    return clientPromise;
  }

  return async (texts: string[]): Promise<EmbeddingVector[]> => {
    const client = await getClient();
    const embeddingModel = client.getGenerativeModel({ model });

    try {
      const vectors: EmbeddingVector[] = [];
      for (const text of texts) {
        const result = await embeddingModel.embedContent({
          content: { parts: [{ text }] },
        });
        vectors.push(result.embedding.values);
      }
      return vectors;
    } catch (error) {
      throw new HeraldError({ provider: 'gemini', cause: error });
    }
  };
}
