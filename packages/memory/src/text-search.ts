export interface BM25Options {
  /** Term frequency saturation parameter. Default: 1.2 */
  k1?: number;
  /** Length normalization parameter. Default: 0.75 */
  b?: number;
  /**
   * Pre-tokenized query terms. When provided, `tokenize()` is skipped for
   * the query string, avoiding double expansion of CJK unigrams/bigrams
   * when the caller has already performed keyword extraction.
   */
  queryTerms?: string[];
}

function appendJapaneseTokens(word: string, tokens: string[]): void {
  const parts =
    word.match(/[a-z0-9_]+|[\u30a0-\u30ffー]+|[\u4e00-\u9fff]+|[\u3040-\u309f]{2,}/g) ?? [];
  for (const part of parts) {
    if (/^[\u4e00-\u9fff]+$/.test(part)) expandCJKUnigrams(part, tokens);
    else tokens.push(part);
  }
}

function appendMixedCjkTokens(word: string, tokens: string[]): void {
  let cjkRun = '';
  let latinRun = '';
  const flush = (): void => {
    if (latinRun) {
      tokens.push(latinRun);
      latinRun = '';
    }
    if (cjkRun) {
      expandCJKUnigrams(cjkRun, tokens);
      cjkRun = '';
    }
  };
  for (const character of Array.from(word)) {
    if (/[\u4e00-\u9fff]/.test(character)) {
      if (latinRun) {
        tokens.push(latinRun);
        latinRun = '';
      }
      cjkRun += character;
    } else if (/[a-z0-9_]/.test(character)) {
      if (cjkRun) {
        expandCJKUnigrams(cjkRun, tokens);
        cjkRun = '';
      }
      latinRun += character;
    } else flush();
  }
  flush();
}

function termFrequencies(tokens: string[]): Map<string, number> {
  const frequencies = new Map<string, number>();
  for (const token of tokens) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
  return frequencies;
}

function documentFrequencies(terms: string[], sets: Set<string>[]): Map<string, number> {
  const frequencies = new Map<string, number>();
  for (const term of terms) {
    if (frequencies.has(term)) continue;
    frequencies.set(
      term,
      sets.reduce((count, set) => count + (set.has(term) ? 1 : 0), 0),
    );
  }
  return frequencies;
}

function scoreDocument(
  frequencies: Map<string, number>,
  length: number,
  queryTerms: string[],
  documentFrequency: Map<string, number>,
  documentCount: number,
  averageLength: number,
  k1: number,
  b: number,
): number {
  let score = 0;
  for (const term of queryTerms) {
    const termFrequency = frequencies.get(term) ?? 0;
    if (termFrequency === 0) continue;
    const df = documentFrequency.get(term) ?? 0;
    const idf = Math.log((documentCount - df + 0.5) / (df + 0.5) + 1);
    const numerator = termFrequency * (k1 + 1);
    const denominator = termFrequency + k1 * (1 - b + b * (length / averageLength));
    score += idf * (numerator / denominator);
  }
  return score;
}

/**
 * Tokenizes text into lowercase terms with punctuation removed.
 *
 * CJK ideographs (U+4E00–U+9FFF) are split into character unigrams and
 * overlapping bigrams so that queries expanded by `extractKeywords` match
 * documents that contain continuous CJK runs (e.g., "数据库连接" →
 * ["数", "据", "库", "连", "接", "数据", "据库", "库连", "连接"]).
 *
 * Japanese text that mixes kana and kanji is handled the same way: kanji
 * sub-runs are split into unigrams + bigrams while katakana and hiragana
 * chunks are kept as-is.
 */
export function tokenize(text: string): string[] {
  if (!text.trim()) return [];

  const cleaned = text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '');
  const words = cleaned.split(/\s+/).filter((w) => w.length > 0);
  const tokens: string[] = [];

  for (const word of words) {
    if (/[\u3040-\u30ff]/.test(word)) appendJapaneseTokens(word, tokens);
    else if (/[\u4e00-\u9fff]/.test(word)) appendMixedCjkTokens(word, tokens);
    else tokens.push(word);
  }

  return tokens;
}

/**
 * Pushes character unigrams and overlapping bigrams for a CJK run.
 */
export function expandCJKUnigrams(run: string, tokens: string[]): void {
  for (let i = 0; i < run.length; i++) {
    tokens.push(run[i]!);
  }
  for (let i = 0; i < run.length - 1; i++) {
    tokens.push(run[i]! + run[i + 1]!);
  }
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

  const queryTerms = options?.queryTerms ?? tokenize(query);
  const tokenizedDocuments = documents.map(tokenize);
  const numberOfDocuments = documents.length;

  // Compute average document length
  const totalLength = tokenizedDocuments.reduce((sum, tokens) => sum + tokens.length, 0);
  const averageDocumentLength = totalLength / numberOfDocuments;

  // Precompute per-document term frequencies and term sets for efficient DF/TF lookups
  const documentTermFrequencies = tokenizedDocuments.map(termFrequencies);
  const documentTermSets = documentTermFrequencies.map(
    (frequencies) => new Set(frequencies.keys()),
  );
  const documentFrequency = documentFrequencies(queryTerms, documentTermSets);

  // Score each document using precomputed term frequencies
  for (let documentIndex = 0; documentIndex < numberOfDocuments; documentIndex++) {
    const frequencies = documentTermFrequencies[documentIndex]!;
    const documentLength = tokenizedDocuments[documentIndex]!.length;
    scores.set(
      documentIndex,
      scoreDocument(
        frequencies,
        documentLength,
        queryTerms,
        documentFrequency,
        numberOfDocuments,
        averageDocumentLength,
        k1,
        b,
      ),
    );
  }

  return scores;
}
