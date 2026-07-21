import type { AnyToolbox } from 'armorer';
import type { FinishReason, GenerateFunction, RegistryAgent, RunResult } from 'operative';

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
 * Where a promoted evaluation case's golden expectation came from.
 */
export type EvaluationCaseOrigin = 'evaluation-run' | 'production-failure';

/**
 * Provenance recorded on a case that was promoted from a recorded run via
 * `promoteRunToCase()` — which run/failure produced it, and when.
 */
export type EvaluationCaseProvenance = {
  /** Whether the source run came from an evaluation suite or a production failure. */
  origin: EvaluationCaseOrigin;
  /** Identifier for the recorded run (report timestamp + case name, bureau run id, etc). */
  runId: string;
  /** Name of the case that produced the run, when promoted from an existing evaluation case. */
  sourceCaseName?: string;
  /** ISO timestamp of when the case was promoted. */
  promotedAt: string;
  /** The finish reason of the promoted run. */
  finishReason: FinishReason;
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
  /**
   * When set, the case also fails unless the actual number of tool calls
   * equals this count exactly — closes the gap `expectedToolCalls` alone
   * leaves open (it pins the calls it lists but never rejects *extra*,
   * unlisted calls). `promoteRunToCase()` sets this to the promoted run's
   * call count so a promoted case reproduces the exact golden trajectory,
   * not just "at least these calls happened."
   */
  expectedToolCallCount?: number;
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
  /** Set when this case was promoted from a recorded run via `promoteRunToCase()`. */
  provenance?: EvaluationCaseProvenance;
};

/**
 * Options for `promoteRunToCase()` — turns a recorded run into a runnable
 * regression case whose expectations snapshot that run's actual behavior.
 */
export type PromoteRunToCaseOptions = {
  /** The case whose input/systemPrompt/tags produced the run. */
  sourceCase: EvaluationCase;
  /** The recorded run to promote into a golden regression case. */
  runResult: RunResult;
  /** Whether the run came from an evaluation suite or a production failure. */
  origin: EvaluationCaseOrigin;
  /** Identifier for the recorded run (report timestamp + case name, bureau run id, etc). */
  runId: string;
  /** Name for the new case. Default: `"${sourceCase.name} (promoted)"`. */
  name?: string;
  /**
   * Overrides the golden expected output instead of snapshotting the run's
   * actual `content`. Use this when promoting a *failure* — snapshotting the
   * buggy output as the expectation would lock the bug in as "correct".
   */
  expectedOutput?: string | SemanticMatcher;
};

/**
 * A dataset file on disk, versioned: `saveDataset()` bumps `version` on every
 * write so dataset changes are attributable to a specific revision.
 */
export type DatasetFile = {
  /** Monotonically increasing version, bumped on every `saveDataset()` write. */
  version: number;
  /** The evaluation cases in this dataset revision. */
  cases: EvaluationCase[];
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
 * A single report's aggregate stats, keyed by file path — the row shape
 * `listEvaluationReports()` returns for a pass-rate/cost trend view over time.
 */
export type EvaluationReportSummary = {
  /** Absolute path to the report file this summary was read from. */
  path: string;
  /** ISO timestamp the report was generated (`EvaluationReport.timestamp`). */
  timestamp: string;
  total: number;
  passed: number;
  failed: number;
  passRate: number;
  averageTokens: number;
  averageDuration: number;
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
  | RegistryAgent
  | { generate: GenerateFunction; toolbox: AnyToolbox };

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

/**
 * Configuration for an LLM-as-judge scorer that evaluates output quality
 * using a generate function and a rubric.
 */
export type LLMJudgeOptions = {
  /** Generate function used for judging (can be a cheaper model). */
  judge: GenerateFunction;
  /** Rubric describing what constitutes a good response. */
  rubric: string;
  /** Score scale. Default: { min: 1, max: 5 }. */
  scale?: { min: number; max: number };
};

/**
 * The result of an LLM judge evaluation.
 */
export type LLMJudgeResult = {
  /** The score assigned by the judge, within the configured scale. */
  score: number;
  /** The judge's reasoning for the assigned score. */
  reasoning: string;
};

/**
 * A single step in a golden (reference) trajectory: the tool call an agent
 * is expected to make, in sequence order (array position is the expected
 * order — unlike `ExpectedToolCall`, there is no separate `index` field).
 */
export type GoldenTrajectoryStep = {
  /** The name of the tool expected to be called at this step. */
  name: string;
  /** When provided, arguments must match exactly. Otherwise just the name is checked. */
  arguments?: Record<string, unknown>;
};

/**
 * Configurable tolerance for trajectory matching.
 */
export type TrajectoryTolerance = {
  /** Whether tool calls not present in the golden path are permitted at all. Default: true. */
  allowExtraCalls?: boolean;
  /**
   * Maximum number of extra (unmatched) actual tool calls tolerated before
   * the trajectory fails. Default: `Infinity` when `allowExtraCalls` is true,
   * `0` otherwise.
   */
  maxExtraCalls?: number;
  /**
   * Maximum number of golden steps allowed to be matched out of relative
   * order before the trajectory fails. Default: 0 (strict order).
   */
  reorderTolerance?: number;
};

/**
 * The outcome of matching a single golden trajectory step against the
 * actual tool-call sequence.
 */
export type TrajectoryStepMatch = {
  /** Index of this step within the golden trajectory. */
  goldenIndex: number;
  /** The expected tool name. */
  name: string;
  /** Whether a corresponding actual call was found. */
  matched: boolean;
  /** Index of the matched call within the flattened actual tool-call sequence. */
  actualIndex?: number;
  /** Whether this step's match came out of relative order with prior matched steps. */
  reordered: boolean;
  /** Whether the matched call's arguments matched (only meaningful when `arguments` was specified). */
  argumentsMatch?: boolean;
};

/**
 * The result of scoring an actual tool-call trajectory against a golden path.
 */
export type TrajectoryMatchResult = {
  /** Whether the trajectory passed under the given tolerance. */
  pass: boolean;
  /** Score from 0-1 (1 = perfect match). */
  score: number;
  /** Human-readable summary of the match outcome. */
  message: string;
  /** Per-golden-step match diagnostics, in golden order. */
  steps: TrajectoryStepMatch[];
  /** Number of golden steps with no corresponding actual call. */
  missingCallCount: number;
  /** Number of actual calls not matched to any golden step. */
  extraCallCount: number;
  /** Number of golden steps whose match came out of relative order. */
  reorderedCount: number;
};

/**
 * Thresholds for detecting per-case step-count and cost regressions between
 * two evaluation runs of the same case.
 */
export type TrajectoryRegressionThresholds = {
  /** Maximum allowed absolute increase in step count. Default: 0 (any increase regresses). */
  maxStepIncrease?: number;
  /** Maximum allowed increase in total token cost, as a ratio of baseline. Default: 0.2 (20%). */
  maxCostIncreaseRatio?: number;
};

/**
 * A single metric's baseline-vs-current comparison, including whether it
 * regressed under the configured threshold.
 */
export type TrajectoryMetricDelta = {
  baseline: number;
  current: number;
  delta: number;
  regressed: boolean;
};

/**
 * Per-case step-count and cost regression report, comparing a baseline
 * evaluation case result against a current one.
 */
export type TrajectoryRegressionReport = {
  /** Name of the evaluation case being compared. */
  caseName: string;
  /** Step-count comparison. */
  stepCount: TrajectoryMetricDelta;
  /** Total-token cost comparison. */
  cost: TrajectoryMetricDelta;
  /** True when either step count or cost regressed. */
  regressed: boolean;
};

/**
 * Options for running a full evaluation suite with dataset loading,
 * baseline comparison, and report output.
 */
export type EvaluationSuiteOptions = {
  /** Dataset file paths or glob patterns to load. */
  datasets: string | string[];
  /** The agent or generate+toolbox pair to evaluate. */
  agent: EvaluationAgentConfiguration;
  /** Path to a baseline report JSON file for regression comparison. */
  baseline?: string;
  /** Path to write the current report JSON. */
  output?: string;
  /** Regression detection thresholds. */
  thresholds?: RegressionThresholds;
  /** Maximum number of cases to run in parallel. Default: 1. */
  concurrency?: number;
  /** Embedder function for semantic matching. */
  embedder?: EmbedderFunction;
};

/**
 * The result of running a full evaluation suite, including the report,
 * optional comparison against a baseline, and a CI-compatible exit code.
 */
export type EvaluationSuiteResult = {
  /** The evaluation report for this run. */
  report: EvaluationReport;
  /** Comparison against the baseline, if a baseline was provided. */
  comparison?: EvaluationComparison;
  /** Exit code: 0 when all checks pass, 1 when a regression is detected. */
  exitCode: 0 | 1;
};

/**
 * The result of benchmarking one `InputDetector` configuration against the
 * prompt-injection fixture set (AB-44). See `prompt-injection-benchmark.ts`.
 */
export type PromptInjectionBenchmarkResult = {
  /** Standard evaluation report — usable with `compareEvaluationReports()`. */
  report: EvaluationReport;
  /** True positive rate on attack fixtures: correctly triggered / total attacks. */
  detectionRate: number;
  /** False positive rate on benign fixtures: incorrectly triggered / total benign. */
  falsePositiveRate: number;
};

/**
 * The two detector configurations `benchmarkPromptInjectionConfigurations()`
 * compares: the raw detector and the confidence-gated preset (AB-40).
 */
export type PromptInjectionBenchmarkComparison = {
  /** `createPromptInjectionDetector()` with no confidence gating. */
  raw: PromptInjectionBenchmarkResult;
  /**
   * `createPromptInjectionDetector()` wrapped in
   * `withMinimumTripwireConfidence(..., 0.6)` — the configuration actually
   * wired into the default guardrail preset (AB-40).
   */
  gated: PromptInjectionBenchmarkResult;
};
