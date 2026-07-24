import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import type { GenerateResponse } from '@lostgradient/operative';
import { createMockGenerate } from '@lostgradient/operative/test';
import { createTestToolbox } from 'armorer/test';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { runEvaluationSuite } from './run-evaluation-suite';
import type { EvaluationReport } from './types';

const fixturesDirectory = join(import.meta.dir, '__suite-test-fixtures__');

function fixturePath(name: string): string {
  return join(fixturesDirectory, name);
}

function singleResponse(
  content: string,
  toolCalls: GenerateResponse['toolCalls'] = [],
): GenerateResponse {
  return { content, toolCalls, usage: { prompt: 10, completion: 5, total: 15 } };
}

beforeEach(async () => {
  await Bun.write(
    fixturePath('suite-cases.json'),
    JSON.stringify([
      { name: 'case-1', input: 'Say hello', expectedOutput: 'Hello!' },
      { name: 'case-2', input: 'Say goodbye', expectedOutput: 'Goodbye!' },
    ]),
  );

  await Bun.write(
    fixturePath('extra-cases.json'),
    JSON.stringify([{ name: 'case-3', input: 'Say thanks' }]),
  );
});

afterEach(() => {
  try {
    rmSync(fixturesDirectory, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
});

describe('runEvaluationSuite', () => {
  it('loads datasets and runs all cases', async () => {
    const generate = createMockGenerate([singleResponse('Hello!'), singleResponse('Goodbye!')]);
    const toolbox = createTestToolbox([]);

    const result = await runEvaluationSuite({
      datasets: fixturePath('suite-cases.json'),
      agent: { generate, toolbox },
    });

    expect(result.report.cases).toHaveLength(2);
    expect(result.report.cases[0]!.name).toBe('case-1');
    expect(result.report.cases[1]!.name).toBe('case-2');
  });

  it('accepts an array of dataset paths', async () => {
    const generate = createMockGenerate([
      singleResponse('Hello!'),
      singleResponse('Goodbye!'),
      singleResponse('Thanks!'),
    ]);
    const toolbox = createTestToolbox([]);

    const result = await runEvaluationSuite({
      datasets: [fixturePath('suite-cases.json'), fixturePath('extra-cases.json')],
      agent: { generate, toolbox },
    });

    expect(result.report.cases).toHaveLength(3);
  });

  it('writes the report JSON to the output path', async () => {
    const generate = createMockGenerate([singleResponse('Hello!'), singleResponse('Goodbye!')]);
    const toolbox = createTestToolbox([]);
    const outputPath = fixturePath('output-report.json');

    await runEvaluationSuite({
      datasets: fixturePath('suite-cases.json'),
      agent: { generate, toolbox },
      output: outputPath,
    });

    expect(existsSync(outputPath)).toBe(true);

    const written = await Bun.file(outputPath).json();
    expect(written).toHaveProperty('timestamp');
    expect(written).toHaveProperty('cases');
    expect(written).toHaveProperty('summary');
  });

  it('returns exit code 0 when no regressions are detected', async () => {
    const generate = createMockGenerate([singleResponse('Hello!'), singleResponse('Goodbye!')]);
    const toolbox = createTestToolbox([]);

    const result = await runEvaluationSuite({
      datasets: fixturePath('suite-cases.json'),
      agent: { generate, toolbox },
    });

    expect(result.exitCode).toBe(0);
  });

  it('returns exit code 1 when a regression is detected against the baseline', async () => {
    // Baseline: both cases pass
    const baselineReport: EvaluationReport = {
      timestamp: new Date().toISOString(),
      cases: [
        {
          name: 'case-1',
          tags: [],
          pass: true,
          score: 1,
          metrics: {
            outputMatch: true,
            toolCallMatch: true,
            steps: 1,
            totalTokens: 15,
            duration: 100,
            finishReason: 'stop-condition',
          },
        },
        {
          name: 'case-2',
          tags: [],
          pass: true,
          score: 1,
          metrics: {
            outputMatch: true,
            toolCallMatch: true,
            steps: 1,
            totalTokens: 15,
            duration: 100,
            finishReason: 'stop-condition',
          },
        },
      ],
      summary: {
        total: 2,
        passed: 2,
        failed: 0,
        passRate: 1,
        averageScore: 1,
        averageSteps: 1,
        averageTokens: 15,
        averageDuration: 100,
      },
    };

    const baselinePath = fixturePath('baseline.json');
    await Bun.write(baselinePath, JSON.stringify(baselineReport));

    // Current run: first case passes, second fails (wrong output)
    const generate = createMockGenerate([singleResponse('Hello!'), singleResponse('Wrong!')]);
    const toolbox = createTestToolbox([]);

    const result = await runEvaluationSuite({
      datasets: fixturePath('suite-cases.json'),
      agent: { generate, toolbox },
      baseline: baselinePath,
    });

    expect(result.exitCode).toBe(1);
    expect(result.comparison).toBeDefined();
    expect(result.comparison!.regressions.length).toBeGreaterThan(0);
  });

  it('skips comparison when no baseline is provided', async () => {
    const generate = createMockGenerate([singleResponse('Hello!'), singleResponse('Goodbye!')]);
    const toolbox = createTestToolbox([]);

    const result = await runEvaluationSuite({
      datasets: fixturePath('suite-cases.json'),
      agent: { generate, toolbox },
    });

    expect(result.comparison).toBeUndefined();
  });

  it('compares against baseline and reports improvements', async () => {
    // Baseline: second case fails
    const baselineReport: EvaluationReport = {
      timestamp: new Date().toISOString(),
      cases: [
        {
          name: 'case-1',
          tags: [],
          pass: true,
          score: 1,
          metrics: {
            outputMatch: true,
            toolCallMatch: true,
            steps: 1,
            totalTokens: 15,
            duration: 100,
            finishReason: 'stop-condition',
          },
        },
        {
          name: 'case-2',
          tags: [],
          pass: false,
          score: 0,
          metrics: {
            outputMatch: false,
            toolCallMatch: true,
            steps: 1,
            totalTokens: 15,
            duration: 100,
            finishReason: 'stop-condition',
          },
        },
      ],
      summary: {
        total: 2,
        passed: 1,
        failed: 1,
        passRate: 0.5,
        averageScore: 0.5,
        averageSteps: 1,
        averageTokens: 15,
        averageDuration: 100,
      },
    };

    const baselinePath = fixturePath('baseline-improve.json');
    await Bun.write(baselinePath, JSON.stringify(baselineReport));

    // Current run: both cases pass
    const generate = createMockGenerate([singleResponse('Hello!'), singleResponse('Goodbye!')]);
    const toolbox = createTestToolbox([]);

    const result = await runEvaluationSuite({
      datasets: fixturePath('suite-cases.json'),
      agent: { generate, toolbox },
      baseline: baselinePath,
    });

    expect(result.exitCode).toBe(0);
    expect(result.comparison).toBeDefined();
    expect(result.comparison!.improvements.length).toBeGreaterThan(0);
  });

  it('passes concurrency through to the evaluation runner', async () => {
    const generate = createMockGenerate([singleResponse('Hello!'), singleResponse('Goodbye!')]);
    const toolbox = createTestToolbox([]);

    const result = await runEvaluationSuite({
      datasets: fixturePath('suite-cases.json'),
      agent: { generate, toolbox },
      concurrency: 2,
    });

    // Should still produce correct results — concurrency doesn't change semantics
    expect(result.report.cases).toHaveLength(2);
    expect(result.exitCode).toBe(0);
  });

  it('throws when the baseline file contains invalid data', async () => {
    const generate = createMockGenerate([singleResponse('Hello!'), singleResponse('Goodbye!')]);
    const toolbox = createTestToolbox([]);
    const invalidBaselinePath = fixturePath('invalid-baseline.json');
    await Bun.write(invalidBaselinePath, JSON.stringify({ not: 'a report' }));

    try {
      await runEvaluationSuite({
        datasets: fixturePath('suite-cases.json'),
        agent: { generate, toolbox },
        baseline: invalidBaselinePath,
      });
      expect.unreachable('Expected runEvaluationSuite to throw');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/valid.*EvaluationReport/i);
    }
  });

  it('throws when the baseline file does not exist', async () => {
    const generate = createMockGenerate([singleResponse('Hello!'), singleResponse('Goodbye!')]);
    const toolbox = createTestToolbox([]);

    try {
      await runEvaluationSuite({
        datasets: fixturePath('suite-cases.json'),
        agent: { generate, toolbox },
        baseline: fixturePath('missing-baseline.json'),
      });
      expect.unreachable('Expected runEvaluationSuite to throw');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/baseline report file not found/i);
    }
  });

  it('throws when the baseline file contains invalid JSON', async () => {
    const generate = createMockGenerate([singleResponse('Hello!'), singleResponse('Goodbye!')]);
    const toolbox = createTestToolbox([]);
    const invalidBaselinePath = fixturePath('invalid-json-baseline.json');
    await Bun.write(invalidBaselinePath, '{ this is not valid json }');

    try {
      await runEvaluationSuite({
        datasets: fixturePath('suite-cases.json'),
        agent: { generate, toolbox },
        baseline: invalidBaselinePath,
      });
      expect.unreachable('Expected runEvaluationSuite to throw');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/invalid json in baseline file/i);
    }
  });
});
