import type { RunSummary } from '../../types';
import { StatusBadge } from './status-badge';

export function RunRow({ run }: { run: RunSummary }) {
  return (
    <tr className="run-row">
      <td>
        <a href={`/runs/${run.id}`}>{run.id}</a>
      </td>
      <td>
        <StatusBadge status={run.status} />
      </td>
      <td>{run.steps}</td>
      <td>{run.usage.total}</td>
      <td>{run.finishReason ?? '—'}</td>
    </tr>
  );
}
