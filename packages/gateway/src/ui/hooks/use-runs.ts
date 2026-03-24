import { useCallback, useState } from 'react';

import type { RunSummary, ServerFrame } from '../../types';

export interface UseRunsResult {
  runs: RunSummary[];
  handleMessage: (frame: ServerFrame) => void;
  refresh: () => Promise<void>;
}

export function useRuns(initialRuns: RunSummary[]): UseRunsResult {
  const [runs, setRuns] = useState<RunSummary[]>(initialRuns);

  const handleMessage = useCallback((frame: ServerFrame) => {
    if (frame.type !== 'event') return;

    setRuns((previous) =>
      previous.map((run) => {
        if (run.id !== frame.runId) return run;
        return {
          ...run,
          actionCount: run.actionCount + 1,
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
  }, []);

  const refresh = useCallback(async () => {
    const response = await fetch('/api/v1/runs');
    const data = (await response.json()) as RunSummary[];
    setRuns(data);
  }, []);

  return { runs, handleMessage, refresh };
}
