import { useCallback, useRef, useState } from 'react';

import type { RunDetail, ServerFrame } from '../../types';

type TimelineEvent = {
  event: string;
  detail: unknown;
  timestamp: number;
  sequence?: number;
};

export interface UseRunDetailResult {
  run: RunDetail;
  events: TimelineEvent[];
  streamingAssistantContent: string;
  toolActivity: string[];
  handleMessage: (frame: ServerFrame) => void;
  refresh: () => Promise<void>;
}

function timelineFromRun(run: RunDetail): TimelineEvent[] {
  return run.events.map((event) => ({
    event: event.event,
    detail: event.detail,
    timestamp: event.timestamp,
    sequence: event.sequence,
  }));
}

export function useRunDetail(initialRun: RunDetail): UseRunDetailResult {
  const [run, setRun] = useState<RunDetail>(initialRun);
  const [events, setEvents] = useState<TimelineEvent[]>(timelineFromRun(initialRun));
  const [streamingAssistantContent, setStreamingAssistantContent] = useState('');
  const [toolActivity, setToolActivity] = useState<string[]>([]);
  const runIdRef = useRef(initialRun.id);

  const refresh = useCallback(async () => {
    if (!runIdRef.current) {
      return;
    }

    const response = await fetch(`/api/v1/runs/${runIdRef.current}`);
    if (!response.ok) {
      return;
    }

    const nextRun = (await response.json()) as RunDetail;
    setRun(nextRun);
    setEvents((previous) => [
      ...timelineFromRun(nextRun),
      ...previous.filter((event) => event.sequence === undefined),
    ]);
  }, []);

  const handleMessage = useCallback(
    (frame: ServerFrame) => {
      if (!('runId' in frame) || frame.runId !== runIdRef.current) return;

      switch (frame.type) {
        case 'event':
          setEvents((previous) => [
            ...previous,
            {
              event: frame.event,
              detail: frame.detail,
              timestamp: frame.timestamp,
              sequence: frame.sequence,
            },
          ]);

          if (
            frame.event === 'step.completed' ||
            frame.event === 'run.completed' ||
            frame.event === 'run.error' ||
            frame.event === 'run.aborted'
          ) {
            void refresh();
          }
          break;
        case 'stream:text-delta':
          setStreamingAssistantContent(frame.accumulated);
          break;
        case 'stream:tool-call-start':
          setToolActivity((previous) => [...previous, `Calling ${frame.toolName}`]);
          setEvents((previous) => [
            ...previous,
            {
              event: frame.type,
              detail: { toolName: frame.toolName, blockId: frame.blockId },
              timestamp: Date.now(),
            },
          ]);
          break;
        case 'stream:tool-call-delta':
          setToolActivity((previous) => {
            const next = [...previous];
            if (next.length === 0) {
              next.push(`${frame.toolName}: ${frame.partialArgs}`);
            } else {
              next[next.length - 1] = `${frame.toolName}: ${frame.partialArgs}`;
            }
            return next;
          });
          break;
        case 'stream:tool-call-complete':
          setToolActivity((previous) => [...previous, `${frame.toolName} completed`]);
          break;
        case 'stream:complete':
          setStreamingAssistantContent('');
          break;
        case 'stream:error':
          setToolActivity((previous) => [...previous, `Streaming error: ${frame.error}`]);
          break;
      }
    },
    [refresh],
  );

  return {
    run,
    events,
    streamingAssistantContent,
    toolActivity,
    handleMessage,
    refresh,
  };
}
