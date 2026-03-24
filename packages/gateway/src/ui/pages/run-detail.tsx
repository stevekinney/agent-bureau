import type { RunSummary } from '../../types';
import { StatusBadge } from '../components/status-badge';

export function RunDetailPage({ run }: { run: RunSummary }) {
  return (
    <main className="page-run-detail">
      <h1>
        Run {run.id} <StatusBadge status={run.status} />
      </h1>
      <section>
        <h2>Details</h2>
        <dl>
          <dt>Steps</dt>
          <dd>{run.steps}</dd>
          <dt>Usage</dt>
          <dd>
            prompt: {run.usage.prompt}, completion: {run.usage.completion}, total: {run.usage.total}
          </dd>
          <dt>Finish Reason</dt>
          <dd>{run.finishReason ?? '—'}</dd>
          {run.error && (
            <>
              <dt>Error</dt>
              <dd className="error">{run.error}</dd>
            </>
          )}
        </dl>
      </section>
    </main>
  );
}
