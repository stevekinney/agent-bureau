import { rmSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'bun:test';

import { listEvaluationReports } from './reports';
import type { EvaluationReport } from './types';

const fixturesDirectory = join(import.meta.dir, '__reports-fixtures__');

function fixturePath(name: string): string {
  return join(fixturesDirectory, name);
}

function makeReport(overrides: Partial<EvaluationReport> = {}): EvaluationReport {
  return {
    timestamp: '2026-01-01T00:00:00.000Z',
    cases: [],
    summary: {
      total: 10,
      passed: 8,
      failed: 2,
      passRate: 0.8,
      averageScore: 0.8,
      averageSteps: 3,
      averageTokens: 500,
      averageDuration: 1200,
    },
    ...overrides,
  };
}

afterEach(() => {
  try {
    rmSync(fixturesDirectory, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
});

describe('listEvaluationReports', () => {
  it('returns an empty array when the directory does not exist', async () => {
    const summaries = await listEvaluationReports(fixturePath('does-not-exist'));
    expect(summaries).toEqual([]);
  });

  it('returns an empty array for an existing but empty directory', async () => {
    await Bun.write(fixturePath('empty/.gitkeep'), '');
    const summaries = await listEvaluationReports(fixturePath('empty'));
    expect(summaries).toEqual([]);
  });

  it('summarizes a single report into pass-rate and cost fields', async () => {
    await Bun.write(
      fixturePath('single/report.json'),
      JSON.stringify(makeReport({ timestamp: '2026-01-01T00:00:00.000Z' })),
    );

    const summaries = await listEvaluationReports(fixturePath('single'));

    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      timestamp: '2026-01-01T00:00:00.000Z',
      total: 10,
      passed: 8,
      failed: 2,
      passRate: 0.8,
      averageTokens: 500,
      averageDuration: 1200,
    });
    expect(summaries[0]!.path).toContain('report.json');
  });

  it('aggregates multiple reports sorted oldest to newest by timestamp', async () => {
    await Bun.write(
      fixturePath('trend/c.json'),
      JSON.stringify(
        makeReport({
          timestamp: '2026-01-03T00:00:00.000Z',
          summary: { ...makeReport().summary, passRate: 0.6 },
        }),
      ),
    );
    await Bun.write(
      fixturePath('trend/a.json'),
      JSON.stringify(
        makeReport({
          timestamp: '2026-01-01T00:00:00.000Z',
          summary: { ...makeReport().summary, passRate: 0.9 },
        }),
      ),
    );
    await Bun.write(
      fixturePath('trend/b.json'),
      JSON.stringify(
        makeReport({
          timestamp: '2026-01-02T00:00:00.000Z',
          summary: { ...makeReport().summary, passRate: 0.75 },
        }),
      ),
    );

    const summaries = await listEvaluationReports(fixturePath('trend'));

    expect(summaries.map((s) => s.timestamp)).toEqual([
      '2026-01-01T00:00:00.000Z',
      '2026-01-02T00:00:00.000Z',
      '2026-01-03T00:00:00.000Z',
    ]);
    expect(summaries.map((s) => s.passRate)).toEqual([0.9, 0.75, 0.6]);
  });

  it('skips files that are not valid EvaluationReport JSON', async () => {
    await Bun.write(fixturePath('mixed/valid.json'), JSON.stringify(makeReport()));
    await Bun.write(fixturePath('mixed/not-a-report.json'), JSON.stringify({ hello: 'world' }));
    await Bun.write(fixturePath('mixed/invalid.json'), '{ not valid json');

    const summaries = await listEvaluationReports(fixturePath('mixed'));

    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.path).toContain('valid.json');
  });

  it('ignores non-JSON files in the directory', async () => {
    await Bun.write(fixturePath('mixed-ext/report.json'), JSON.stringify(makeReport()));
    await Bun.write(fixturePath('mixed-ext/notes.txt'), 'not a report');

    const summaries = await listEvaluationReports(fixturePath('mixed-ext'));

    expect(summaries).toHaveLength(1);
  });

  it('skips a file whose summary is a broadly-shaped object rather than a real EvaluationReportSummary', async () => {
    // { timestamp, cases: [], summary: {} } — an unrelated file that happens
    // to share the top-level keys but has no numeric summary fields. Without
    // validating the summary's fields, this would push undefined/NaN totals,
    // pass rates, and token averages into the returned summaries.
    await Bun.write(fixturePath('bad-summary/valid.json'), JSON.stringify(makeReport()));
    await Bun.write(
      fixturePath('bad-summary/broad.json'),
      JSON.stringify({ timestamp: '2026-01-02T00:00:00.000Z', cases: [], summary: {} }),
    );

    const summaries = await listEvaluationReports(fixturePath('bad-summary'));

    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.path).toContain('valid.json');
    expect(summaries.every((s) => Number.isFinite(s.total) && Number.isFinite(s.passRate))).toBe(
      true,
    );
  });

  it('skips a report whose summary has a non-finite numeric field (NaN/Infinity)', async () => {
    await Bun.write(fixturePath('nan-summary/valid.json'), JSON.stringify(makeReport()));
    await Bun.write(
      fixturePath('nan-summary/nan.json'),
      JSON.stringify(makeReport({ summary: { ...makeReport().summary, passRate: NaN } })),
    );

    const summaries = await listEvaluationReports(fixturePath('nan-summary'));

    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.path).toContain('valid.json');
  });
});
