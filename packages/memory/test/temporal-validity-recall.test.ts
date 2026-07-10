import { beforeEach, describe, expect, it } from 'bun:test';

import { createMemory } from '../src/create-memory';
import { createInMemoryMemoryRecordStorage, createMockEmbedder } from '../src/test/index';
import type { Memory, MemoryRecordStorage } from '../src/types';

const DIMENSION = 64;

function createTestMemory(options?: { experimentalTemporalValidity?: boolean }) {
  const storage = createInMemoryMemoryRecordStorage();
  const embedder = createMockEmbedder(DIMENSION);
  const memory = createMemory({
    embedder,
    storage,
    dimension: DIMENSION,
    experimentalTemporalValidity: options?.experimentalTemporalValidity ?? true,
  });
  return { memory, storage, embedder };
}

describe('AB-61 temporal fact-validity spike', () => {
  describe('feature gating', () => {
    it('throws when metadata.supersedes is used without the flag enabled', async () => {
      const { memory } = createTestMemory({ experimentalTemporalValidity: false });
      await memory.init();

      const original = await memory.remember('The team lead is Alex');

      let caught: unknown;
      try {
        await memory.remember('The team lead is Jordan', { supersedes: original.id });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toMatch(/experimentalTemporalValidity/);
    });

    it('ignores asOf when the flag is disabled (no filtering behavior change)', async () => {
      const { memory } = createTestMemory({ experimentalTemporalValidity: false });
      await memory.init();

      await memory.remember('The team lead is Alex');
      const results = await memory.recall('team lead', { asOf: 1 });

      // Without the flag, asOf is inert: the record is returned even though
      // it postdates asOf=1.
      expect(results).toHaveLength(1);
    });
  });

  describe('supersession', () => {
    let memory: Memory;
    let storage: MemoryRecordStorage;

    beforeEach(async () => {
      const test = createTestMemory();
      memory = test.memory;
      storage = test.storage;
      await memory.init();
    });

    it('stamps supersededBy and invalidatedAt on the superseded record', async () => {
      const original = await memory.remember('The team lead is Alex');
      const successor = await memory.remember('The team lead is Jordan', {
        supersedes: original.id,
      });

      const stored = await storage.get(original.id, { namespace: 'default' });
      expect(stored?.metadata['supersededBy']).toBe(successor.id);
      expect(stored?.metadata['invalidatedAt']).toBeTypeOf('number');

      // The new record itself carries no leftover `supersedes` directive.
      const storedSuccessor = await storage.get(successor.id, { namespace: 'default' });
      expect(storedSuccessor?.metadata['supersedes']).toBeUndefined();
    });

    it('throws when superseding an id that does not exist in scope', async () => {
      let caught: unknown;
      try {
        await memory.remember('The team lead is Jordan', { supersedes: 'does-not-exist' });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toMatch(/Cannot supersede unknown record/);
    });

    it('supports a supersession chain and each link points to its direct successor', async () => {
      const first = await memory.remember('The team lead is Alex');
      const second = await memory.remember('The team lead is Jordan', {
        supersedes: first.id,
      });
      const third = await memory.remember('The team lead is Priya', {
        supersedes: second.id,
      });

      const storedFirst = await storage.get(first.id, { namespace: 'default' });
      const storedSecond = await storage.get(second.id, { namespace: 'default' });
      const storedThird = await storage.get(third.id, { namespace: 'default' });

      expect(storedFirst?.metadata['supersededBy']).toBe(second.id);
      expect(storedSecond?.metadata['supersededBy']).toBe(third.id);
      expect(storedThird?.metadata['supersededBy']).toBeUndefined();
    });
  });

  describe('as-of recall', () => {
    let memory: Memory;

    beforeEach(async () => {
      const test = createTestMemory();
      memory = test.memory;
      await memory.init();
    });

    it('recall() without asOf returns only the currently-valid fact', async () => {
      const first = await memory.remember('The team lead is Alex');
      const second = await memory.remember('The team lead is Jordan', {
        supersedes: first.id,
      });

      const results = await memory.recall('team lead', { vectorOnly: true, threshold: 0 });
      const ids = results.map((r) => r.id);

      expect(ids).toContain(second.id);
      expect(ids).not.toContain(first.id);
    });

    it('recall() with asOf before the supersession returns the original fact', async () => {
      const first = await memory.remember('The team lead is Alex');
      await new Promise((resolve) => setTimeout(resolve, 5));
      const asOfBeforeSupersession = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 5));

      await memory.remember('The team lead is Jordan', { supersedes: first.id });

      const results = await memory.recall('team lead', {
        vectorOnly: true,
        threshold: 0,
        asOf: asOfBeforeSupersession,
      });
      const ids = results.map((r) => r.id);

      expect(ids).toEqual([first.id]);
    });

    it('walks a supersession chain: asOf resolves to whichever link was valid at that instant', async () => {
      const first = await memory.remember('The team lead is Alex');
      await new Promise((resolve) => setTimeout(resolve, 5));
      const asOfFirst = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 5));

      const second = await memory.remember('The team lead is Jordan', { supersedes: first.id });
      await new Promise((resolve) => setTimeout(resolve, 5));
      const asOfSecond = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 5));

      const third = await memory.remember('The team lead is Priya', { supersedes: second.id });
      const asOfThird = Date.now();

      const atFirst = await memory.recall('team lead', {
        vectorOnly: true,
        threshold: 0,
        asOf: asOfFirst,
      });
      const atSecond = await memory.recall('team lead', {
        vectorOnly: true,
        threshold: 0,
        asOf: asOfSecond,
      });
      const atThird = await memory.recall('team lead', {
        vectorOnly: true,
        threshold: 0,
        asOf: asOfThird,
      });

      expect(atFirst.map((r) => r.id)).toEqual([first.id]);
      expect(atSecond.map((r) => r.id)).toEqual([second.id]);
      expect(atThird.map((r) => r.id)).toEqual([third.id]);
    });

    it('applies validity filtering in the hybrid (non-vectorOnly) recall path too', async () => {
      const first = await memory.remember('The quarterly budget is one million dollars');
      await memory.remember('The quarterly budget is two million dollars', {
        supersedes: first.id,
      });

      const results = await memory.recall('quarterly budget');
      const contents = results.map((r) => r.content);

      expect(contents).toContain('The quarterly budget is two million dollars');
      expect(contents).not.toContain('The quarterly budget is one million dollars');
    });

    it('honors an explicit validFrom that backdates a fact ahead of its creation', async () => {
      const backdated = await memory.remember('The contract renewed on schedule', {
        validFrom: Date.now() - 10_000,
      });

      const beforeBackdate = await memory.recall('contract renewed', {
        vectorOnly: true,
        threshold: 0,
        asOf: Date.now() - 20_000,
      });
      const afterBackdate = await memory.recall('contract renewed', {
        vectorOnly: true,
        threshold: 0,
        asOf: Date.now(),
      });

      expect(beforeBackdate.map((r) => r.id)).not.toContain(backdated.id);
      expect(afterBackdate.map((r) => r.id)).toContain(backdated.id);
    });
  });
});
