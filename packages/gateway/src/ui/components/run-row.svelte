<script lang="ts">
  import { Link } from '@lostgradient/cinder/link';
  import { TableCell } from '@lostgradient/cinder/table-cell';
  import { TableRow } from '@lostgradient/cinder/table-row';

  import type { RunSummary } from '../../types';
  import StatusBadge from './status-badge.svelte';

  let { run }: { run: RunSummary } = $props();
</script>

<TableRow>
  <TableCell>
    <Link href={`/runs/${run.id}`}>{run.id}</Link>
  </TableCell>
  <TableCell>
    <StatusBadge status={run.status} />
  </TableCell>
  <TableCell align="right">{run.steps}</TableCell>
  <TableCell align="right">{run.usage.total}</TableCell>
  <TableCell>{run.finishReason ?? '—'}</TableCell>
</TableRow>
