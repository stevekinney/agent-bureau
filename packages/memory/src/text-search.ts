export interface BM25Options {
  /** Term frequency saturation parameter. Default: 1.2 */
  k1?: number;
  /** Length normalization parameter. Default: 0.75 */
  b?: number;
}

/**
 * Tokenizes text into lowercase terms with punctuation removed.
 */
export function tokenize(text: string): string[] {
  if (!text.trim()) return [];

  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .split(/\s+/)
    .filter((token) => token.length > 0);
}

/**
 * Computes BM25 scores for a query against a corpus of documents.
 *
 * BM25 formula per term:
 *   IDF(t) * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * dl / avgdl))
 *
 * Where:
 *   IDF(t) = ln((N - df + 0.5) / (df + 0.5) + 1)
 *   tf = term frequency in document
 *   dl = document length (in tokens)
 *   avgdl = average document length across corpus
 *   N = total number of documents
 *   df = number of documents containing the term
 */
export function computeBM25Scores(
  query: string,
  documents: string[],
  options?: BM25Options,
): Map<number, number> {
  const scores = new Map<number, number>();

  if (documents.length === 0) return scores;

  const k1 = options?.k1 ?? 1.2;
  const b = options?.b ?? 0.75;

  const queryTerms = tokenize(query);
  const tokenizedDocuments = documents.map(tokenize);
  const numberOfDocuments = documents.length;

  // Compute average document length
  const totalLength = tokenizedDocuments.reduce((sum, tokens) => sum + tokens.length, 0);
  const averageDocumentLength = totalLength / numberOfDocuments;

  // Build document frequency for each query term
  const documentFrequency = new Map<string, number>();
  for (const term of queryTerms) {
    if (documentFrequency.has(term)) continue;
    let count = 0;
    for (const tokens of tokenizedDocuments) {
      if (tokens.includes(term)) count++;
    }
    documentFrequency.set(term, count);
  }

  // Score each document
  for (let documentIndex = 0; documentIndex < numberOfDocuments; documentIndex++) {
    const tokens = tokenizedDocuments[documentIndex]!;
    const documentLength = tokens.length;
    let score = 0;

    for (const term of queryTerms) {
      const df = documentFrequency.get(term) ?? 0;
      const termFrequency = tokens.filter((t) => t === term).length;

      if (termFrequency === 0) continue;

      // IDF with smoothing
      const idf = Math.log((numberOfDocuments - df + 0.5) / (df + 0.5) + 1);

      // BM25 term score
      const numerator = termFrequency * (k1 + 1);
      const denominator =
        termFrequency + k1 * (1 - b + b * (documentLength / averageDocumentLength));
      score += idf * (numerator / denominator);
    }

    scores.set(documentIndex, score);
  }

  return scores;
}
