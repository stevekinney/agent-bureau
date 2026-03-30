import type { Toolbox } from 'armorer';
import type { AgentDefinition, FinishReason, GenerateFunction, RunResult } from 'operative';

/**
 * An expected tool call that the agent should make during evaluation.
 */
export interface ExpectedToolCall {
  /** The name of the tool expected to be called. */
  name: string;
  /** When provided, arguments must match exactly. Otherwise just check the tool was called. */
  arguments?: Record<string, unknown>;
  /** Position in the tool call sequence. Undefined means any position. */
  index?: number;
}

/**
 * A semantic similarity matcher that compares output against a reference string
 * using an embedding function and cosine similarity threshold.
 */
export interface SemanticMatcher {
  type: 'semantic';
  /** The reference text to compare against. */
  reference: string;
  /** Cosine similarity threshold (0-1). Output must meet or exceed this. */
  threshold: number;
}

/**
 * The result of a custom assertion function applied to an evaluation case.
 */
export interface EvaluationAssertion {
  /** Whether the assertion passed. */
  pass: boolean;
  /** Optional human-readable message describing the result. */
  message?: string;
  /** Optional score from 0-1 for partial credit. */
  score?: number;
}

/**
 * A single evaluation test case that defines what to send to an agent
 * and how to judge its response.
 */
export interface EvaluationCase {
  /** Human-readable name for this test case. */
  name: string;
  /** The user message to send to the agent. */
  input: string;
  /** System prompt override for this case. */
  systemPrompt?: string;
  /** Expected tool calls (in order or as a set). */
  expectedToolCalls?: ExpectedToolCall[];
  /** Expected output pattern (string match, regex, or semantic). */
  expectedOutput?: string | RegExp | SemanticMatcher;
  /** Maximum steps the agent should need. */
  maxSteps?: number;
  /** Maximum cost in USD the case should consume. */
  maxCost?: number;
  /** Custom assertion function for full control. */
  assert?: (result: RunResult) => EvaluationAssertion;
  /** Tags for filtering and grouping. */
  tags?: string[];
  /** Timeout in ms for this case. Default: 30_000. */
  timeout?: number;
}

/**
 * The result of running a single evaluation case, including metrics and pass/fail status.
 */
export interface EvaluationCaseResult {
  /** Name of the evaluation case. */
  name: string;
  /** Tags from the evaluation case. */
  tags: string[];
  /** Whether the case passed all assertions. */
  pass: boolean;
  /** Score from 0-1 (1 = perfect). */
  score: number;
  /** Collected metrics for this case. */
  metrics: {
    /** Did the agent produce the expected output? */
    outputMatch: boolean;
    /** Did the agent call the expected tools? */
    toolCallMatch: boolean;
    /** Number of steps the agent took. */
    steps: number;
    /** Total tokens consumed (prompt + completion). */
    totalTokens: number;
    /** Estimated cost in USD. */
    cost: number;
    /** Wall-clock time in ms. */
    duration: number;
    /** Finish reason from the run. */
    finishReason: FinishReason;
  };
  /** Error message if the case failed due to an error. */
  error?: string;
}

/**
 * A complete evaluation report containing per-case results and aggregate summary.
 */
export interface EvaluationReport {
  /** ISO timestamp of when the report was generated. */
  timestamp: string;
  /** Individual case results. */
  cases: EvaluationCaseResult[];
  /** Aggregate summary statistics. */
  summary: {
    total: number;
    passed: number;
    failed: number;
    passRate: number;
    averageScore: number;
    averageSteps: number;
    averageTokens: number;
    averageCost: number;
    averageDuration: number;
    totalCost: number;
  };
}

/**
 * A regression detected when comparing two evaluation reports.
 */
export interface EvaluationRegression {
  /** The name of the case or summary metric that regressed. */
  caseName: string;
  /** The metric that regressed. */
  metric: string;
  /** The baseline value. */
  baseline: number;
  /** The current value. */
  current: number;
  /** The absolute change (current - baseline). */
  delta: number;
}

/**
 * An improvement detected when comparing two evaluation reports.
 */
export interface EvaluationImprovement {
  /** The name of the case or summary metric that improved. */
  caseName: string;
  /** The metric that improved. */
  metric: string;
  /** The baseline value. */
  baseline: number;
  /** The current value. */
  current: number;
  /** The absolute change (current - baseline). */
  delta: number;
}

/**
 * The result of comparing two evaluation reports.
 */
export interface EvaluationComparison {
  /** The baseline report being compared against. */
  baseline: EvaluationReport;
  /** The current report. */
  current: EvaluationReport;
  /** Cases or metrics that got worse. */
  regressions: EvaluationRegression[];
  /** Cases or metrics that got better. */
  improvements: EvaluationImprovement[];
  /** Case names that remained unchanged. */
  unchanged: string[];
}

/**
 * Configurable thresholds for detecting regressions between reports.
 */
export interface RegressionThresholds {
  /** Maximum allowed pass rate drop (0-1). Default: 0.05 (5%). */
  passRateDrop?: number;
  /** Maximum allowed cost increase ratio (0-1). Default: 0.2 (20%). */
  costIncrease?: number;
  /** When true, any previously passing case that now fails is a regression. Default: true. */
  failPreviouslyPassing?: boolean;
}

/**
 * The result of a single matcher check.
 */
export interface MatchResult {
  /** Whether the match succeeded. */
  pass: boolean;
  /** Score from 0-1. */
  score: number;
  /** Human-readable description of the match result. */
  message: string;
}

/**
 * An embedder function that converts text into a numeric vector for semantic comparison.
 */
export type EmbedderFunction = (text: string) => Promise<number[]>;

/**
 * Configuration for the agent under evaluation.
 */
export type EvaluationAgentConfiguration =
  | AgentDefinition
  | { generate: GenerateFunction; toolbox: Toolbox };

/**
 * Options for creating an agent evaluation runner.
 */
export interface CreateAgentEvaluationOptions {
  /** The evaluation cases to run. */
  cases: EvaluationCase[];
  /** The agent or generate+toolbox pair to evaluate. */
  agent: EvaluationAgentConfiguration;
  /** Maximum number of cases to run in parallel. Default: 1. */
  concurrency?: number;
  /** Embedder function for semantic matching. */
  embedder?: EmbedderFunction;
}

export type { Toolbox } from 'armorer';
export type { FinishReason, RunResult, TokenUsage } from 'operative';
