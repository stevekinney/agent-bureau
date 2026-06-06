<script lang="ts">
  import { EmptyState } from '@lostgradient/cinder/empty-state';
  import { SectionHeading } from '@lostgradient/cinder/section-heading';
  import { Table } from '@lostgradient/cinder/table';
  import { TableBody } from '@lostgradient/cinder/table-body';
  import { TableHeader } from '@lostgradient/cinder/table-header';
  import { TableHeaderCell } from '@lostgradient/cinder/table-header-cell';
  import { TableRow } from '@lostgradient/cinder/table-row';

  import type { RunSummary } from '../../types';
  import RunRow from '../components/run-row.svelte';

  /**
   * Dashboard page. Renders the live list of runs as a cinder Table. The
   * `runs` array is owned by the websocket-fed runs store (use-runs.svelte.ts)
   * and passed in reactively by {@link app.svelte}; this page holds no state of
   * its own and runs no effects.
   */
  let { runs }: { runs: RunSummary[] } = $props();
</script>

<main class="page-dashboard">
  <SectionHeading level={2} title="Dashboard" />

  {#if runs.length === 0}
    <EmptyState title="No runs yet." description="Started runs will appear here as they execute." />
  {:else}
    <Table caption="Agent runs">
      <TableHeader>
        <TableRow>
          <TableHeaderCell>ID</TableHeaderCell>
          <TableHeaderCell>Status</TableHeaderCell>
          <TableHeaderCell align="right">Steps</TableHeaderCell>
          <TableHeaderCell align="right">Tokens</TableHeaderCell>
          <TableHeaderCell>Finish Reason</TableHeaderCell>
        </TableRow>
      </TableHeader>
      <TableBody>
        {#each runs as run (run.id)}
          <RunRow {run} />
        {/each}
      </TableBody>
    </Table>
  {/if}
</main>
