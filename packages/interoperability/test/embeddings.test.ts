import { describe, expect, test } from 'bun:test';

import {
  computeEmbeddingVectorMagnitude,
  cosineSimilarity,
  isEmbeddingVector,
} from '../src/embeddings';

// ── isEmbeddingVector ──────────────────────────────────────────────

describe('isEmbeddingVector', () => {
  test('accepts a number[] of finite values', () => {
    expect(isEmbeddingVector([1, 2, 3])).toBe(true);
  });

  test('accepts a Float32Array (regression: the predicate must not reject the persisted type)', () => {
    const vector = Float32Array.from([0.1, 0.2, 0.3]);
    expect(isEmbeddingVector(vector)).toBe(true);
  });

  test('rejects an empty vector by default', () => {
    expect(isEmbeddingVector([])).toBe(false);
  });

  test('accepts an empty vector when allowEmpty is set', () => {
    expect(isEmbeddingVector([], { allowEmpty: true })).toBe(true);
    expect(isEmbeddingVector(Float32Array.from([]), { allowEmpty: true })).toBe(true);
  });

  test('rejects a vector whose length differs from the required dimension', () => {
    expect(isEmbeddingVector([1, 2, 3], { dimension: 4 })).toBe(false);
  });

  test('accepts a vector whose length matches the required dimension', () => {
    expect(isEmbeddingVector([1, 2, 3], { dimension: 3 })).toBe(true);
    expect(isEmbeddingVector(Float32Array.from([1, 2, 3]), { dimension: 3 })).toBe(true);
  });

  test('rejects a vector containing NaN', () => {
    expect(isEmbeddingVector([1, Number.NaN, 3])).toBe(false);
  });

  test('rejects a vector containing Infinity', () => {
    expect(isEmbeddingVector([1, Number.POSITIVE_INFINITY, 3])).toBe(false);
    expect(isEmbeddingVector([1, Number.NEGATIVE_INFINITY, 3])).toBe(false);
  });

  test('rejects a vector containing a non-number entry', () => {
    expect(isEmbeddingVector([1, '2', 3])).toBe(false);
  });

  test('rejects values that are not array-like', () => {
    expect(isEmbeddingVector(null)).toBe(false);
    expect(isEmbeddingVector(undefined)).toBe(false);
    expect(isEmbeddingVector(42)).toBe(false);
    expect(isEmbeddingVector('not a vector')).toBe(false);
    expect(isEmbeddingVector({})).toBe(false);
  });

  test('rejects a plain object masquerading as array-like (would otherwise be an unbounded probe)', () => {
    // Only genuine arrays / typed arrays qualify — a hostile `{ length: huge }`
    // must be rejected up front, never index-probed.
    expect(isEmbeddingVector({ length: 3 })).toBe(false);
    expect(isEmbeddingVector({ length: -1 })).toBe(false);
    expect(isEmbeddingVector({ length: 1.5 })).toBe(false);
    expect(isEmbeddingVector({ length: 1e9, 0: 1 })).toBe(false);
  });

  test('accepts numeric typed arrays beyond Float32Array', () => {
    expect(isEmbeddingVector(Float64Array.from([1, 2, 3]))).toBe(true);
    expect(isEmbeddingVector(Int32Array.from([1, 2, 3]))).toBe(true);
    expect(isEmbeddingVector(Uint8Array.from([1, 2, 3]))).toBe(true);
  });

  test('rejects a DataView (array-like-adjacent but not a numeric-indexed view)', () => {
    expect(isEmbeddingVector(new DataView(new ArrayBuffer(8)))).toBe(false);
  });
});

// ── computeEmbeddingVectorMagnitude ────────────────────────────────

describe('computeEmbeddingVectorMagnitude', () => {
  test('computes the Euclidean norm of a known vector', () => {
    // sqrt(3^2 + 4^2) = 5
    expect(computeEmbeddingVectorMagnitude([3, 4])).toBe(5);
  });

  test('computes the magnitude of a unit vector as 1', () => {
    expect(computeEmbeddingVectorMagnitude([1, 0, 0])).toBe(1);
  });

  test('returns 0 for a zero vector', () => {
    expect(computeEmbeddingVectorMagnitude([0, 0, 0])).toBe(0);
  });

  test('returns 0 for an empty vector', () => {
    expect(computeEmbeddingVectorMagnitude([])).toBe(0);
  });

  test('operates on a Float32Array', () => {
    expect(computeEmbeddingVectorMagnitude(Float32Array.from([3, 4]))).toBeCloseTo(5, 5);
  });
});

// ── cosineSimilarity ───────────────────────────────────────────────

describe('cosineSimilarity', () => {
  test('returns 1 for identical vectors', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 10);
  });

  test('returns 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 10);
  });

  test('returns -1 for opposite vectors', () => {
    expect(cosineSimilarity([1, 2, 3], [-1, -2, -3])).toBeCloseTo(-1, 10);
  });

  test('returns 0 when the left vector has zero magnitude', () => {
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
  });

  test('returns 0 when the right vector has zero magnitude', () => {
    expect(cosineSimilarity([1, 2, 3], [0, 0, 0])).toBe(0);
  });

  test('returns 0 for two empty vectors', () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });

  test('operates on Float32Array inputs', () => {
    const left = Float32Array.from([1, 2, 3]);
    const right = Float32Array.from([1, 2, 3]);
    expect(cosineSimilarity(left, right)).toBeCloseTo(1, 5);
  });

  test('throws a RangeError on dimension mismatch', () => {
    expect(() => cosineSimilarity([1, 2, 3], [1, 2])).toThrow(RangeError);
  });

  test('throws a TypeError when the left vector contains a non-finite entry', () => {
    expect(() => cosineSimilarity([1, Number.NaN, 3], [1, 2, 3])).toThrow(TypeError);
    expect(() => cosineSimilarity([1, Number.POSITIVE_INFINITY, 3], [1, 2, 3])).toThrow(TypeError);
  });

  test('throws a TypeError when the right vector contains a non-finite entry', () => {
    expect(() => cosineSimilarity([1, 2, 3], [1, Number.NaN, 3])).toThrow(TypeError);
    expect(() => cosineSimilarity([1, 2, 3], [1, Number.NEGATIVE_INFINITY, 3])).toThrow(TypeError);
  });
});
