import { useCallback, useState } from 'react';

import type { RunSummary, ServerFrame } from '../../types';

export interface UseRunDetailResult {
  run: RunSummary;
  events: Array<{ event: string; detail: unknown; timestamp: number }>;
  handleMessage: (frame: ServerFrame) => void;
}

export function useRunDetail(initialRun: RunSummary): UseRunDetailResult {
  const [run, setRun] = useState<RunSummary>(initialRun);
  const [events, setEvents] = useState<UseRunDetailResult['events']>([]);

  const handleMessage = useCallback(
    (frame: ServerFrame) => {
      if (frame.type !== 'event' || frame.runId !== initialRun.id) return;

      setEvents((previous) => [
        ...previous,
        { event: frame.event, detail: frame.detail, timestamp: frame.timestamp },
      ]);

      setRun((previous) => ({
        ...previous,
        actionCount: previous.actionCount + 1,
        status:
          frame.event === 'run.completed'
            ? 'completed'
            : frame.event === 'run.error'
              ? 'error'
              : frame.event === 'run.aborted'
                ? 'aborted'
                : previous.status,
      }));
    },
    [initialRun.id],
  );

  return { run, events, handleMessage };
}
