import { describe, expect, it } from 'bun:test';

import { applyMaximalMarginalRelevance, cosineSimilarity } from '../src/maximal-marginal-relevance';

describe('cosineSimilarity', () => {
  it('returns 1 for identical unit vectors', () => {
    const vector = [1 / Math.sqrt(3), 1 / Math.sqrt(3), 1 / Math.sqrt(3)];
    expect(cosineSimilarity(vector, vector)).toBeCloseTo(1, 10);
  });

  it('returns 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBeCloseTo(0, 10);
  });

  it('returns -1 for opposite vectors', () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 10);
  });

  it('returns 0 for zero vectors', () => {
    expect(cosineSimilarity([0, 0], [0, 0])).toBe(0);
  });
});

describe('applyMaximalMarginalRelevance', () => {
  it('with lambda=1, returns items in pure relevance order (by score)', () => {
    const results = [
      { score: 0.9, vector: [1, 0, 0] },
      { score: 0.7, vector: [0, 1, 0] },
      { score: 0.5, vector: [0, 0, 1] },
    ];

    const selected = applyMaximalMarginalRelevance(results, 3, { lambda: 1 });

    expect(selected.map((r) => r.score)).toEqual([0.9, 0.7, 0.5]);
  });

  it('with lambda=0, selects for maximum diversity', () => {
    // Two items are very similar (both close to [1,0]), one is different ([0,1])
    const results = [
      { score: 0.9, vector: [1, 0] },
      { score: 0.85, vector: [0.99, 0.14] }, // very similar to first
      { score: 0.5, vector: [0, 1] }, // very different
    ];

    const selected = applyMaximalMarginalRelevance(results, 2, { lambda: 0 });

    // First pick has no prior selections so diversity doesn't apply yet — picks highest score
    // Second pick should prefer the diverse one ([0,1]) over the similar one
    expect(selected[1]!.score).toBe(0.5);
  });

  it('with lambda=0.7, balances relevance and diversity', () => {
    const results = [
      { score: 0.9, vector: [1, 0] },
      { score: 0.85, vector: [0.99, 0.14] },
      { score: 0.5, vector: [0, 1] },
    ];

    const selected = applyMaximalMarginalRelevance(results, 3, { lambda: 0.7 });

    // Should return all 3 items
    expect(selected).toHaveLength(3);
    // First item should still be highest relevance
    expect(selected[0]!.score).toBe(0.9);
  });

  it('falls back to score-only ordering when results lack vectors', () => {
    const results = [{ score: 0.5 }, { score: 0.9 }, { score: 0.7 }];

    const selected = applyMaximalMarginalRelevance(results, 3, { lambda: 0.5 });

    expect(selected.map((r) => r.score)).toEqual([0.9, 0.7, 0.5]);
  });

  it('returns all results when limit exceeds result count', () => {
    const results = [
      { score: 0.9, vector: [1, 0] },
      { score: 0.5, vector: [0, 1] },
    ];

    const selected = applyMaximalMarginalRelevance(results, 10, { lambda: 0.5 });

    expect(selected).toHaveLength(2);
  });

  it('returns empty array for empty results', () => {
    const selected = applyMaximalMarginalRelevance([], 5, { lambda: 0.5 });
    expect(selected).toEqual([]);
  });
});
