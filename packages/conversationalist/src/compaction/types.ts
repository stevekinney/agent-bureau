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

/**
 * What one `Conversation.compact()` attempt reports about itself, on every
 * event it emits and on its result.
 *
 * Both revisions are values of the conversation's own controller revision
 * — the one `Conversation.revision`, store snapshots, persisted snapshots,
 * and every event already carry. An attempt never keeps a revision counter
 * of its own.
 */
export interface CompactionAttempt {
  /** Identity of one `compact()` call, minted from the environment runtime. */
  readonly attemptId: string;
  /** Controller revision of the snapshot the candidate is built from. */
  readonly baseRevision: number;
  /**
   * Controller revision observed when this record was taken. On a commit it
   * is the compared revision, so it equals `baseRevision`; on a discard it
   * is the newer revision that made the candidate stale.
   */
  readonly observedRevision: number;
  /** Milliseconds from the attempt starting, on the environment runtime's clock. */
  readonly durationMs: number;
  /** Estimated tokens in the base snapshot. */
  readonly baseTokens: number;
  /** Estimated tokens in the candidate, once one exists. */
  readonly candidateTokens?: number | undefined;
}

type ConversationCompactionReport = {
  /** Controller revision after the attempt settled. */
  readonly revision: number;
  readonly attempt: CompactionAttempt;
};

/**
 * The settled outcome of `Conversation.compact()`.
 *
 * - `committed`: the candidate was published by compare-and-swap against
 *   `attempt.baseRevision` and is now the model-visible history.
 * - `no-op`: nothing was eligible for compaction, so nothing was published.
 * - `discarded`: the conversation moved past `attempt.baseRevision` while
 *   the candidate was being built. The candidate was dropped unpublished and
 *   the newer history is untouched.
 *
 * A failed or cancelled attempt rejects instead, and publishes nothing.
 */
export type ConversationCompactionResult =
  | (CompactionResult &
      ConversationCompactionReport & { readonly outcome: 'committed'; readonly compacted: true })
  | (CompactionResult &
      ConversationCompactionReport & { readonly outcome: 'no-op'; readonly compacted: false })
  | (CompactionResult &
      ConversationCompactionReport & {
        readonly outcome: 'discarded';
        readonly compacted: false;
        readonly reason: 'revision-conflict';
      });
