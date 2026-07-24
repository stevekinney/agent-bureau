<script lang="ts">
  import { EmptyState } from '@lostgradient/cinder/empty-state';
  import { LineChart } from '@lostgradient/cinder/line-chart';
  import { PageHeader } from '@lostgradient/cinder/page-header';
  import { SectionHeading } from '@lostgradient/cinder/section-heading';
  import { Table } from '@lostgradient/cinder/table';
  import { TableBody } from '@lostgradient/cinder/table-body';
  import { TableCell } from '@lostgradient/cinder/table-cell';
  import { TableHeader } from '@lostgradient/cinder/table-header';
  import { TableHeaderCell } from '@lostgradient/cinder/table-header-cell';
  import { TableRow } from '@lostgradient/cinder/table-row';

  import type { EvaluationReportsResponse } from '../../types';

  /**
   * Evaluations page. Read-only v1: renders eval report history (written by
   * `runEvaluationSuite`'s `output` option into the gateway's configured
   * `evaluationReportsDirectory`) as a pass-rate trend, a cost trend, and a
   * table of every report. Purely presentational — `evaluations` is injected
   * by the server (`GET /evaluations` reads `listEvaluationReports()`), no
   * client fetch, no state, no effects.
   *
   * Pass rate (0-1) and token cost (0-N thousand) are plotted as two separate
   * charts rather than sharing an axis — the scales aren't comparable.
   */
  let { evaluations }: { evaluations: EvaluationReportsResponse } = $props();

  let hasReports = $derived(evaluations.reports.length > 0);

  let passRateSeries = $derived([
    {
      id: 'pass-rate',
      label: 'Pass rate',
      data: evaluations.reports.map((report) => ({
        x: report.timestamp,
        y: report.passRate,
      })),
    },
  ]);

  let costSeries = $derived([
    {
      id: 'average-tokens',
      label: 'Average tokens per case',
      data: evaluations.reports.map((report) => ({
        x: report.timestamp,
        y: report.averageTokens,
      })),
    },
  ]);

  function formatPercent(value: number): string {
    return `${(value * 100).toFixed(1)}%`;
  }
</script>

<main class="page-evaluations">
  <PageHeader title="Evaluations" />

  {#if !hasReports}
    <EmptyState
      title="No evaluation reports yet."
      description="Run an evaluation suite with an `output` path inside the configured reports directory to see pass-rate and cost trends here."
    />
  {:else}
    <section>
      <SectionHeading level={2} title="Pass rate over time" />
      <LineChart
        label="Pass rate over time"
        series={passRateSeries}
        yAxis={{ label: 'Pass rate' }}
      />
    </section>

    <section>
      <SectionHeading level={2} title="Average token cost over time" />
      <LineChart
        label="Average token cost over time"
        series={costSeries}
        yAxis={{ label: 'Average tokens' }}
      />
    </section>

    <section>
      <SectionHeading level={2} title="Reports" />
      <Table caption="Evaluation reports">
        <TableHeader>
          <TableRow>
            <TableHeaderCell>Timestamp</TableHeaderCell>
            <TableHeaderCell align="right">Total</TableHeaderCell>
            <TableHeaderCell align="right">Passed</TableHeaderCell>
            <TableHeaderCell align="right">Failed</TableHeaderCell>
            <TableHeaderCell align="right">Pass Rate</TableHeaderCell>
            <TableHeaderCell align="right">Avg Tokens</TableHeaderCell>
            <TableHeaderCell align="right">Avg Duration (ms)</TableHeaderCell>
          </TableRow>
        </TableHeader>
        <TableBody>
          {#each evaluations.reports as report (report.path)}
            <TableRow>
              <TableCell>{report.timestamp}</TableCell>
              <TableCell align="right">{report.total}</TableCell>
              <TableCell align="right">{report.passed}</TableCell>
              <TableCell align="right">{report.failed}</TableCell>
              <TableCell align="right">{formatPercent(report.passRate)}</TableCell>
              <TableCell align="right">{Math.round(report.averageTokens)}</TableCell>
              <TableCell align="right">{Math.round(report.averageDuration)}</TableCell>
            </TableRow>
          {/each}
        </TableBody>
      </Table>
    </section>
  {/if}
</main>
