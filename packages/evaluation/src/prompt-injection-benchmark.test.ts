import { join } from 'node:path';

import { describe, expect, it } from 'bun:test';
import { DEFAULT_PROMPT_INJECTION_TRIPWIRE_THRESHOLD, type InputDetector } from 'operative';
import type { PromptInjectionFixtureCase } from 'operative/test';

import { compareEvaluationReports } from './comparison';
import {
  benchmarkPromptInjectionConfigurations,
  benchmarkPromptInjectionDetector,
} from './prompt-injection-benchmark';
import type { EvaluationReport } from './types';

const rawBaselinePath = join(
  import.meta.dir,
  '../benchmarks/prompt-injection-benchmark-baseline-raw.json',
);
const gatedBaselinePath = join(
  import.meta.dir,
  '../benchmarks/prompt-injection-benchmark-baseline-gated.json',
);

async function loadBaseline(path: string): Promise<EvaluationReport> {
  return (await Bun.file(path).json()) as EvaluationReport;
}

function makeFixture(
  overrides: Partial<PromptInjectionFixtureCase> & { name: string },
): PromptInjectionFixtureCase {
  return { input: '', label: 'benign', source: 'test fixture', ...overrides };
}

/**
 * `compareEvaluationReports()` only compares case names present in both
 * reports — it silently ignores a case that was renamed, removed, or added,
 * since a matched-name gate can't see cases it never matched. This asserts
 * the case name *set* is unchanged first, so the fixture set itself stays
 * protected, not just the rates computed from whatever fixtures happen to
 * still be name-matched.
 */
function expectSameCaseNames(baseline: EvaluationReport, current: EvaluationReport): void {
  const baselineNames = baseline.cases.map((c) => c.name).sort();
  const currentNames = current.cases.map((c) => c.name).sort();
  expect(currentNames).toEqual(baselineNames);
}

describe('benchmarkPromptInjectionDetector', () => {
  it('scores a case as passing when triggered matches the attack label', async () => {
    const detector: InputDetector = {
      name: 'always-trigger',
      detect: () =>
        Promise.resolve({ triggered: true, confidence: 0.9, category: 'prompt-injection' }),
    };
    const fixtures = [makeFixture({ name: 'an attack', input: 'x', label: 'attack' })];

    const result = await benchmarkPromptInjectionDetector(detector, fixtures);

    expect(result.report.cases).toHaveLength(1);
    expect(result.report.cases[0]?.pass).toBe(true);
    expect(result.detectionRate).toBe(1);
    expect(result.falsePositiveRate).toBe(0);
  });

  it('scores a case as failing when the detector misses an attack (false negative)', async () => {
    const detector: InputDetector = {
      name: 'never-trigger',
      detect: () =>
        Promise.resolve({ triggered: false, confidence: 0, category: 'prompt-injection' }),
    };
    const fixtures = [makeFixture({ name: 'a missed attack', input: 'x', label: 'attack' })];

    const result = await benchmarkPromptInjectionDetector(detector, fixtures);

    expect(result.report.cases[0]?.pass).toBe(false);
    expect(result.detectionRate).toBe(0);
  });

  it('scores a case as failing when the detector fires on a benign control (false positive)', async () => {
    const detector: InputDetector = {
      name: 'always-trigger',
      detect: () =>
        Promise.resolve({ triggered: true, confidence: 0.9, category: 'prompt-injection' }),
    };
    const fixtures = [makeFixture({ name: 'a benign control', input: 'x', label: 'benign' })];

    const result = await benchmarkPromptInjectionDetector(detector, fixtures);

    expect(result.report.cases[0]?.pass).toBe(false);
    expect(result.falsePositiveRate).toBe(1);
  });

  it('scores a benign case as passing when the detector correctly stays silent (true negative)', async () => {
    const detector: InputDetector = {
      name: 'never-trigger',
      detect: () =>
        Promise.resolve({ triggered: false, confidence: 0, category: 'prompt-injection' }),
    };
    const fixtures = [makeFixture({ name: 'a benign control', input: 'x', label: 'benign' })];

    const result = await benchmarkPromptInjectionDetector(detector, fixtures);

    expect(result.report.cases[0]?.pass).toBe(true);
    expect(result.falsePositiveRate).toBe(0);
  });

  it('returns rate 0 for an empty attack or benign partition rather than NaN', async () => {
    const detector: InputDetector = {
      name: 'never-trigger',
      detect: () =>
        Promise.resolve({ triggered: false, confidence: 0, category: 'prompt-injection' }),
    };
    const onlyBenign = [makeFixture({ name: 'a benign control', input: 'x', label: 'benign' })];

    const result = await benchmarkPromptInjectionDetector(detector, onlyBenign);

    expect(result.detectionRate).toBe(0);
    expect(Number.isNaN(result.detectionRate)).toBe(false);
  });

  it('tags each case result with its ground-truth label', async () => {
    const detector: InputDetector = {
      name: 'never-trigger',
      detect: () =>
        Promise.resolve({ triggered: false, confidence: 0, category: 'prompt-injection' }),
    };
    const fixtures = [makeFixture({ name: 'a benign control', input: 'x', label: 'benign' })];

    const result = await benchmarkPromptInjectionDetector(detector, fixtures);

    expect(result.report.cases[0]?.tags).toEqual(['benign']);
  });
});

describe('benchmarkPromptInjectionConfigurations', () => {
  it('benchmarks both the raw detector and the gated preset over the same fixtures', async () => {
    const { raw, gated } = await benchmarkPromptInjectionConfigurations();

    expect(raw.report.cases.length).toBeGreaterThan(0);
    expect(gated.report.cases.length).toBe(raw.report.cases.length);
  });

  it('the gated preset never has a higher false-positive rate than the raw detector', async () => {
    // Gating at confidence >= threshold can only suppress triggers, never
    // add them, so it can only reduce or hold false positives steady
    // relative to raw.
    const { raw, gated } = await benchmarkPromptInjectionConfigurations();

    expect(gated.falsePositiveRate).toBeLessThanOrEqual(raw.falsePositiveRate);
  });

  it('the gated preset never has a higher detection rate than the raw detector', async () => {
    // Same reasoning in the other direction: gating can only suppress
    // triggers, so detection rate can only drop or hold steady.
    const { raw, gated } = await benchmarkPromptInjectionConfigurations();

    expect(gated.detectionRate).toBeLessThanOrEqual(raw.detectionRate);
  });

  it('gates at the same threshold as the AB-40 default preset', () => {
    expect(DEFAULT_PROMPT_INJECTION_TRIPWIRE_THRESHOLD).toBe(0.6);
  });
});

/**
 * CI regression gate (AB-44). Runs the benchmark deterministically (pure
 * regex matching, no LLM calls) and compares against a checked-in baseline
 * via `compareEvaluationReports()`. A regression here means a code change
 * silently made the detector (or the gated preset) worse at classifying the
 * fixture set — either missing an attack it used to catch, or firing on a
 * benign control it used to leave alone.
 *
 * The rate assertions below assert *bounds*, not the exact current values —
 * a detector improvement (catching a previously-missed attack, or dropping a
 * false positive) must not fail this suite just because the numbers moved in
 * the desirable direction. `compareEvaluationReports()` is what actually
 * gates regressions; the bounds here just keep this file honest as
 * documentation.
 *
 * Measured results as of this baseline (40 fixtures: 22 attack, 18 benign):
 *
 * | Configuration       | Detection rate | False-positive rate |
 * | -------------------- | -------------- | -------------------- |
 * | Raw detector          | 72.7% (16/22)  | 44.4% (8/18)          |
 * | Gated preset (>= 0.6) | 9.1% (2/22)    | 0.0% (0/18)           |
 *
 * The raw detector catches most direct-phrasing attacks but misses every
 * indirect/obfuscated attack in the fixture set (base64, homoglyphs,
 * translation, zero-width characters, paraphrase) — a naive regex matcher on
 * literal English phrasing was never going to catch those, and the fixture
 * set is deliberately honest about that gap rather than hiding it. Its false
 * positive rate is high (44.4%) because single-pattern matches like "act as"
 * or "you are now" are common in benign phrasing.
 *
 * The AB-40 gated preset (`withMinimumTripwireConfidence(...,
 * DEFAULT_PROMPT_INJECTION_TRIPWIRE_THRESHOLD)`) eliminates false positives
 * entirely on this fixture set, but at a steep cost: because most of the
 * fixture set's direct attacks are single-sentence and match only one
 * pattern group (confidence 0.3), gating to `>= 0.6` suppresses the
 * overwhelming majority of them too — only the two fixtures that stack
 * multiple pattern families in one message survive the gate. This is the
 * tradeoff `withMinimumTripwireConfidence` was documented to make (precision
 * over recall, since `mode: 'tripwire'` hard-halts the run on any trigger),
 * but the magnitude — losing over 90% of detections to buy a clean
 * false-positive rate — is worth calling out explicitly rather than assuming
 * the gate is "mostly fine."
 */
describe('prompt-injection detector regression gate', () => {
  it('raw detector: fixture set matches the checked-in baseline and has no regressions', async () => {
    const baseline = await loadBaseline(rawBaselinePath);
    const { raw } = await benchmarkPromptInjectionConfigurations();

    expectSameCaseNames(baseline, raw.report);

    const comparison = compareEvaluationReports(baseline, raw.report);
    expect(comparison.regressions).toEqual([]);
  });

  it('gated preset: fixture set matches the checked-in baseline and has no regressions', async () => {
    const baseline = await loadBaseline(gatedBaselinePath);
    const { gated } = await benchmarkPromptInjectionConfigurations();

    expectSameCaseNames(baseline, gated.report);

    const comparison = compareEvaluationReports(baseline, gated.report);
    expect(comparison.regressions).toEqual([]);
  });

  it('raw detector: detection and false-positive rates stay within documented bounds', async () => {
    const { raw } = await benchmarkPromptInjectionConfigurations();

    // >= documented baseline: an improvement (catching more attacks) must
    // not fail this test.
    expect(raw.detectionRate).toBeGreaterThanOrEqual(16 / 22);
    // <= documented baseline: an improvement (fewer false positives) must
    // not fail this test either.
    expect(raw.falsePositiveRate).toBeLessThanOrEqual(8 / 18);
  });

  it('gated preset: detection and false-positive rates stay within documented bounds', async () => {
    const { gated } = await benchmarkPromptInjectionConfigurations();

    expect(gated.detectionRate).toBeGreaterThanOrEqual(2 / 22);
    expect(gated.falsePositiveRate).toBeLessThanOrEqual(0);
  });
});
