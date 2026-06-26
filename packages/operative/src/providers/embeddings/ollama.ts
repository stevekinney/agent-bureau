import type { Embedder, EmbeddingVector } from 'interoperability';

import { ProviderError } from '../errors.ts';

/**
 * Options for createOllamaEmbedder.
 */
export interface OllamaEmbedderOptions {
  model?: string;
  baseURL?: string;
}

/**
 * Creates an Embedder backed by the Ollama embedding API.
 *
 * Uses fetch directly (no SDK required).
 * Default model is `nomic-embed-text`, default base URL is `http://localhost:11434`.
 */
export function createOllamaEmbedder(options: OllamaEmbedderOptions = {}): Embedder {
  const { model = 'nomic-embed-text', baseURL = 'http://localhost:11434' } = options;
  const endpoint = `${baseURL.replace(/\/+$/, '')}/api/embed`;

  return async (texts: string[]): Promise<EmbeddingVector[]> => {
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          input: texts,
        }),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw Object.assign(new Error(`Ollama API error: ${response.status} ${body}`), {
          status: response.status,
        });
      }

      const json = (await response.json()) as {
        embeddings: number[][];
      };

      return json.embeddings;
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError({ provider: 'ollama', cause: error });
    }
  };
}
