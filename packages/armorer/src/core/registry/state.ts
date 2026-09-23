import type { TextSearchIndex } from '../query-predicates';
import type {
  EmbeddingIndex,
  InvertedIndex,
  QuerySelectionResult,
  TextInvertedIndex,
  ToolDefinition,
  ToolLookupCache,
} from './types';

export const searchIndex = new WeakMap<ToolDefinition, TextSearchIndex>();
export const toolLookupCache = new WeakMap<ToolDefinition, ToolLookupCache>();
export const registryInvertedIndex = new WeakMap<object, InvertedIndex>();
export const registryTextIndex = new WeakMap<object, TextInvertedIndex>();
export const registryEmbeddingIndex = new WeakMap<object, EmbeddingIndex>();
export const queryCache = new WeakMap<object, Map<string, QuerySelectionResult>>();

export const BIGRAM_SIZE = 2;
export const GRAM_SIZE = 3;
export const EMBEDDING_SEED = 0x1a2b3c4d;
