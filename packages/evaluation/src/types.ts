import type { Toolbox } from 'armorer';
import type { AgentDefinition, FinishReason, GenerateFunction, RunResult } from 'operative';

/**
 * An expected tool call that the agent should make during evaluation.
 */
export type ExpectedToolCall = {
  /** The name of the tool expected to be called. */
  name: string;
  /** When provided, arguments must match exactly. Otherwise just check the tool was called. */
  arguments?: Record<string, unknown>;
  /** Position in the tool call sequence. Undefined means any position. */
  index?: number;
};

/**
 * A semantic similarity matcher that compares output against a reference string
 * using an embedding function and cosine similarity threshold.
 */
export type SemanticMatcher = {
  type: 'semantic';
  /** The reference text to compare against. */
  reference: string;
  /** Cosine similarity threshold (0-1). Output must meet or exceed this. */
  threshold: number;
};

/**
 * The result of a custom assertion function applied to an evaluation case.
 */
export type EvaluationAssertion = {
  /** Whether the assertion passed. */
  pass: boolean;
  /** Optional human-readable message describing the result. */
  message?: string;
  /** Optional score from 0-1 for partial credit. */
  score?: number;
};

/**
 * A single evaluation test case that defines what to send to an agent
 * and how to judge its response.
 */
export type EvaluationCase = {
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
  /** Custom assertion function for full control. */
  assert?: (result: RunResult) => EvaluationAssertion;
  /** Tags for filtering and grouping. */
  tags?: string[];
  /** Timeout in ms for this case. Default: 30_000. */
  timeout?: number;
};

/**
 * The result of running a single evaluation case, including metrics and pass/fail status.
 */
export type EvaluationCaseResult = {
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
    /** Wall-clock time in ms. */
    duration: number;
    /** Finish reason from the run. */
    finishReason: FinishReason;
  };
  /** Error message if the case failed due to an error. */
  error?: string;
};

/**
 * A complete evaluation report containing per-case results and aggregate summary.
 */
export type EvaluationReport = {
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
    averageDuration: number;
  };
};

/**
 * A change detected when comparing two evaluation reports—either a regression
 * (negative delta) or an improvement (positive delta).
 */
export type EvaluationChange = {
  /** The name of the case or 'summary' for aggregate metrics. */
  caseName: string;
  /** The metric that changed. */
  metric: string;
  /** The baseline value. */
  baseline: number;
  /** The current value. */
  current: number;
  /** The absolute change (current - baseline). */
  delta: number;
};

/**
 * The result of comparing two evaluation reports.
 */
export type EvaluationComparison = {
  /** The baseline report being compared against. */
  baseline: EvaluationReport;
  /** The current report. */
  current: EvaluationReport;
  /** Cases or metrics that got worse. */
  regressions: EvaluationChange[];
  /** Cases or metrics that got better. */
  improvements: EvaluationChange[];
  /** Case names that remained unchanged. */
  unchanged: string[];
};

/**
 * Configurable thresholds for detecting regressions between reports.
 */
export type RegressionThresholds = {
  /** Maximum allowed pass rate drop (0-1). Default: 0.05 (5%). */
  passRateDrop?: number;
  /** Maximum allowed cost increase ratio (0-1). Default: 0.2 (20%). */
  costIncrease?: number;
  /** When true, any previously passing case that now fails is a regression. Default: true. */
  failPreviouslyPassing?: boolean;
};

/**
 * The result of a single matcher check.
 */
export type MatchResult = {
  /** Whether the match succeeded. */
  pass: boolean;
  /** Score from 0-1. */
  score: number;
  /** Human-readable description of the match result. */
  message: string;
};

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
export type CreateAgentEvaluationOptions = {
  /** The evaluation cases to run. */
  cases: EvaluationCase[];
  /** The agent or generate+toolbox pair to evaluate. */
  agent: EvaluationAgentConfiguration;
  /** Maximum number of cases to run in parallel. Default: 1. */
  concurrency?: number;
  /** Embedder function for semantic matching. */
  embedder?: EmbedderFunction;
};
