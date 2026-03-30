# Agent Behavior Evaluation Framework

## Overview

Agent-bureau has 287+ test files covering unit and integration behavior of individual packages. What's missing is a framework for testing whether _agents do the right thing_—a way to run an agent against a set of tasks, measure whether it succeeded, and gate deployments on those scores. Only 52% of production teams have adopted agent evals, but those that have iterate faster and ship more reliably.

This work creates a new `packages/evaluation/` package that provides `createAgentEval()`, metrics collection, golden dataset management, and CI integration.

## What Exists Today

Read these files to understand the current state:

- `packages/operative/src/test/index.ts` — `createMockGenerate()`, `createRunRecorder()` (unit-level mocks, not agent-level eval)
- `packages/operative/src/types.ts` — `RunResult`, `StepResult`, `FinishReason` (what an eval would inspect)
- `packages/operative/src/cost-estimation.ts` — `estimateCost()` (cost metrics already available)
- `packages/integration/` — cross-package integration tests (structural, not behavioral)
- `packages/herald/src/test/` — mock clients and fixtures

## Product Requirements

### PR-1: Eval Runner

`createAgentEval()` accepts a set of test cases and an agent (or `GenerateFunction` + `Toolbox`) and runs each case, collecting results:

```typescript
interface EvalCase {
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
  assert?: (result: RunResult) => EvalAssertion;
  /** Tags for filtering and grouping. */
  tags?: string[];
  /** Timeout in ms for this case. Default: 30_000. */
  timeout?: number;
}

interface ExpectedToolCall {
  name: string;
  /** When true, arguments must match exactly. Otherwise just check the tool was called. */
  arguments?: Record<string, unknown>;
  /** Position in the tool call sequence. Undefined = any position. */
  index?: number;
}

interface SemanticMatcher {
  type: 'semantic';
  reference: string;
  threshold: number; // cosine similarity threshold, e.g., 0.85
}

interface EvalAssertion {
  pass: boolean;
  message?: string;
  score?: number; // 0-1 for partial credit
}
```

### PR-2: Metrics Collection

Each eval run produces a `EvalReport` with standardized metrics:

```typescript
interface EvalCaseResult {
  name: string;
  tags: string[];
  pass: boolean;
  score: number; // 0-1
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
  error?: string;
}

interface EvalReport {
  timestamp: string;
  cases: EvalCaseResult[];
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
```

### PR-3: Comparison and Regression Detection

Compare two `EvalReport` instances to detect regressions:

```typescript
interface EvalComparison {
  baseline: EvalReport;
  current: EvalReport;
  regressions: EvalRegression[];
  improvements: EvalImprovement[];
  unchanged: string[];
}

interface EvalRegression {
  caseName: string;
  metric: string;
  baseline: number;
  current: number;
  delta: number;
}

interface EvalImprovement {
  caseName: string;
  metric: string;
  baseline: number;
  current: number;
  delta: number;
}

function compareEvalReports(
  baseline: EvalReport,
  current: EvalReport,
  thresholds?: RegressionThresholds,
): EvalComparison;
```

Default thresholds: pass rate drops by >5%, average cost increases by >20%, or any previously passing case now fails.

### PR-4: Golden Dataset Format

Eval cases stored as JSON files in a `datasets/` directory:

```
packages/evaluation/datasets/
  basic-tool-use.json
  multi-step-reasoning.json
  error-handling.json
```

Each file is an array of `EvalCase` objects. The eval runner can load datasets by name or glob pattern.

```typescript
function loadDataset(path: string): Promise<EvalCase[]>;
function loadDatasets(glob: string): Promise<EvalCase[]>;
```

### PR-5: LLM-as-Judge Scoring

For cases where exact match is insufficient, support LLM-based evaluation:

```typescript
interface LLMJudgeOptions {
  /** Generate function used for judging (can be cheaper model). */
  judge: GenerateFunction;
  /** Rubric describing what constitutes a good response. */
  rubric: string;
  /** Score scale. Default: 1-5. */
  scale?: { min: number; max: number };
}

function createLLMJudge(options: LLMJudgeOptions): (
  input: string,
  output: string,
  reference?: string,
) => Promise<{ score: number; reasoning: string }>;
```

### PR-6: CI Integration

A `runEvalSuite()` function that:

1. Loads datasets
2. Runs eval cases
3. Loads baseline report (from file or storage)
4. Compares and detects regressions
5. Returns exit code 0 (pass) or 1 (regression detected)
6. Writes report to JSON file

```typescript
interface EvalSuiteOptions {
  datasets: string | string[];
  agent: AgentDefinition | { generate: GenerateFunction; toolbox: Toolbox };
  baseline?: string; // path to baseline report JSON
  output?: string; // path to write current report
  thresholds?: RegressionThresholds;
  concurrency?: number;
}

function runEvalSuite(options: EvalSuiteOptions): Promise<{
  report: EvalReport;
  comparison?: EvalComparison;
  exitCode: 0 | 1;
}>;
```

## Architecture

### New Package

`packages/evaluation/`:

- `src/types.ts` — all types above
- `src/create-agent-eval.ts` — `createAgentEval()` factory
- `src/metrics.ts` — metric computation from `RunResult`
- `src/comparison.ts` — `compareEvalReports()`, regression detection
- `src/datasets.ts` — `loadDataset()`, `loadDatasets()`
- `src/llm-judge.ts` — `createLLMJudge()` factory
- `src/run-eval-suite.ts` — `runEvalSuite()` CI entry point
- `src/matchers.ts` — output matching (exact, regex, semantic)
- `src/index.ts` — re-exports
- `datasets/` — golden dataset JSON files
- `package.json` — depends on operative, armorer, herald (dev)

### Dependencies

- **Runtime**: operative (for `RunResult`, `AgentDefinition`), armorer (for `Toolbox`)
- **Dev**: herald (for mock generate functions in tests)
- **No new external deps**: uses existing monorepo infrastructure

## Implementation Order (TDD)

### Phase 1: Output Matchers

1. Write tests:
   - Exact string match (case-sensitive)
   - Regex match against output
   - Substring containment
   - Semantic similarity above threshold (mock embedder)
   - Custom assertion function
   - Partial score computation
2. Implement `matchers.ts`
3. Verify: `bun test packages/evaluation/src/matchers.test.ts`

### Phase 2: Metrics Computation

1. Write tests:
   - Extract step count from `RunResult`
   - Extract token usage from `RunResult`
   - Compute cost via `estimateCost()`
   - Tool call matching (exact order vs. set membership)
   - Duration tracking
   - Handle missing/partial data gracefully
2. Implement `metrics.ts`
3. Verify: `bun test packages/evaluation/src/metrics.test.ts`

### Phase 3: Eval Runner

1. Write tests for `createAgentEval()`:
   - Single case, agent returns expected output → pass
   - Single case, agent returns wrong output → fail with score 0
   - Multiple cases run independently
   - Timeout kills long-running case
   - `maxSteps` enforced via stop condition
   - `maxCost` enforced via cost budget monitor
   - Custom `assert` function receives full `RunResult`
   - Tags preserved in results
   - Error in agent captured, case marked as failed
   - Concurrency control (max parallel cases)
2. Implement `create-agent-eval.ts`
3. Verify: `bun test packages/evaluation/src/create-agent-eval.test.ts`

### Phase 4: Report Comparison

1. Write tests for `compareEvalReports()`:
   - Identical reports → no regressions, no improvements
   - Case that was passing now fails → regression
   - Case that was failing now passes → improvement
   - Pass rate drop exceeding threshold → regression
   - Cost increase exceeding threshold → regression
   - New case in current report → listed as new
   - Missing case in current report → listed as removed
   - Custom thresholds override defaults
2. Implement `comparison.ts`
3. Verify: `bun test packages/evaluation/src/comparison.test.ts`

### Phase 5: Dataset Loading

1. Write tests:
   - Load single JSON file → array of `EvalCase`
   - Load glob pattern → merged array from all matches
   - Invalid JSON → descriptive error
   - Missing file → descriptive error
   - Validate case schema (name and input required)
2. Implement `datasets.ts`
3. Verify: `bun test packages/evaluation/src/datasets.test.ts`

### Phase 6: LLM Judge

1. Write tests:
   - Judge returns score and reasoning
   - Score normalized to configured scale
   - Rubric included in judge prompt
   - Reference answer included when provided
   - Judge error returns score 0 with error message
2. Implement `llm-judge.ts`
3. Verify: `bun test packages/evaluation/src/llm-judge.test.ts`

### Phase 7: CI Suite Runner

1. Write tests for `runEvalSuite()`:
   - Runs all cases from datasets
   - Writes report JSON to output path
   - Returns exit code 0 when no regressions
   - Returns exit code 1 when regression detected
   - Compares against baseline when provided
   - Skips comparison when no baseline
2. Implement `run-eval-suite.ts`
3. Verify: `bun test packages/evaluation/src/run-eval-suite.test.ts`

### Phase 8: Integration

1. Add package to monorepo workspace
2. Configure turbo.json for evaluation package
3. Create example golden dataset
4. Run full pipeline: `turbo run validate`

## Acceptance Criteria

- [ ] `packages/evaluation/` package created with correct workspace config
- [ ] `createAgentEval()` exported and runs eval cases against an agent
- [ ] Output matchers: exact, regex, semantic similarity, custom assertion
- [ ] Tool call matching: ordered sequence and unordered set
- [ ] `EvalReport` includes per-case results and summary statistics
- [ ] `compareEvalReports()` detects regressions and improvements
- [ ] Configurable regression thresholds (pass rate, cost, individual case)
- [ ] `loadDataset()` and `loadDatasets()` load JSON test cases
- [ ] `createLLMJudge()` provides LLM-based scoring with rubric
- [ ] `runEvalSuite()` returns exit code 0/1 for CI gating
- [ ] Timeout enforcement per case
- [ ] `maxSteps` and `maxCost` enforcement per case
- [ ] Concurrency control for parallel case execution
- [ ] At least one example golden dataset in `datasets/`
- [ ] 100% test coverage: `bun test --coverage packages/evaluation/`
- [ ] `turbo run validate` passes from monorepo root
- [ ] No new external dependencies
- [ ] All public functions have JSDoc descriptions

## Verification Commands

```bash
bun test packages/evaluation/                # All tests
bun test --coverage packages/evaluation/     # Coverage
turbo run check-types --filter=evaluation    # Type check
turbo run lint --filter=evaluation           # Lint
turbo run validate                           # Full pipeline
```

<promise>EVALUATION_FRAMEWORK_COMPLETE</promise>
<promise>EVALUATION_FRAMEWORK_FAILED</promise>
