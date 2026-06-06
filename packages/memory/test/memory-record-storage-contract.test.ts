import { MemoryStorage } from '@lostgradient/weft/storage';
import { beforeEach, describe, expect, it } from 'bun:test';

import { createWeftMemoryRecordStorage } from '../src/create-weft-memory-record-storage';
import { createInMemoryMemoryRecordStorage } from '../src/test/index';
import type { MemoryRecord, MemoryRecordScope, MemoryRecordStorage } from '../src/types';

/**
 * The single shared {@link MemoryRecordStorage} contract suite. It is invoked
 * once per backend (the in-memory test helper and the Weft-backed local
 * backend) so both clear byte-identical assertions. Backend-specific concerns
 * (key-prefix isolation, physical-removal proof, shared-storage disposal) live
 * in `create-weft-memory-record-storage.test.ts`, not here.
 */

const SCOPE: MemoryRecordScope = { namespace: 'alpha' };

function makeRecord(id: string, overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  const now = Date.now();
  return {
    id,
    namespace: 'alpha',
    content: `content-${id}`,
    vector: new Float32Array([1, 0]),
    metadata: {},
    createdAt: now,
    updatedAt: now,
    version: 1,
    status: 'active',
    ...overrides,
  };
}

interface Backend {
  label: string;
  create: () => MemoryRecordStorage;
}

const BACKENDS: Backend[] = [
  { label: 'in-memory', create: () => createInMemoryMemoryRecordStorage() },
  { label: 'weft', create: () => createWeftMemoryRecordStorage(new MemoryStorage()) },
];

for (const backend of BACKENDS) {
  describe(`MemoryRecordStorage contract (${backend.label})`, () => {
    let storage: MemoryRecordStorage;

    beforeEach(async () => {
      storage = backend.create();
      await storage.init();
    });

    describe('put / get', () => {
      it('stores and retrieves a record within its scope', async () => {
        await storage.put(makeRecord('a'));
        const fetched = await storage.get('a', SCOPE);
        expect(fetched?.id).toBe('a');
        expect(fetched?.content).toBe('content-a');
        expect(fetched?.vector).toBeInstanceOf(Float32Array);
        expect(Array.from(fetched!.vector)).toEqual([1, 0]);
        expect(fetched?.status).toBe('active');
        expect(fetched?.version).toBe(1);
      });

      it('returns undefined for an unknown id', async () => {
        expect(await storage.get('missing', SCOPE)).toBeUndefined();
      });

      it('isolates records by namespace', async () => {
        await storage.put(makeRecord('a', { namespace: 'alpha' }));
        await storage.put(makeRecord('b', { namespace: 'beta' }));

        expect(await storage.get('a', { namespace: 'alpha' })).toBeDefined();
        expect(await storage.get('a', { namespace: 'beta' })).toBeUndefined();
        expect(await storage.count({ namespace: 'alpha' })).toBe(1);
        expect(await storage.count({ namespace: 'beta' })).toBe(1);
      });

      it('isolates records by tenant', async () => {
        await storage.put(makeRecord('a', { tenantId: 't1' }));
        await storage.put(makeRecord('a', { tenantId: 't2' }));

        const t1 = await storage.get('a', { tenantId: 't1', namespace: 'alpha' });
        const t2 = await storage.get('a', { tenantId: 't2', namespace: 'alpha' });
        expect(t1?.tenantId).toBe('t1');
        expect(t2?.tenantId).toBe('t2');
      });
    });

    describe('getMany', () => {
      it('returns only the present records, omitting missing ids', async () => {
        await storage.put(makeRecord('a'));
        await storage.put(makeRecord('b'));

        const records = await storage.getMany(['a', 'missing', 'b'], SCOPE);
        expect(records.map((r) => r.id).sort()).toEqual(['a', 'b']);
      });
    });

    describe('list', () => {
      it('returns records newest-first', async () => {
        await storage.put(makeRecord('old', { createdAt: 1000 }));
        await storage.put(makeRecord('new', { createdAt: 2000 }));

        const records = await storage.list(SCOPE);
        expect(records.map((r) => r.id)).toEqual(['new', 'old']);
      });

      it('honors limit and offset', async () => {
        await storage.put(makeRecord('a', { createdAt: 3000 }));
        await storage.put(makeRecord('b', { createdAt: 2000 }));
        await storage.put(makeRecord('c', { createdAt: 1000 }));

        const page = await storage.list(SCOPE, { limit: 1, offset: 1 });
        expect(page.map((r) => r.id)).toEqual(['b']);
      });
    });

    describe('count', () => {
      it('counts records in the scope', async () => {
        await storage.put(makeRecord('a'));
        await storage.put(makeRecord('b'));
        expect(await storage.count(SCOPE)).toBe(2);
      });
    });

    describe('update', () => {
      it('patches fields and bumps the version', async () => {
        await storage.put(makeRecord('a'));
        const updated = await storage.update('a', SCOPE, { content: 'patched' });

        expect(updated?.content).toBe('patched');
        expect(updated?.version).toBe(2);

        const reread = await storage.get('a', SCOPE);
        expect(reread?.content).toBe('patched');
        expect(reread?.version).toBe(2);
      });

      it('returns undefined when no record matches', async () => {
        expect(await storage.update('missing', SCOPE, { content: 'x' })).toBeUndefined();
      });
    });

    describe('searchByVector', () => {
      it('ranks by cosine similarity, descending', async () => {
        await storage.put(makeRecord('exact', { vector: new Float32Array([1, 0]) }));
        await storage.put(makeRecord('ortho', { vector: new Float32Array([0, 1]) }));

        const hits = await storage.searchByVector([1, 0], SCOPE, { limit: 10 });
        expect(hits[0]!.id).toBe('exact');
        expect(hits[0]!.score).toBeCloseTo(1, 5);
        expect(hits[1]!.id).toBe('ortho');
      });

      it('applies the threshold filter', async () => {
        await storage.put(makeRecord('exact', { vector: new Float32Array([1, 0]) }));
        await storage.put(makeRecord('ortho', { vector: new Float32Array([0, 1]) }));

        const hits = await storage.searchByVector([1, 0], SCOPE, { limit: 10, threshold: 0.5 });
        expect(hits).toHaveLength(1);
        expect(hits[0]!.id).toBe('exact');
      });

      it('retains negative-similarity records when no threshold is given', async () => {
        await storage.put(makeRecord('pos', { vector: new Float32Array([1, 0]) }));
        await storage.put(makeRecord('neg', { vector: new Float32Array([-1, 0]) }));

        const hits = await storage.searchByVector([1, 0], SCOPE, { limit: 10 });
        expect(hits).toHaveLength(2);
      });

      describe('deterministic exact-search fixture', () => {
        // Vectors chosen so cosine similarity against the query [1, 0] is exact:
        //   [1, 0] -> 1, [0, 1] -> 0, [-1, 0] -> -1, [0, 0] -> 0 (zero vector).
        // [0, 1] and [0, 0] tie at 0, so assertions key on id, never on the
        // positional order of the two zero-score hits.
        beforeEach(async () => {
          await storage.put(makeRecord('parallel', { vector: new Float32Array([1, 0]) }));
          await storage.put(makeRecord('orthogonal', { vector: new Float32Array([0, 1]) }));
          await storage.put(makeRecord('opposite', { vector: new Float32Array([-1, 0]) }));
          await storage.put(makeRecord('zero', { vector: new Float32Array([0, 0]) }));
        });

        it('scores each record by exact cosine similarity', async () => {
          const hits = await storage.searchByVector([1, 0], SCOPE, { limit: 10 });
          const scoreById = new Map(hits.map((hit) => [hit.id, hit.score]));

          expect(scoreById.get('parallel')).toBeCloseTo(1, 5);
          expect(scoreById.get('orthogonal')).toBeCloseTo(0, 5);
          expect(scoreById.get('opposite')).toBeCloseTo(-1, 5);
          expect(scoreById.get('zero')).toBeCloseTo(0, 5);
        });

        it('orders the parallel hit first and the opposite hit last', async () => {
          const hits = await storage.searchByVector([1, 0], SCOPE, { limit: 10 });
          expect(hits).toHaveLength(4);
          expect(hits[0]!.id).toBe('parallel');
          expect(hits[3]!.id).toBe('opposite');
          // Scores are sorted descending regardless of how the two zero-score
          // ties are ordered between them.
          const scores = hits.map((hit) => hit.score);
          const descending = [...scores].sort((a, b) => b - a);
          expect(scores).toEqual(descending);
        });

        it('drops sub-threshold and negative hits under a positive threshold', async () => {
          const hits = await storage.searchByVector([1, 0], SCOPE, { limit: 10, threshold: 0.5 });
          expect(hits.map((hit) => hit.id)).toEqual(['parallel']);
        });
      });
    });

    describe('delete invariant (shared across backends)', () => {
      it('returns true when it removed a record, false when absent', async () => {
        await storage.put(makeRecord('a'));
        expect(await storage.delete('a', SCOPE)).toBe(true);
        expect(await storage.delete('a', SCOPE)).toBe(false);
        expect(await storage.delete('never-existed', SCOPE)).toBe(false);
      });

      it('makes a deleted record vanish from every read', async () => {
        await storage.put(makeRecord('a', { vector: new Float32Array([1, 0]) }));
        await storage.put(makeRecord('b', { vector: new Float32Array([1, 0]) }));

        expect(await storage.delete('a', SCOPE)).toBe(true);

        expect(await storage.get('a', SCOPE)).toBeUndefined();
        const fetched = await storage.getMany(['a', 'b'], SCOPE);
        expect(fetched.map((r) => r.id)).toEqual(['b']);
        const listed = await storage.list(SCOPE);
        expect(listed.map((r) => r.id)).toEqual(['b']);
        expect(await storage.count(SCOPE)).toBe(1);
        const hits = await storage.searchByVector([1, 0], SCOPE, { limit: 10 });
        expect(hits.map((hit) => hit.id)).toEqual(['b']);
      });

      it('cannot be updated after deletion', async () => {
        await storage.put(makeRecord('a'));
        await storage.delete('a', SCOPE);
        expect(await storage.update('a', SCOPE, { content: 'zombie' })).toBeUndefined();
      });

      it('treats a directly put() non-active record as invisible to every read', async () => {
        // The contract permits passing any MemoryRecord to put(); a record whose
        // status is already 'deleted' must never surface from a read, and count()
        // must agree with get/list/search. This pins both backends to the SAME
        // answer on this input so neither can silently diverge — count() in
        // particular must not fall back to a raw key-count that ignores status.
        await storage.put(makeRecord('ghost', { status: 'deleted' }));
        await storage.put(makeRecord('live', { status: 'active' }));

        expect(await storage.get('ghost', SCOPE)).toBeUndefined();
        const fetched = await storage.getMany(['ghost', 'live'], SCOPE);
        expect(fetched.map((r) => r.id)).toEqual(['live']);
        const listed = await storage.list(SCOPE);
        expect(listed.map((r) => r.id)).toEqual(['live']);
        expect(await storage.count(SCOPE)).toBe(1);
        const hits = await storage.searchByVector([1, 0], SCOPE, { limit: 10 });
        expect(hits.map((hit) => hit.id)).toEqual(['live']);
      });
    });

    describe('deleteNamespace', () => {
      it('clears only the targeted scope and returns the count removed', async () => {
        await storage.put(makeRecord('a', { namespace: 'alpha' }));
        await storage.put(makeRecord('b', { namespace: 'alpha' }));
        await storage.put(makeRecord('c', { namespace: 'beta' }));

        const removed = await storage.deleteNamespace({ namespace: 'alpha' });
        expect(removed).toBe(2);

        expect(await storage.count({ namespace: 'alpha' })).toBe(0);
        expect(await storage.list({ namespace: 'alpha' })).toEqual([]);
        expect(await storage.count({ namespace: 'beta' })).toBe(1);
      });

      it('returns 0 when the scope is already empty', async () => {
        expect(await storage.deleteNamespace({ namespace: 'empty' })).toBe(0);
      });
    });
  });
}
