/**
 * Types for the context engine.
 *
 * Defines the public interfaces for token budgeting, context assembly,
 * compaction strategies, and the top-level context engine options.
 */

import type { Conversation, Message } from 'conversationalist';

import type { TokenBudget } from './token-budget';

/** Options controlling how the context window is assembled before a generate call. */
export interface AssemblyOptions {
  conversation: Conversation;
  budget: TokenBudget;
  /** Number of most-recent messages to always include. Default: `4`. */
  recentMessageCount?: number;
  /** Fraction of allocatable budget reserved for system messages. Default: `0.25`. */
  systemBudgetRatio?: number;
  /** Fraction of allocatable budget reserved for conversation history. Default: `0.60`. */
  historyBudgetRatio?: number;
  /** Fraction of allocatable budget reserved for retrieved messages. Default: `0.15`. */
  retrievedBudgetRatio?: number;
  /** Additional retrieved messages (e.g. from memory) to include when budget allows. */
  retrievedMessages?: ReadonlyArray<Message>;
  /** Override the per-text token estimator. */
  tokenEstimator?: (text: string) => number;
  /**
   * Enables prompt-cache-aware assembly. When `true`, system messages and
   * `pinnedMessages` are assembled into a stable prefix that stays
   * byte-identical across calls as the conversation grows — no budget
   * truncation, no re-ranking — and the last message of that prefix is
   * returned with `cacheBoundary: true` so a provider adapter (e.g.
   * `toAnthropicMessages`) can lower it to a `cache_control` breakpoint.
   * History and `retrievedMessages` are unaffected: they are assembled
   * exactly as in the default mode and appended AFTER the stable prefix, so
   * their per-step re-ranking never touches the cached region.
   * Default: `false`.
   */
  stablePrefix?: boolean;
  /**
   * Messages always included, verbatim and in order, immediately after the
   * system messages and before conversation history. Unlike
   * `retrievedMessages`, these are never re-ranked or dropped by budget
   * pressure — they are part of the stable prefix (e.g. pinned reference
   * material). Only consulted when `stablePrefix` is `true`.
   */
  pinnedMessages?: ReadonlyArray<Message>;
}

/** Breakdown of token usage across context slices. */
export interface BudgetReport {
  systemTokens: number;
  historyTokens: number;
  retrievedTokens: number;
  totalTokens: number;
  remainingTokens: number;
}

/** The result of assembling a context window. */
export interface AssemblyResult {
  messages: ReadonlyArray<Message>;
  budgetReport: BudgetReport;
}

/** A function that assembles the context window from a conversation and budget. */
export type ContextAssembler = (options: AssemblyOptions) => AssemblyResult;

/** Options controlling how compaction strategies operate. */
export interface CompactionOptions {
  /** Number of recent messages to always retain. Default: `4`. */
  retainRecentMessages?: number;
  /** Summarizer function for strategies that need it. */
  summarize?: (messages: ReadonlyArray<Message>) => Promise<string>;
  /** Maximum age (in turns) for tool results before they are eligible for pruning. */
  maxToolResultAge?: number;
  /**
   * Preserve tool-result messages with `toolResult.outcome === 'error'` or
   * `metadata.error === true`, regardless of age. Default: `true`. Mirrors
   * the `errors` flag in conversationalist's `CompactionPreservePolicy` (see
   * `Conversation.compact()`), so both compaction paths agree on the same
   * preserve-by-default posture — error results are diagnostic signal that
   * age-based pruning would otherwise discard. Set to `false` to opt back
   * into pruning errors purely by age.
   */
  preserveErrorToolResults?: boolean;
}

/** A function that compacts a conversation to free tokens. */
export type CompactionStrategy = (
  conversation: Conversation,
  budget: TokenBudget,
  options: CompactionOptions,
) => Promise<void>;

/** Top-level options for creating a context engine. */
export interface ContextEngineOptions {
  maxTokens: number;
  /** Minimum tokens reserved for the model response. Default: `1500`. */
  minimumResponseTokens?: number;
  /** Warning when remaining tokens drop to this level. Default: 20% of `maxTokens`. */
  warningThreshold?: number;
  /** Compaction triggered when used tokens reach this level. Default: 80% of `maxTokens`. */
  compactionThreshold?: number;
  /** Override the per-text token estimator. */
  tokenEstimator?: (text: string) => number;
  /** Override the context assembler. */
  assembler?: ContextAssembler;
}
