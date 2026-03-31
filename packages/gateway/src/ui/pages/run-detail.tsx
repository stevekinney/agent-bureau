import type { RunDetail } from '../../types';
import { StatusBadge } from '../components/status-badge';

type RunDetailPageProps = {
  events: Array<{ event: string; detail: unknown; timestamp: number; sequence?: number }>;
  run: RunDetail;
  streamingAssistantContent: string;
  toolActivity: string[];
};

function formatDetail(detail: unknown): string {
  if (detail === undefined) {
    return '—';
  }

  if (typeof detail === 'string') {
    return detail;
  }

  if (typeof detail === 'number' || typeof detail === 'boolean' || typeof detail === 'bigint') {
    return String(detail);
  }

  if (detail instanceof Error) {
    return detail.message;
  }

  if (typeof detail === 'symbol') {
    return detail.description ? `Symbol(${detail.description})` : 'Symbol()';
  }

  try {
    return JSON.stringify(detail, null, 2);
  } catch {
    return Object.prototype.toString.call(detail);
  }
}

export function RunDetailPage({
  run,
  events,
  streamingAssistantContent,
  toolActivity,
}: RunDetailPageProps) {
  return (
    <main className="page-run-detail">
      <h1>
        Run {run.id} <StatusBadge status={run.status} />
      </h1>
      <section>
        <h2>Summary</h2>
        <dl>
          <dt>Session</dt>
          <dd>{run.sessionId || '—'}</dd>
          <dt>Steps</dt>
          <dd>{run.steps}</dd>
          <dt>Usage</dt>
          <dd>
            prompt: {run.usage.prompt}, completion: {run.usage.completion}, total: {run.usage.total}
          </dd>
          <dt>Finish Reason</dt>
          <dd>{run.finishReason ?? '—'}</dd>
          {run.error ? (
            <>
              <dt>Error</dt>
              <dd className="error">{run.error}</dd>
            </>
          ) : null}
        </dl>
      </section>

      {streamingAssistantContent ? (
        <section>
          <h2>Streaming Output</h2>
          <pre>{streamingAssistantContent}</pre>
        </section>
      ) : null}

      {toolActivity.length > 0 ? (
        <section>
          <h2>Tool Activity</h2>
          <ul>
            {toolActivity.map((entry, index) => (
              <li key={`${entry}-${index}`}>{entry}</li>
            ))}
          </ul>
        </section>
      ) : null}

      <section>
        <h2>Steps</h2>
        {run.stepDetails.length === 0 ? (
          <p>No completed steps yet.</p>
        ) : (
          <ol className="run-step-list">
            {run.stepDetails.map((step) => (
              <li key={`step-${step.step}`}>
                <h3>Step {step.step + 1}</h3>
                <p>{step.content || '—'}</p>
                <p>Final: {step.final ? 'yes' : 'no'}</p>
                {step.toolCalls.length > 0 ? (
                  <>
                    <h4>Tool Calls</h4>
                    <pre>{formatDetail(step.toolCalls)}</pre>
                  </>
                ) : null}
                {step.results.length > 0 ? (
                  <>
                    <h4>Results</h4>
                    <pre>{formatDetail(step.results)}</pre>
                  </>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </section>

      <section>
        <h2>Latest Snapshot</h2>
        <pre>{formatDetail(run.latestSnapshot)}</pre>
      </section>

      <section>
        <h2>Timeline</h2>
        {events.length === 0 ? (
          <p>No events yet.</p>
        ) : (
          <ol className="run-event-list">
            {events.map((event, index) => (
              <li key={`${event.event}-${event.timestamp}-${event.sequence ?? index}`}>
                <strong>{event.event}</strong>
                <div>{new Date(event.timestamp).toLocaleTimeString()}</div>
                <pre>{formatDetail(event.detail)}</pre>
              </li>
            ))}
          </ol>
        )}
      </section>
    </main>
  );
}
