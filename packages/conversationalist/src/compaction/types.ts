import type { ConversationHistory, Message } from '../types';

export type Summarizer = (
  messages: Message[],
  options?: { maxTokens?: number | undefined; signal?: AbortSignal | undefined },
) => Promise<string>;

export interface CompactionPreservePolicy {
  pinned?: boolean | undefined;
  decisions?: boolean | undefined;
  errors?: boolean | undefined;
}

export interface CompactionOptions {
  signal?: AbortSignal | undefined;
  preserveRecentCount?: number | undefined;
  preserveSystemMessages?: boolean | undefined;
  preserveToolPairs?: boolean | undefined;
  baseChunkRatio?: number | undefined;
  minimumChunkRatio?: number | undefined;
  safetyMargin?: number | undefined;
  maxSummaryTokens?: number | undefined;
  preservePolicy?: CompactionPreservePolicy | undefined;
}

export interface CompactionResult {
  compacted: boolean;
  chunksProcessed: number;
  messagesRemoved: number;
  summaryContent: string;
}

export type CompactionInput = ConversationHistory;
