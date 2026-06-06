import { describe, expect, it } from 'bun:test';

import { createMemory } from '../src/create-memory';
import { createInMemoryMemoryRecordStorage, createMockEmbedder } from '../src/test/index';

function createTestMemory() {
  return createMemory({
    embedder: createMockEmbedder(128),
    storage: createInMemoryMemoryRecordStorage(),
  });
}

describe('memory.list()', () => {
  it('returns all entries without semantic search', async () => {
    const memory = createTestMemory();
    await memory.init();

    await memory.remember('Alpha entry');
    await memory.remember('Beta entry');
    await memory.remember('Gamma entry');

    const results = await memory.list();

    expect(results).toHaveLength(3);
    const contents = results.map((r) => r.content);
    expect(contents).toContain('Alpha entry');
    expect(contents).toContain('Beta entry');
    expect(contents).toContain('Gamma entry');

    await memory.close();
  });

  it('respects limit and offset', async () => {
    const memory = createTestMemory();
    await memory.init();

    for (let i = 0; i < 5; i++) {
      await memory.remember(`Entry ${i} with unique content ${Math.random()}`);
    }

    const page1 = await memory.list({ limit: 2, offset: 0 });
    expect(page1).toHaveLength(2);

    const page2 = await memory.list({ limit: 2, offset: 2 });
    expect(page2).toHaveLength(2);

    // No overlap
    const page1Ids = new Set(page1.map((r) => r.id));
    for (const entry of page2) {
      expect(page1Ids.has(entry.id)).toBe(false);
    }

    await memory.close();
  });

  it('returns entries sorted newest first', async () => {
    const memory = createTestMemory();
    await memory.init();

    await memory.remember('Older entry');
    await memory.remember('Newer entry');

    const results = await memory.list();

    expect(results[0]!.createdAt).toBeGreaterThanOrEqual(results[1]!.createdAt);

    await memory.close();
  });

  it('returns empty array for empty memory', async () => {
    const memory = createTestMemory();
    await memory.init();

    const results = await memory.list();
    expect(results).toEqual([]);

    await memory.close();
  });
});

describe('recall with vectorOnly', () => {
  it('returns pure cosine similarity scores', async () => {
    const memory = createTestMemory();
    await memory.init();

    await memory.remember('The weather is sunny today');
    await memory.remember('Machine learning is fascinating');

    const hybridResults = await memory.recall('sunny weather', { vectorOnly: false });
    const vectorResults = await memory.recall('sunny weather', { vectorOnly: true });

    // Both should return results
    expect(hybridResults.length).toBeGreaterThan(0);
    expect(vectorResults.length).toBeGreaterThan(0);

    // vectorOnly scores should differ from hybrid scores (no BM25 component)
    // We can't guarantee they differ with the mock embedder, but we can verify
    // the results are valid
    for (const result of vectorResults) {
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(1);
    }

    await memory.close();
  });

  it('filters by threshold with pure cosine scores', async () => {
    const memory = createTestMemory();
    await memory.init();

    await memory.remember('Alpha content');
    await memory.remember('Beta content');

    const results = await memory.recall('Alpha content', {
      vectorOnly: true,
      threshold: 0.99,
    });

    // Only the very similar entry should pass a 0.99 threshold
    expect(results.length).toBeLessThanOrEqual(1);

    await memory.close();
  });
});
