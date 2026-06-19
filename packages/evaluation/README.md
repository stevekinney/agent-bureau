# Evaluation

`evaluation` is the behavior-testing layer for Agent Bureau agents. It gives the workspace a way to describe expected behavior, run agent cases, score results, and compare reports without mixing evaluation logic into the runtime packages.

## What It Does

- Defines evaluation suites, cases, assertions, reports, and comparison types.
- Runs agent cases through `createAgentEvaluation()` and `runEvaluationSuite()`.
- Provides exact, substring, regular expression, custom, semantic, and output matchers.
- Extracts common metrics such as step count, token usage, and expected tool calls.
- Supports large language model judging through caller-provided judge configuration.
- Compares reports to identify regressions and improvements.

## How It Works

An evaluation case describes the input, optional agent configuration, and assertions that must be true after the run. The runner executes the case against the Agent Bureau runtime, collects the output and metrics, then applies matchers to produce an `EvaluationCaseResult`.

Suites aggregate those results into an `EvaluationReport`. `compareEvaluationReports()` then compares two reports with regression thresholds so behavior changes can be reviewed as structured data instead of free-form test logs.

## Project Role

`evaluation` sits outside the production request path. It depends on the public runtime surfaces from `operative`, `armorer`, and `conversationalist` so teams can verify the behavior of agents assembled from the same packages used by `gateway`.

## Public Entry Points

- `createAgentEvaluation()`
- `runEvaluationSuite()`
- `loadDataset()` and `loadDatasets()`
- Matchers such as `matchExact()`, `matchSubstring()`, `matchRegex()`, `matchSemantic()`, and `matchToolCalls()`
- Metrics such as `extractStepCount()` and `extractTokenUsage()`
- `createLLMJudge()`
- `compareEvaluationReports()`

## Development

Run package checks from this directory:

```bash
bun run validate
bun run build
```
