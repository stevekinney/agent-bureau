import type { Embedder, EmbeddingVector } from 'interoperability';

import { HeraldError } from '../errors.ts';

/**
 * Options for createVoyageEmbedder.
 */
export interface VoyageEmbedderOptions {
  apiKey: string;
  model?: string;
  endpoint?: string;
}

/**
 * Creates an Embedder backed by the Voyage AI Embeddings API.
 *
 * Uses fetch directly (no SDK required). Requires an `apiKey`.
 */
export function createVoyageEmbedder(options: VoyageEmbedderOptions): Embedder {
  const {
    apiKey,
    model = 'voyage-3',
    endpoint = 'https://api.voyageai.com/v1/embeddings',
  } = options;

  return async (texts: string[]): Promise<EmbeddingVector[]> => {
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          input: texts,
        }),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw Object.assign(new Error(`Voyage API error: ${response.status} ${body}`), {
          status: response.status,
        });
      }

      const json = (await response.json()) as {
        data: Array<{ embedding: number[] }>;
      };

      return json.data.map((entry) => entry.embedding);
    } catch (error) {
      if (error instanceof HeraldError) throw error;
      throw new HeraldError({ provider: 'voyage', cause: error });
    }
  };
}
