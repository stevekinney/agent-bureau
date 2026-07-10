import {
  createPromptInjectionDetector,
  type DetectorContext,
  type InputDetector,
  withMinimumTripwireConfidence,
} from 'operative';
import { PROMPT_INJECTION_FIXTURES, type PromptInjectionFixtureCase } from 'operative/test';

import { computeSummary } from './create-agent-evaluation';
import type {
  EvaluationCaseResult,
  EvaluationReport,
  PromptInjectionBenchmarkComparison,
  PromptInjectionBenchmarkResult,
} from './types';

/**
 * AB-44 — no-LLM benchmark for `InputDetector` implementations (currently
 * `createPromptInjectionDetector`). Runs a labeled fixture set purely through
 * the detector's `detect()` function — no generate calls, no network,
 * deterministic — and reports both an `EvaluationReport` (so
 * `compareEvaluationReports()` can gate regressions the same way agent
 * evals do) and the two numbers that actually matter for a classifier:
 * detection rate (recall on attacks) and false-positive rate (on benign
 * controls).
 */

const BENCHMARK_CONTEXT: DetectorContext = {
  step: 1,
  conversationLength: 1,
  sessionTainted: false,
  provenance: 'user-input',
};

/**
 * Runs `detector` over every fixture in `fixtures`, scoring each case as a
 * pass when `result.triggered` matches the fixture's ground-truth label. A
 * "pass" is therefore a correct classification, not "the detector fired" —
 * that keeps `compareEvaluationReports()`'s pass-rate and
 * `failPreviouslyPassing` gates meaningful for both attack and benign cases.
 */
export async function benchmarkPromptInjectionDetector(
  detector: InputDetector,
  fixtures: readonly PromptInjectionFixtureCase[] = PROMPT_INJECTION_FIXTURES,
): Promise<PromptInjectionBenchmarkResult> {
  const cases: EvaluationCaseResult[] = [];

  let attackCount = 0;
  let truePositiveCount = 0;
  let benignCount = 0;
  let falsePositiveCount = 0;

  for (const fixture of fixtures) {
    const start = performance.now();
    const result = await detector.detect(fixture.input, BENCHMARK_CONTEXT);
    const duration = performance.now() - start;

    const expectedTriggered = fixture.label === 'attack';
    const pass = result.triggered === expectedTriggered;

    if (fixture.label === 'attack') {
      attackCount++;
      if (result.triggered) truePositiveCount++;
    } else {
      benignCount++;
      if (result.triggered) falsePositiveCount++;
    }

    cases.push({
      name: fixture.name,
      tags: [fixture.label],
      pass,
      score: pass ? 1 : 0,
      metrics: {
        outputMatch: pass,
        toolCallMatch: true,
        steps: 0,
        totalTokens: 0,
        duration,
        finishReason: 'stop-condition',
      },
    });
  }

  const report: EvaluationReport = {
    timestamp: new Date().toISOString(),
    cases,
    summary: computeSummary(cases),
  };

  return {
    report,
    detectionRate: attackCount > 0 ? truePositiveCount / attackCount : 0,
    falsePositiveRate: benignCount > 0 ? falsePositiveCount / benignCount : 0,
  };
}

/**
 * Confidence floor used by the AB-40 enabled-by-default guardrail preset
 * (`withMinimumTripwireConfidence(createPromptInjectionDetector(), 0.6)`).
 * Kept here (rather than re-imported) so this module documents the exact
 * value it benchmarks against.
 */
export const DEFAULT_PRESET_TRIPWIRE_THRESHOLD = 0.6;

/**
 * Benchmarks both the raw `createPromptInjectionDetector()` and the
 * confidence-gated configuration used by the default guardrail preset, over
 * the same fixture set, so their detection/false-positive tradeoff can be
 * compared directly.
 */
export async function benchmarkPromptInjectionConfigurations(
  fixtures: readonly PromptInjectionFixtureCase[] = PROMPT_INJECTION_FIXTURES,
): Promise<PromptInjectionBenchmarkComparison> {
  const raw = await benchmarkPromptInjectionDetector(createPromptInjectionDetector(), fixtures);
  const gatedDetector = withMinimumTripwireConfidence(
    createPromptInjectionDetector(),
    DEFAULT_PRESET_TRIPWIRE_THRESHOLD,
  );
  const gated = await benchmarkPromptInjectionDetector(gatedDetector, fixtures);

  return { raw, gated };
}
