import { describe, expect, it } from 'bun:test';

import type { HybridSearchCandidate, VectorSearchResult } from '../src/hybrid-search';
import { mergeHybridResults } from '../src/hybrid-search';

function makeCandidate(id: string, content: string): HybridSearchCandidate {
  return {
    id,
    content,
    metadata: {},
    createdAt: Date.now(),
  };
}

describe('mergeHybridResults', () => {
  it('uses default weights (0.7 vector + 0.3 text)', () => {
    const candidates: HybridSearchCandidate[] = [makeCandidate('a', 'hello world')];
    const vectorResults: VectorSearchResult[] = [{ id: 'a', score: 1.0 }];
    const textScores = new Map<number, number>([[0, 1.0]]);

    const results = mergeHybridResults(vectorResults, textScores, candidates);

    expect(results[0]!.combinedScore).toBeCloseTo(0.7 * 1.0 + 0.3 * 1.0, 10);
    expect(results[0]!.vectorScore).toBe(1.0);
    expect(results[0]!.textScore).toBe(1.0);
  });

  it('applies custom weights', () => {
    const candidates: HybridSearchCandidate[] = [makeCandidate('a', 'hello')];
    const vectorResults: VectorSearchResult[] = [{ id: 'a', score: 0.8 }];
    const textScores = new Map<number, number>([[0, 0.6]]);

    const results = mergeHybridResults(vectorResults, textScores, candidates, {
      vectorWeight: 0.5,
      textWeight: 0.5,
    });

    expect(results[0]!.combinedScore).toBeCloseTo(0.5 * 0.8 + 0.5 * 0.6, 10);
  });

  it('handles vector-only results (no text matches)', () => {
    const candidates: HybridSearchCandidate[] = [makeCandidate('a', 'hello')];
    const vectorResults: VectorSearchResult[] = [{ id: 'a', score: 0.9 }];
    const textScores = new Map<number, number>();

    const results = mergeHybridResults(vectorResults, textScores, candidates);

    expect(results[0]!.combinedScore).toBeCloseTo(0.7 * 0.9, 10);
    expect(results[0]!.textScore).toBe(0);
  });

  it('handles text-only results (no vector matches)', () => {
    const candidates: HybridSearchCandidate[] = [makeCandidate('a', 'hello')];
    const vectorResults: VectorSearchResult[] = [];
    const textScores = new Map<number, number>([[0, 0.8]]);

    const results = mergeHybridResults(vectorResults, textScores, candidates);

    expect(results[0]!.combinedScore).toBeCloseTo(0.3 * 0.8, 10);
    expect(results[0]!.vectorScore).toBe(0);
  });

  it('combines scores when both sources match the same document', () => {
    const candidates: HybridSearchCandidate[] = [
      makeCandidate('a', 'hello'),
      makeCandidate('b', 'world'),
    ];
    const vectorResults: VectorSearchResult[] = [
      { id: 'a', score: 0.9 },
      { id: 'b', score: 0.4 },
    ];
    const textScores = new Map<number, number>([
      [0, 0.5],
      [1, 0.8],
    ]);

    const results = mergeHybridResults(vectorResults, textScores, candidates);

    expect(results).toHaveLength(2);
    // Both should have combined scores
    const resultA = results.find((r) => r.id === 'a')!;
    const resultB = results.find((r) => r.id === 'b')!;
    expect(resultA.combinedScore).toBeCloseTo(0.7 * 0.9 + 0.3 * 0.5, 10);
    expect(resultB.combinedScore).toBeCloseTo(0.7 * 0.4 + 0.3 * 0.8, 10);
  });

  it('filters results below threshold', () => {
    const candidates: HybridSearchCandidate[] = [
      makeCandidate('a', 'hello'),
      makeCandidate('b', 'world'),
    ];
    const vectorResults: VectorSearchResult[] = [
      { id: 'a', score: 0.9 },
      { id: 'b', score: 0.1 },
    ];
    const textScores = new Map<number, number>();

    const results = mergeHybridResults(vectorResults, textScores, candidates, {
      threshold: 0.5,
    });

    // Only 'a' should pass: 0.7 * 0.9 = 0.63 > 0.5
    // 'b' fails: 0.7 * 0.1 = 0.07 < 0.5
    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe('a');
  });

  it('respects limit', () => {
    const candidates: HybridSearchCandidate[] = [
      makeCandidate('a', 'hello'),
      makeCandidate('b', 'world'),
      makeCandidate('c', 'foo'),
    ];
    const vectorResults: VectorSearchResult[] = [
      { id: 'a', score: 0.9 },
      { id: 'b', score: 0.7 },
      { id: 'c', score: 0.5 },
    ];
    const textScores = new Map<number, number>();

    const results = mergeHybridResults(vectorResults, textScores, candidates, { limit: 2 });

    expect(results).toHaveLength(2);
  });

  it('returns empty array for empty inputs', () => {
    expect(mergeHybridResults([], new Map(), [])).toEqual([]);
  });

  it('sorts results by combinedScore descending', () => {
    const candidates: HybridSearchCandidate[] = [
      makeCandidate('a', 'hello'),
      makeCandidate('b', 'world'),
      makeCandidate('c', 'foo'),
    ];
    const vectorResults: VectorSearchResult[] = [
      { id: 'a', score: 0.3 },
      { id: 'b', score: 0.9 },
      { id: 'c', score: 0.6 },
    ];
    const textScores = new Map<number, number>();

    const results = mergeHybridResults(vectorResults, textScores, candidates);

    expect(results[0]!.id).toBe('b');
    expect(results[1]!.id).toBe('c');
    expect(results[2]!.id).toBe('a');
  });
});
