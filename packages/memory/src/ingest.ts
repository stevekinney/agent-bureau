import type { ChunkingOptions } from './chunking';
import { chunkMarkdown } from './chunking';
import type { Memory, MemoryEntry, MemoryMetadata } from './types';

export const SOURCE_DOCUMENT_KEY = '__sourceDocument';
export const CHUNK_INDEX_KEY = '__chunkIndex';

export interface IngestOptions extends ChunkingOptions {
  /** Identifier for the source document. Used for result deduplication in recall. */
  sourceIdentifier?: string;
  /** Additional metadata to attach to each chunk. */
  metadata?: Partial<MemoryMetadata>;
  /** Progress callback fired after each chunk is stored. */
  onProgress?: (progress: { completed: number; total: number }) => void;
}

export interface IngestResult {
  sourceIdentifier: string;
  entries: MemoryEntry[];
  chunkCount: number;
}

/**
 * Chunks content and stores each chunk as a separate memory entry.
 *
 * Each chunk's metadata includes `__sourceDocument` and `__chunkIndex` keys
 * that enable `recall()` to deduplicate results from the same source document,
 * returning only the highest-scoring chunk per source.
 */
export async function ingest(
  memory: Memory,
  content: string,
  options?: IngestOptions,
): Promise<IngestResult> {
  const sourceIdentifier = options?.sourceIdentifier ?? crypto.randomUUID();
  const chunks = chunkMarkdown(content, options);

  const entries: MemoryEntry[] = [];

  for (const chunk of chunks) {
    const entry = await memory.remember(chunk.text, {
      ...options?.metadata,
      [SOURCE_DOCUMENT_KEY]: sourceIdentifier,
      [CHUNK_INDEX_KEY]: chunk.index,
    });
    entries.push(entry);

    options?.onProgress?.({ completed: entries.length, total: chunks.length });
  }

  return {
    sourceIdentifier,
    entries,
    chunkCount: chunks.length,
  };
}
