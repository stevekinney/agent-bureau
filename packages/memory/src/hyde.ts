import type { Memory, MemorySearchOptions, MemorySearchResult } from './types';

/**
 * A function that generates a hypothetical answer for a query.
 * The answer need not be factually correct — only semantically shaped
 * like stored memories, so it produces a better vector search probe.
 */
export type HypotheticalAnswerGenerator = (query: string) => Promise<string>;

/**
 * Options for the HyDE (Hypothetical Document Embeddings) wrapper.
 */
export interface HyDEOptions {
  /** Function that generates a hypothetical answer for the query. */
  generateHypothetical: HypotheticalAnswerGenerator;
  /**
   * When true (default), the BM25 text search leg sees both the hypothetical
   * answer and the original query, preserving exact keyword matches from the
   * user's phrasing. When false, only the hypothetical is searched.
   */
  augmentTextSearch?: boolean;
}

/**
 * Options for the convenience HyDE generator factory.
 */
export interface CreateHyDEGeneratorOptions {
  /** A function that calls an LLM and returns its text response. */
  generateText: (prompt: string) => Promise<string>;
  /**
   * Custom system prompt for the hypothetical answer generation.
   * When omitted, a default prompt optimized for semantic search is used.
   */
  systemPrompt?: string;
}

const DEFAULT_SYSTEM_PROMPT = [
  'You are a semantic search helper. Given a user query, write 1-2 declarative',
  'sentences that answer the query as if they were stored memory entries.',
  'Factual accuracy does not matter — only the semantic shape matters.',
  'Do not include the original question. Do not add caveats or qualifiers.',
].join(' ');

/**
 * Wraps a Memory instance with HyDE (Hypothetical Document Embeddings).
 *
 * HyDE improves recall precision by generating a hypothetical answer before
 * embedding the search query. The hypothetical answer, even if factually wrong,
 * is structurally similar to stored memories, producing a better vector search
 * probe. See: Gao et al., "Precise Zero-Shot Dense Retrieval without Relevance
 * Labels" (ACL 2023).
 *
 * All methods except `recall()` pass through to the inner memory unchanged.
 */
export function withHyDE(memory: Memory, options: HyDEOptions): Memory {
  const { generateHypothetical, augmentTextSearch = true } = options;

  const wrapped: Memory = Object.create(memory) as Memory;

  wrapped.recall = async (
    query: string,
    searchOptions?: MemorySearchOptions,
  ): Promise<MemorySearchResult[]> => {
    const hypothetical = await generateHypothetical(query);
    const searchQuery = augmentTextSearch ? `${hypothetical}\n${query}` : hypothetical;
    return memory.recall(searchQuery, searchOptions);
  };

  return wrapped;
}

/**
 * Convenience factory that builds a `HypotheticalAnswerGenerator` from a
 * generic `generateText` function. The generator prompts the LLM to produce
 * 1-2 declarative sentences shaped like stored memories.
 */
export function createHyDEGenerator(
  options: CreateHyDEGeneratorOptions,
): HypotheticalAnswerGenerator {
  const { generateText, systemPrompt = DEFAULT_SYSTEM_PROMPT } = options;

  return async (query: string): Promise<string> => {
    const prompt = `${systemPrompt}\n\nQuery: ${query}`;
    return generateText(prompt);
  };
}
