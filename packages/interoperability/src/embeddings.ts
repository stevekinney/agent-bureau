export type EmbeddingVector = number[];
export type Embedder = (texts: string[]) => EmbeddingVector[] | Promise<EmbeddingVector[]>;

/**
 * A read-only, index-addressable sequence of numbers.
 *
 * Unlike {@link EmbeddingVector} (a mutable `number[]`), this widens to any
 * `ArrayLike<number>` so it also describes the `Float32Array` that the system
 * persists. Use this type wherever a function only needs to *read* a vector.
 */
export type EmbeddingVectorLike = ArrayLike<number>;

/** Options for {@link isEmbeddingVector}. */
export type IsEmbeddingVectorOptions = {
  /** When set, the vector's length must equal this exact dimension. */
  dimension?: number;
  /** When `true`, a zero-length vector is considered valid. Defaults to `false`. */
  allowEmpty?: boolean;
};

/**
 * Type guard that narrows an unknown value to {@link EmbeddingVectorLike}.
 *
 * A value qualifies when it is array-like (a non-negative integer `length`
 * with a finite `number` at every index). By design this accepts both
 * `number[]` and `Float32Array`, since the system persists vectors as
 * `Float32Array`.
 *
 * @param value - The value to test.
 * @param options - Optional `dimension` (required exact length) and
 *   `allowEmpty` (permit a zero-length vector). An empty vector is rejected
 *   unless `allowEmpty` is `true`.
 */
export function isEmbeddingVector(
  value: unknown,
  options?: IsEmbeddingVectorOptions,
): value is EmbeddingVectorLike {
  if (value === null || typeof value !== 'object') {
    return false;
  }

  const record = value as Record<PropertyKey, unknown>;
  const length = record['length'];
  if (typeof length !== 'number' || !Number.isInteger(length) || length < 0) {
    return false;
  }

  const dimension = options?.dimension;
  if (dimension !== undefined && length !== dimension) {
    return false;
  }

  if (length === 0) {
    return options?.allowEmpty === true;
  }

  for (let index = 0; index < length; index++) {
    const entry = record[index];
    if (typeof entry !== 'number' || !Number.isFinite(entry)) {
      return false;
    }
  }

  return true;
}

/**
 * Computes the Euclidean magnitude (L2 norm) of a vector.
 *
 * Returns `0` for an empty vector. Assumes the entries are finite numbers;
 * pair with {@link isEmbeddingVector} at boundaries if the input is untrusted.
 *
 * @param vector - The vector to measure.
 */
export function computeEmbeddingVectorMagnitude(vector: EmbeddingVectorLike): number {
  let sumOfSquares = 0;
  for (let index = 0; index < vector.length; index++) {
    const entry = vector[index] ?? 0;
    sumOfSquares += entry * entry;
  }
  return Math.sqrt(sumOfSquares);
}

function assertAllFinite(vector: EmbeddingVectorLike): void {
  for (let index = 0; index < vector.length; index++) {
    const entry = vector[index];
    if (entry === undefined || !Number.isFinite(entry)) {
      throw new TypeError(
        `Embedding vector contains a non-finite entry at index ${index}: ${String(entry)}`,
      );
    }
  }
}

/**
 * Computes the cosine similarity between two vectors.
 *
 * The result lies in `[-1, 1]`: `1` for identical direction, `0` for
 * orthogonal, `-1` for opposite. An empty or zero-magnitude vector yields `0`.
 *
 * @param left - The first vector.
 * @param right - The second vector.
 * @throws {RangeError} When the vectors have different lengths.
 * @throws {TypeError} When either vector contains a non-finite entry
 *   (`NaN` or `Infinity`).
 */
export function cosineSimilarity(left: EmbeddingVectorLike, right: EmbeddingVectorLike): number {
  if (left.length !== right.length) {
    throw new RangeError(
      `Cosine similarity requires equal-length vectors; received ${left.length} and ${right.length}.`,
    );
  }

  assertAllFinite(left);
  assertAllFinite(right);

  const leftMagnitude = computeEmbeddingVectorMagnitude(left);
  const rightMagnitude = computeEmbeddingVectorMagnitude(right);
  if (leftMagnitude === 0 || rightMagnitude === 0) {
    return 0;
  }

  let dotProduct = 0;
  for (let index = 0; index < left.length; index++) {
    const leftEntry = left[index] ?? 0;
    const rightEntry = right[index] ?? 0;
    dotProduct += leftEntry * rightEntry;
  }

  return dotProduct / (leftMagnitude * rightMagnitude);
}
