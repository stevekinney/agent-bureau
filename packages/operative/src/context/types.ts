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
