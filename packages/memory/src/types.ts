// Local type aliases — will be replaced with imports from 'interoperability' when available
export type EmbeddingVector = number[];
export type Embedder = (texts: string[]) => EmbeddingVector[] | Promise<EmbeddingVector[]>;

export interface MemoryEntry {
  id: string;
  content: string;
  vector: number[];
  metadata: MemoryMetadata;
  createdAt: number;
  updatedAt: number;
}

export interface MemoryMetadata {
  namespace: string;
  source: 'auto-capture' | 'tool' | 'manual';
  conversationId?: string;
  agentId?: string;
  importance?: number;
  evergreen?: boolean;
  tags?: string[];
  [key: string]: unknown;
}

export interface MemorySearchOptions {
  limit?: number;
  threshold?: number;
  namespace?: string;
  includeVector?: boolean;
  vectorWeight?: number;
  textWeight?: number;
  temporalDecay?: { halfLifeMilliseconds: number; evergreenExempt?: boolean };
  diversify?: { lambda: number };
}

export interface MemorySearchResult {
  id: string;
  content: string;
  score: number;
  metadata: MemoryMetadata;
  createdAt: number;
}

export interface Memory {
  remember(content: string, metadata?: Partial<MemoryMetadata>): Promise<MemoryEntry>;
  recall(query: string, options?: MemorySearchOptions): Promise<MemorySearchResult[]>;
  forget(id: string): Promise<void>;
  forgetAll(namespace?: string): Promise<void>;
  count(namespace?: string): Promise<number>;
  init(): Promise<void>;
  close(): Promise<void>;
}

export interface CreateMemoryOptions {
  embedder: (texts: string[]) => number[][] | Promise<number[][]>;
  storage: import('vector-frankl').StorageAdapter;
  namespace?: string;
  dimension?: number;
  defaultSearchOptions?: Partial<MemorySearchOptions>;
  deduplicationThreshold?: number;
}
