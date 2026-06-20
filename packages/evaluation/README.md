# Evaluation

`evaluation` is the behavior-testing layer for Agent Bureau agents. It gives the workspace a way to describe expected behavior, run agent cases, score results, and compare reports without mixing evaluation logic into the runtime packages.

## What It Does

- Defines evaluation suites, cases, assertions, reports, and comparison types.
- Runs agent cases through `createAgentEvaluation()` and `runEvaluationSuite()`.
- Provides exact, substring, regular expression, custom, semantic, and output matchers.
- Extracts common metrics such as step count and token usage.
- Checks expected tool calls in ordered or unordered sets via `matchToolCalls()`.
- Supports large language model judging through caller-provided judge configuration.
- Compares reports to identify regressions and improvements.

## How It Works

An evaluation case describes the input, optional agent configuration, and assertions that must be true after the run. The runner executes the case against the Agent Bureau runtime, collects the output and metrics, then applies matchers to produce an `EvaluationCaseResult`.

Suites aggregate those results into an `EvaluationReport`. `compareEvaluationReports()` then compares two reports with regression thresholds so behavior changes can be reviewed as structured data instead of free-form test logs.

## Project Role

`evaluation` sits outside the production request path. It depends on the public runtime surfaces from `operative`, `armorer`, and `conversationalist` so teams can verify the behavior of agents assembled from the same packages used by `gateway`.

## Quick Start

```typescript
import { createAgentEvaluation } from 'evaluation';

// `generate` and `toolbox` come from your operative/armorer setup.
const evaluation = createAgentEvaluation({
  cases: [
    {
      name: 'greeting',
      input: 'Say hello',
      expectedOutput: 'Hello!',
    },
    {
      name: 'search-called',
      input: 'Search for the weather in Denver',
      expectedToolCalls: [{ name: 'search' }],
    },
  ],
  agent: { generate, toolbox },
  concurrency: 2,
});

const report = await evaluation.run();
console.log(report.summary);
// { total: 2, passed: 1, failed: 1, passRate: 0.5, ... }
```

## Public API

### Runner

**`createAgentEvaluation(options)`:** Creates an evaluation runner for a fixed set of cases. Returns an object with a single `run()` method that executes all cases and returns an `EvaluationReport`.

```typescript
import { createAgentEvaluation } from 'evaluation';

const evaluation = createAgentEvaluation({
  cases: myEvaluationCases, // EvaluationCase[]
  agent: { generate, toolbox }, // or an AgentDefinition
  concurrency: 4, // default: 1
  embedder: myEmbedFunction, // required for SemanticMatcher cases
});

const report: EvaluationReport = await evaluation.run();
```

---

**`runEvaluationSuite(options)`:** Loads cases from JSON files, runs them, optionally compares against a baseline, and writes the report to disk. Returns an `EvaluationSuiteResult` with a CI-compatible `exitCode` (0 = pass, 1 = regression detected).

```typescript
import { runEvaluationSuite } from 'evaluation';

const { report, comparison, exitCode } = await runEvaluationSuite({
  datasets: 'datasets/*.json', // path, glob, or string[]
  agent: { generate, toolbox },
  baseline: 'reports/baseline.json', // optional
  output: 'reports/current.json', // optional
  thresholds: { passRateDrop: 0.1 }, // optional; default: 5% drop
  concurrency: 2,
  embedder: myEmbedFunction,
});

process.exit(exitCode);
```

---

**`loadDataset(path)`:** Loads a single JSON file as a validated array of `EvaluationCase` objects. Throws when the file is missing, contains invalid JSON, or any entry fails validation.

```typescript
import { loadDataset } from 'evaluation';

const cases = await loadDataset('datasets/greeting.json');
```

---

**`loadDatasets(pattern)`:** Loads all JSON files matching a glob pattern and merges them into a single array.

```typescript
import { loadDatasets } from 'evaluation';

const cases = await loadDatasets('datasets/**/*.json');
```

Dataset files must be JSON arrays where every object has at least `name` (string) and `input` (string). `RegExp` matchers cannot be serialized to JSON—add them programmatically after loading.

---

### Matchers

Matchers are lower-level utilities that power the assertion logic inside `createAgentEvaluation()`. You can call them directly to build custom assertion functions or use them in one-off checks.

**`matchExact(actual, expected)`:** Returns `MatchResult` with `pass: true` when `actual === expected` (case-sensitive).

```typescript
import { matchExact } from 'evaluation';

const result = matchExact('Hello!', 'Hello!');
// { pass: true, score: 1, message: 'Output matched exactly: "Hello!"' }
```

---

**`matchSubstring(actual, substring)`:** Returns `MatchResult` with `pass: true` when `actual` contains `substring`.

```typescript
import { matchSubstring } from 'evaluation';

const result = matchSubstring('Hello, world!', 'world');
// { pass: true, score: 1, message: 'Output contains substring: "world"' }
```

---

**`matchRegex(actual, pattern)`:** Returns `MatchResult` with `pass: true` when `actual` matches `pattern`.

```typescript
import { matchRegex } from 'evaluation';

const result = matchRegex('Error: timeout', /^Error:/);
// { pass: true, score: 1, message: 'Output matched pattern: /^Error:/' }
```

---

**`matchSemantic(actual, matcher, embedder)`:** Compares `actual` against `matcher.reference` using cosine similarity. Returns `MatchResult` with `score` equal to the similarity value. Requires an `EmbedderFunction`.

```typescript
import { matchSemantic } from 'evaluation';

const result = await matchSemantic(
  'TypeScript adds types to JavaScript',
  { type: 'semantic', reference: 'TypeScript is a typed superset of JavaScript', threshold: 0.8 },
  myEmbedFunction,
);
// { pass: true, score: 0.94, message: 'Semantic similarity 0.940 meets threshold 0.8' }
```

---

**`matchCustomAssertion(runResult, assertFn)`:** Runs a caller-supplied assertion function against the full `RunResult` and normalizes the output into a `MatchResult`. Catches thrown errors and converts them to a failed result.

```typescript
import { matchCustomAssertion } from 'evaluation';

const result = matchCustomAssertion(runResult, (r) => ({
  pass: r.content.length < 500,
  message: 'Response was concise',
  score: r.content.length < 200 ? 1 : 0.5,
}));
```

---

**`matchOutput(runResult, evaluationCase, embedder?)`:** Internal dispatcher used by the runner—chooses `matchExact`, `matchRegex`, `matchSemantic`, or `matchCustomAssertion` based on `evaluationCase.expectedOutput` and `evaluationCase.assert`. Exported for use in custom runners.

---

### Metrics

**`extractStepCount(result)`:** Returns the number of steps the agent took during a run.

```typescript
import { extractStepCount } from 'evaluation';

const steps = extractStepCount(runResult); // number
```

---

**`extractTokenUsage(result)`:** Returns the `TokenUsage` object (`{ prompt, completion, total }`) from a `RunResult`, filling in zeros for any missing fields.

```typescript
import { extractTokenUsage } from 'evaluation';

const { prompt, completion, total } = extractTokenUsage(runResult);
```

---

**`matchToolCalls(result, expected)`:** Returns `true` when all expected tool calls appear in the run. Uses ordered matching when any `ExpectedToolCall` has an `index`; falls back to unordered set membership otherwise. Returns `true` when `expected` is `undefined` or empty.

```typescript
import { matchToolCalls } from 'evaluation';

const passed = matchToolCalls(runResult, [
  { name: 'search', index: 0 }, // must be the first call
  { name: 'summarize' }, // can appear anywhere
  { name: 'fetch', arguments: { url: 'https://example.com' } }, // args checked
]);
```

---

### Judge

**`createLLMJudge(options)`:** Creates an LLM-as-judge scoring function. The returned function accepts `(input, output, reference?)` and returns `Promise<LLMJudgeResult>`. The judge model is called with a structured rubric prompt; its JSON response is parsed into a score and reasoning. If parsing fails or the model throws, `score` is `0` with an error message in `reasoning`.

```typescript
import { createLLMJudge } from 'evaluation';

const judge = createLLMJudge({
  judge: generateFunction, // any GenerateFunction — can be a cheaper model
  rubric: 'Rate factual accuracy and completeness.',
  scale: { min: 1, max: 5 }, // default: { min: 1, max: 5 }
});

const { score, reasoning } = await judge(
  'What is TypeScript?',
  'TypeScript is a typed superset of JavaScript.',
  'TypeScript adds optional static typing to JavaScript.', // optional reference
);
// score: 4, reasoning: 'Accurate and reasonably complete...'
```

The `assert` callback is **synchronous** — `(result: RunResult) => EvaluationAssertion` — so it cannot `await` an LLM judge directly. Use it for deterministic checks on the run result:

```typescript
const factualCase: EvaluationCase = {
  name: 'mentions-types',
  input: 'Explain TypeScript in one sentence.',
  assert: (runResult) => ({
    pass: runResult.content.toLowerCase().includes('type'),
    score: runResult.content.length > 0 ? 1 : 0,
  }),
};
```

For LLM-based scoring inside a suite, wire the judge through a semantic `expectedOutput` matcher instead, which the runner evaluates asynchronously:

```typescript
const semanticCase: EvaluationCase = {
  name: 'factual-accuracy',
  input: 'Explain TypeScript in one sentence.',
  expectedOutput: {
    type: 'semantic',
    reference: 'TypeScript is a typed superset of JavaScript.',
    threshold: 0.8,
  },
};
```

---

### Comparison

**`compareEvaluationReports(baseline, current, thresholds?)`:** Compares two `EvaluationReport` objects and returns an `EvaluationComparison` listing regressions, improvements, and unchanged cases.

Default thresholds:

- Pass rate drop > 5% is a regression (`passRateDrop: 0.05`).
- Total token cost increase > 20% is a regression (`costIncrease: 0.2`).
- Any previously-passing case that now fails is a regression (`failPreviouslyPassing: true`).

```typescript
import { compareEvaluationReports } from 'evaluation';

const comparison = compareEvaluationReports(baselineReport, currentReport, {
  passRateDrop: 0.1, // allow up to 10% pass rate drop
  costIncrease: 0.3, // allow up to 30% token cost increase
  failPreviouslyPassing: true,
});

if (comparison.regressions.length > 0) {
  console.error('Regressions detected:', comparison.regressions);
}
```

---

## Types

### `EvaluationCase`

The unit of evaluation—defines what to send and how to judge the response.

```typescript
type EvaluationCase = {
  name: string;
  input: string;
  systemPrompt?: string;
  expectedOutput?: string | RegExp | SemanticMatcher;
  expectedToolCalls?: ExpectedToolCall[];
  maxSteps?: number;
  assert?: (result: RunResult) => EvaluationAssertion;
  tags?: string[];
  timeout?: number; // ms, default: 30_000
};
```

### `EvaluationReport`

The output of a single evaluation run.

```typescript
type EvaluationReport = {
  timestamp: string; // ISO 8601
  cases: EvaluationCaseResult[];
  summary: {
    total: number;
    passed: number;
    failed: number;
    passRate: number;
    averageScore: number;
    averageSteps: number;
    averageTokens: number;
    averageDuration: number; // ms
  };
};
```

### `EvaluationCaseResult`

Per-case outcome, metrics, and optional error.

```typescript
type EvaluationCaseResult = {
  name: string;
  tags: string[];
  pass: boolean;
  score: number; // 0–1
  metrics: {
    outputMatch: boolean;
    toolCallMatch: boolean;
    steps: number;
    totalTokens: number;
    duration: number; // ms
    finishReason: FinishReason;
  };
  error?: string;
};
```

### `SemanticMatcher`

```typescript
type SemanticMatcher = {
  type: 'semantic';
  reference: string;
  threshold: number; // cosine similarity, 0–1
};
```

### `ExpectedToolCall`

```typescript
type ExpectedToolCall = {
  name: string;
  arguments?: Record<string, unknown>; // deep-equality checked when present
  index?: number; // position in the call sequence; undefined = any position
};
```

### `EvaluationComparison`

```typescript
type EvaluationComparison = {
  baseline: EvaluationReport;
  current: EvaluationReport;
  regressions: EvaluationChange[];
  improvements: EvaluationChange[];
  unchanged: string[]; // case names
};
```

### `EvaluationChange`

```typescript
type EvaluationChange = {
  caseName: string; // or 'summary' for aggregate metrics
  metric: string; // e.g. 'pass', 'passRate', 'costIncrease'
  baseline: number;
  current: number;
  delta: number; // current - baseline
};
```

### `RegressionThresholds`

```typescript
type RegressionThresholds = {
  passRateDrop?: number; // default: 0.05
  costIncrease?: number; // default: 0.2
  failPreviouslyPassing?: boolean; // default: true
};
```

### `MatchResult`

```typescript
type MatchResult = {
  pass: boolean;
  score: number; // 0–1
  message: string;
};
```

### `EvaluationAssertion`

Returned by a case's `assert` callback.

```typescript
type EvaluationAssertion = {
  pass: boolean;
  message?: string;
  score?: number; // 0–1; defaults to 1 when pass, 0 when fail
};
```

### `LLMJudgeOptions` / `LLMJudgeResult`

```typescript
type LLMJudgeOptions = {
  judge: GenerateFunction;
  rubric: string;
  scale?: { min: number; max: number }; // default: { min: 1, max: 5 }
};

type LLMJudgeResult = {
  score: number;
  reasoning: string;
};
```

### `EvaluationAgentConfiguration`

Either an `AgentDefinition` (from `operative`) or a bare `{ generate, toolbox }` pair.

```typescript
type EvaluationAgentConfiguration =
  | AgentDefinition
  | { generate: GenerateFunction; toolbox: Toolbox };
```

### `EmbedderFunction`

```typescript
type EmbedderFunction = (text: string) => Promise<number[]>;
```

---

## Development

Run package checks from this directory:

```bash
bun run validate
bun run build
```
