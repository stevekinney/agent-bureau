import type { RunSummary, ServerFrame } from '../../types';

/**
 * Reactive store for the dashboard's collection of run summaries.
 *
 * Holds the canonical `runs` array as `$state` and mutates it immutably in
 * response to live `event` frames. Runes give synchronous reads, so the
 * React `runsRef`/`refreshRef` mirrors are gone — `runs` is read directly.
 */
export interface RunsStore {
  /** The current run summaries. Reactive — read directly, never destructure. */
  readonly runs: RunSummary[];
  /** Folds a live server frame into the matching run summary. */
  handleMessage: (frame: ServerFrame) => void;
  /** Refetches the full run list from the API. */
  refresh: () => Promise<void>;
  /** Inserts a new run at the head, or replaces an existing run in place. */
  upsertRun: (run: RunSummary) => void;
}

/**
 * Creates a {@link RunsStore} seeded with the server-provided initial runs.
 */
export function createRunsStore(initialRuns: RunSummary[]): RunsStore {
  let runs = $state<RunSummary[]>(initialRuns);

  async function refresh(): Promise<void> {
    const response = await fetch('/api/v1/runs');
    const data = (await response.json()) as RunSummary[];
    runs = data;
  }

  function upsertRun(run: RunSummary): void {
    const index = runs.findIndex((candidate) => candidate.id === run.id);
    if (index === -1) {
      runs = [run, ...runs];
      return;
    }

    const next = [...runs];
    next[index] = run;
    runs = next;
  }

  function handleMessage(frame: ServerFrame): void {
    if (frame.type !== 'event') return;

    const matchedExistingRun = runs.some((run) => run.id === frame.runId);

    runs = runs.map((run) => {
      if (run.id !== frame.runId) {
        return run;
      }

      const detail = (frame.detail ?? {}) as {
        error?: string;
        finishReason?: string;
        step?: number;
        usage?: { completion: number; prompt: number; total: number };
      };

      return {
        ...run,
        actionCount: run.actionCount + 1,
        steps:
          frame.event === 'step.completed'
            ? Math.max(run.steps, typeof detail.step === 'number' ? detail.step + 1 : run.steps + 1)
            : run.steps,
        usage:
          frame.event === 'step.completed' && detail.usage
            ? {
                prompt: run.usage.prompt + detail.usage.prompt,
                completion: run.usage.completion + detail.usage.completion,
                total: run.usage.total + detail.usage.total,
              }
            : run.usage,
        finishReason:
          frame.event === 'run.completed'
            ? (detail.finishReason ?? run.finishReason)
            : run.finishReason,
        error:
          frame.event === 'run.error'
            ? (detail.error ?? run.error)
            : frame.event === 'run.completed'
              ? (detail.error ?? run.error)
              : run.error,
        status:
          frame.event === 'run.completed'
            ? 'completed'
            : frame.event === 'run.error'
              ? 'error'
              : frame.event === 'run.aborted'
                ? 'aborted'
                : run.status,
      };
    });

    if (!matchedExistingRun && frame.event === 'run.started') {
      void refresh();
    }
  }

  return {
    get runs() {
      return runs;
    },
    handleMessage,
    refresh,
    upsertRun,
  };
}
