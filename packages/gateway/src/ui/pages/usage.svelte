<script lang="ts">
  import { EmptyState } from '@lostgradient/cinder/empty-state';
  import { SectionHeading } from '@lostgradient/cinder/section-heading';
  import { Stat } from '@lostgradient/cinder/stat';
  import { StatGroup } from '@lostgradient/cinder/stat-group';
  import { Table } from '@lostgradient/cinder/table';
  import { TableBody } from '@lostgradient/cinder/table-body';
  import { TableCell } from '@lostgradient/cinder/table-cell';
  import { TableHeader } from '@lostgradient/cinder/table-header';
  import { TableHeaderCell } from '@lostgradient/cinder/table-header-cell';
  import { TableRow } from '@lostgradient/cinder/table-row';

  import type { UsageAggregate, UsageGroupTotals, UsageResponse } from '../../routes/usage';

  /**
   * Usage & cost analytics page (AB-54). Purely presentational, read-only v1:
   * it reads the server-computed {@link UsageResponse} (grouped by agent,
   * authenticated principal, and UTC day) injected under the canonical
   * `usage` key in `window.__INITIAL_DATA__`. No client fetch, no state, no
   * effects — mirrors the configuration page's SSR-only pattern.
   *
   * `totalCost`/per-group `cost` are estimates derived from a static pricing
   * table (see `operative`'s `estimateCost`) — never a source of billing
   * truth. A group whose `costComplete` is `false` had at least one run with
   * no pricing entry for the configured model, so its cost total is a floor,
   * not the true total; the table renders a "+" suffix to signal that.
   */
  let { usage }: { usage: UsageResponse } = $props();

  const costFormatter = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  });

  function formatCost(totals: UsageAggregate | UsageGroupTotals): string {
    const formatted = costFormatter.format(totals.totalCost);
    return totals.costComplete ? formatted : `${formatted}+`;
  }

  let hasCacheActivity = $derived(
    usage.aggregate.cacheCreationTokens > 0 || usage.aggregate.cacheReadTokens > 0,
  );
</script>

<main class="page-usage">
  <SectionHeading level={2} title="Usage & Cost" />

  {#if usage.aggregate.runCount === 0}
    <EmptyState
      title="No usage recorded yet."
      description="Token usage and estimated cost will appear here once runs complete."
    />
  {:else}
    <StatGroup columns="auto" variant="cards" label="Usage totals">
      <Stat label="Runs" value={usage.aggregate.runCount} />
      <Stat label="Prompt Tokens" value={usage.aggregate.promptTokens} />
      <Stat label="Completion Tokens" value={usage.aggregate.completionTokens} />
      <Stat label="Total Tokens" value={usage.aggregate.totalTokens} />
      {#if hasCacheActivity}
        <Stat label="Cache Write Tokens" value={usage.aggregate.cacheCreationTokens} />
        <Stat label="Cache Read Tokens" value={usage.aggregate.cacheReadTokens} />
      {/if}
      <Stat label="Estimated Cost" value={formatCost(usage.aggregate)} />
    </StatGroup>

    <section>
      <SectionHeading level={3} title="By Agent" />
      <Table caption="Usage by agent">
        <TableHeader>
          <TableRow>
            <TableHeaderCell>Agent</TableHeaderCell>
            <TableHeaderCell align="right">Runs</TableHeaderCell>
            <TableHeaderCell align="right">Total Tokens</TableHeaderCell>
            <TableHeaderCell align="right">Estimated Cost</TableHeaderCell>
          </TableRow>
        </TableHeader>
        <TableBody>
          {#each usage.analytics.byAgent as group (group.key)}
            <TableRow>
              <TableCell>{group.key}</TableCell>
              <TableCell align="right">{group.runCount}</TableCell>
              <TableCell align="right">{group.totalTokens}</TableCell>
              <TableCell align="right">{formatCost(group)}</TableCell>
            </TableRow>
          {/each}
        </TableBody>
      </Table>
    </section>

    <section>
      <SectionHeading level={3} title="By Principal" />
      <Table caption="Usage by authenticated principal">
        <TableHeader>
          <TableRow>
            <TableHeaderCell>Principal</TableHeaderCell>
            <TableHeaderCell align="right">Runs</TableHeaderCell>
            <TableHeaderCell align="right">Total Tokens</TableHeaderCell>
            <TableHeaderCell align="right">Estimated Cost</TableHeaderCell>
          </TableRow>
        </TableHeader>
        <TableBody>
          {#each usage.analytics.byPrincipal as group (group.key)}
            <TableRow>
              <TableCell>{group.key}</TableCell>
              <TableCell align="right">{group.runCount}</TableCell>
              <TableCell align="right">{group.totalTokens}</TableCell>
              <TableCell align="right">{formatCost(group)}</TableCell>
            </TableRow>
          {/each}
        </TableBody>
      </Table>
    </section>

    <section>
      <SectionHeading level={3} title="By Time Window (UTC day)" />
      <Table caption="Usage by time window">
        <TableHeader>
          <TableRow>
            <TableHeaderCell>Window</TableHeaderCell>
            <TableHeaderCell align="right">Runs</TableHeaderCell>
            <TableHeaderCell align="right">Total Tokens</TableHeaderCell>
            <TableHeaderCell align="right">Estimated Cost</TableHeaderCell>
          </TableRow>
        </TableHeader>
        <TableBody>
          {#each usage.analytics.byWindow as group (group.key)}
            <TableRow>
              <TableCell>{group.key}</TableCell>
              <TableCell align="right">{group.runCount}</TableCell>
              <TableCell align="right">{group.totalTokens}</TableCell>
              <TableCell align="right">{formatCost(group)}</TableCell>
            </TableRow>
          {/each}
        </TableBody>
      </Table>
    </section>
  {/if}
</main>
