import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { isEvaluationReport } from './run-evaluation-suite';
import type { EvaluationReport, EvaluationReportSummary } from './types';

/** Reduces a full report to the row shape a pass-rate/cost trend view needs. */
function summarize(path: string, report: EvaluationReport): EvaluationReportSummary {
  return {
    path,
    timestamp: report.timestamp,
    total: report.summary.total,
    passed: report.summary.passed,
    failed: report.summary.failed,
    passRate: report.summary.passRate,
    averageTokens: report.summary.averageTokens,
    averageDuration: report.summary.averageDuration,
  };
}

/**
 * Lists every evaluation report JSON file in `directory` and returns a
 * per-report summary (pass rate, token cost, duration) sorted oldest to
 * newest by `EvaluationReport.timestamp` — the aggregation a "reports over
 * time" trend view (e.g. the gateway's read-only evaluations page) reads
 * directly.
 *
 * A missing directory is treated as "no reports yet" and returns `[]` rather
 * than throwing — the directory may not exist until the first suite run
 * writes an `output` report into it. Files that parse but aren't a valid
 * `EvaluationReport` (validated via the same guard `runEvaluationSuite` uses
 * for baseline files) are skipped rather than failing the whole listing,
 * since a reports directory may accumulate unrelated files over time.
 *
 * Uses `node:fs/promises` rather than `Bun.Glob`/`Bun.file` — the gateway
 * this feeds also runs under a Node adapter (`GatewayOptions.runtime`), and
 * a Bun-only global would throw a ReferenceError on that path.
 */
export async function listEvaluationReports(directory: string): Promise<EvaluationReportSummary[]> {
  const directoryStats = await stat(directory).catch(() => undefined);
  if (!directoryStats?.isDirectory()) return [];

  const summaries: EvaluationReportSummary[] = [];
  const entries = await readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const filePath = join(directory, entry.name);

    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(filePath, 'utf-8'));
    } catch {
      continue;
    }

    if (!isEvaluationReport(parsed)) continue;

    summaries.push(summarize(filePath, parsed));
  }

  summaries.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return summaries;
}
