export type EmbeddingVector = number[];
export type Embedder = (texts: string[]) => EmbeddingVector[] | Promise<EmbeddingVector[]>;
