/**
 * Deterministic hash-based embedder for testing.
 * Same text always produces the same vector. Different texts produce different vectors.
 */
export function createMockEmbedder(dimension: number = 128): (texts: string[]) => number[][] {
  return (texts: string[]): number[][] => {
    return texts.map((text) => textToVector(text, dimension));
  };
}

function textToVector(text: string, dimension: number): number[] {
  const vector = new Array<number>(dimension);

  // Simple deterministic hash seeding
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0;
  }

  // Generate deterministic pseudo-random values from the hash
  for (let i = 0; i < dimension; i++) {
    hash = ((hash << 13) ^ hash) | 0;
    hash = (hash * 1597 + 51749) | 0;
    vector[i] = (hash & 0x7fffffff) / 0x7fffffff;
  }

  // Normalize to unit vector
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (magnitude > 0) {
    for (let i = 0; i < dimension; i++) {
      vector[i] = vector[i]! / magnitude;
    }
  }

  return vector;
}
