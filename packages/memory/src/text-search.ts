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
    if (/[\u3040-\u30ff]/.test(word)) {
      // Japanese: extract script-specific chunks.
      const parts =
        word.match(/[a-z0-9_]+|[\u30a0-\u30ffー]+|[\u4e00-\u9fff]+|[\u3040-\u309f]{2,}/g) ?? [];
      for (const part of parts) {
        if (/^[\u4e00-\u9fff]+$/.test(part)) {
          expandCJKUnigrams(part, tokens);
        } else {
          tokens.push(part);
        }
      }
    } else if (/[\u4e00-\u9fff]/.test(word)) {
      // Chinese or mixed CJK with Latin: preserve Latin chunks and expand
      // contiguous CJK runs into character unigrams + bigrams.
      let cjkRun = '';
      let latinRun = '';
      const flushLatin = () => {
        if (latinRun) {
          tokens.push(latinRun);
          latinRun = '';
        }
      };
      const flushCJK = () => {
        if (cjkRun) {
          expandCJKUnigrams(cjkRun, tokens);
          cjkRun = '';
        }
      };
      for (const ch of Array.from(word)) {
        if (/[\u4e00-\u9fff]/.test(ch)) {
          // Part of a CJK run.
          flushLatin();
          cjkRun += ch;
        } else if (/[a-z0-9_]/.test(ch)) {
          // Part of a Latin/number run.
          flushCJK();
          latinRun += ch;
        } else {
          // Delimiter or other script: end any current runs.
          flushLatin();
          flushCJK();
        }
      }
      flushLatin();
      flushCJK();
    } else {
      tokens.push(word);
    }
  }

  return tokens;
}

/**
 * Pushes character unigrams and overlapping bigrams for a CJK run.
 */
function expandCJKUnigrams(run: string, tokens: string[]): void {
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
  const documentTermFrequencies: Map<string, number>[] = [];
  const documentTermSets: Set<string>[] = [];
  for (const tokens of tokenizedDocuments) {
    const frequencies = new Map<string, number>();
    for (const token of tokens) {
      frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
    }
    documentTermFrequencies.push(frequencies);
    documentTermSets.push(new Set(frequencies.keys()));
  }

  // Build document frequency for each query term using precomputed term sets
  const documentFrequency = new Map<string, number>();
  for (const term of queryTerms) {
    if (documentFrequency.has(term)) continue;
    let count = 0;
    for (const termSet of documentTermSets) {
      if (termSet.has(term)) count++;
    }
    documentFrequency.set(term, count);
  }

  // Score each document using precomputed term frequencies
  for (let documentIndex = 0; documentIndex < numberOfDocuments; documentIndex++) {
    const termFrequencies = documentTermFrequencies[documentIndex]!;
    const documentLength = tokenizedDocuments[documentIndex]!.length;
    let score = 0;

    for (const term of queryTerms) {
      const df = documentFrequency.get(term) ?? 0;
      const termFrequency = termFrequencies.get(term) ?? 0;

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
