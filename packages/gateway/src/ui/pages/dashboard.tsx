import type { RunSummary } from '../../types';
import { RunRow } from '../components/run-row';

export function DashboardPage({ runs }: { runs: RunSummary[] }) {
  return (
    <main className="page-dashboard">
      <h1>Dashboard</h1>
      {runs.length === 0 ? (
        <p>No runs yet.</p>
      ) : (
        <table className="runs-table">
          <thead>
            <tr>
              <th>ID</th>
              <th>Status</th>
              <th>Steps</th>
              <th>Tokens</th>
              <th>Finish Reason</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => (
              <RunRow key={run.id} run={run} />
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
