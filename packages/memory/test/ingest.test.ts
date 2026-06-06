import { beforeEach, describe, expect, it } from 'bun:test';

import { createMemory } from '../src/create-memory';
import { CHUNK_INDEX_KEY, ingest, SOURCE_DOCUMENT_KEY } from '../src/ingest';
import { createInMemoryMemoryRecordStorage, createMockEmbedder } from '../src/test/index';
import type { Memory } from '../src/types';

const DIMENSION = 64;

describe('ingest', () => {
  let memory: Memory;

  beforeEach(async () => {
    const storage = createInMemoryMemoryRecordStorage();
    const embedder = createMockEmbedder(DIMENSION);
    memory = createMemory({ embedder, storage, dimension: DIMENSION });
    await memory.init();
  });

  it('stores short content as a single chunk', async () => {
    const result = await ingest(memory, 'Short note about testing.');

    expect(result.chunkCount).toBe(1);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.content).toBe('Short note about testing.');
    expect(result.sourceIdentifier).toBeDefined();
  });

  it('stores long content as multiple chunks', async () => {
    const lines = Array.from({ length: 30 }, (_, i) => `Line ${i}: ${'word '.repeat(20)}`);
    const content = lines.join('\n');

    const result = await ingest(memory, content);

    expect(result.chunkCount).toBeGreaterThan(1);
    expect(result.entries).toHaveLength(result.chunkCount);
  });

  it('attaches source document metadata to each chunk', async () => {
    const lines = Array.from({ length: 30 }, (_, i) => `Line ${i}: ${'data '.repeat(20)}`);
    const content = lines.join('\n');

    const result = await ingest(memory, content, { sourceIdentifier: 'test-doc' });

    for (let i = 0; i < result.entries.length; i++) {
      expect(result.entries[i]!.metadata[SOURCE_DOCUMENT_KEY]).toBe('test-doc');
      expect(result.entries[i]!.metadata[CHUNK_INDEX_KEY]).toBe(i);
    }
  });

  it('uses a custom source identifier when provided', async () => {
    const result = await ingest(memory, 'Some content', { sourceIdentifier: 'my-doc-id' });

    expect(result.sourceIdentifier).toBe('my-doc-id');
    expect(result.entries[0]!.metadata[SOURCE_DOCUMENT_KEY]).toBe('my-doc-id');
  });

  it('generates a source identifier when none is provided', async () => {
    const result = await ingest(memory, 'Some content');

    expect(result.sourceIdentifier).toBeDefined();
    expect(typeof result.sourceIdentifier).toBe('string');
    expect(result.sourceIdentifier.length).toBeGreaterThan(0);
  });

  it('attaches additional metadata to each chunk', async () => {
    const result = await ingest(memory, 'Tagged content', {
      metadata: { tags: ['test'], importance: 0.8 },
    });

    expect(result.entries[0]!.metadata.tags).toEqual(['test']);
    expect(result.entries[0]!.metadata.importance).toBe(0.8);
  });

  it('fires onProgress after each chunk', async () => {
    const lines = Array.from({ length: 30 }, (_, i) => `Line ${i}: ${'data '.repeat(20)}`);
    const content = lines.join('\n');
    const progressEvents: Array<{ completed: number; total: number }> = [];

    const result = await ingest(memory, content, {
      onProgress: (progress) => progressEvents.push({ ...progress }),
    });

    expect(progressEvents).toHaveLength(result.chunkCount);
    expect(progressEvents[0]!.completed).toBe(1);
    expect(progressEvents[progressEvents.length - 1]!.completed).toBe(result.chunkCount);
    expect(progressEvents[progressEvents.length - 1]!.total).toBe(result.chunkCount);
  });

  it('deduplicates recall results by source document', async () => {
    const lines = Array.from({ length: 30 }, (_, i) => `Line ${i}: database connection pool`);
    const content = lines.join('\n');

    await ingest(memory, content, { sourceIdentifier: 'doc-a' });

    // All chunks talk about "database connection pool", so multiple would match.
    const results = await memory.recall('database connection pool', { limit: 10 });

    // With deduplication, we should get at most 1 result per source document.
    const sourceDocuments = results.map((r) => r.metadata[SOURCE_DOCUMENT_KEY]).filter(Boolean);

    const uniqueSources = new Set(sourceDocuments);
    expect(uniqueSources.size).toBe(sourceDocuments.length);
  });

  it('does not deduplicate results from different source documents', async () => {
    await ingest(memory, 'authentication system overview', { sourceIdentifier: 'doc-1' });
    await ingest(memory, 'authentication middleware design', { sourceIdentifier: 'doc-2' });

    const results = await memory.recall('authentication', { limit: 10 });

    const sourceDocuments = results.map((r) => r.metadata[SOURCE_DOCUMENT_KEY]).filter(Boolean);

    // Both source documents should appear.
    expect(new Set(sourceDocuments).size).toBe(2);
  });
});
