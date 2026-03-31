import { useCallback, useRef, useState } from 'react';

import type { RunSummary, ServerFrame } from '../../types';

export interface UseRunsResult {
  runs: RunSummary[];
  handleMessage: (frame: ServerFrame) => void;
  refresh: () => Promise<void>;
  upsertRun: (run: RunSummary) => void;
}

export function useRuns(initialRuns: RunSummary[]): UseRunsResult {
  const [runs, setRuns] = useState<RunSummary[]>(initialRuns);
  const refreshRef = useRef<(() => Promise<void>) | undefined>(undefined);

  const refresh = useCallback(async () => {
    const response = await fetch('/api/v1/runs');
    const data = (await response.json()) as RunSummary[];
    setRuns(data);
  }, []);
  refreshRef.current = refresh;

  const upsertRun = useCallback((run: RunSummary) => {
    setRuns((previous) => {
      const index = previous.findIndex((candidate) => candidate.id === run.id);
      if (index === -1) {
        return [run, ...previous];
      }

      const next = [...previous];
      next[index] = run;
      return next;
    });
  }, []);

  const handleMessage = useCallback((frame: ServerFrame) => {
    if (frame.type !== 'event') return;

    let matchedExistingRun = false;

    setRuns((previous) =>
      previous.map((run) => {
        if (run.id !== frame.runId) {
          return run;
        }

        matchedExistingRun = true;
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
              ? Math.max(
                  run.steps,
                  typeof detail.step === 'number' ? detail.step + 1 : run.steps + 1,
                )
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
      }),
    );

    if (!matchedExistingRun && frame.event === 'run.started') {
      void refreshRef.current?.();
    }
  }, []);

  return { runs, handleMessage, refresh, upsertRun };
}
