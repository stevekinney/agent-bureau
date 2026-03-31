import { useCallback, useReducer, useRef, useState } from 'react';

import type { RunDetail, ServerFrame } from '../../types';
import { INITIAL_TOOL_ACTIVITY_STATE, reduceToolActivity } from './tool-activity';

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
  const [toolActivityState, dispatchToolActivity] = useReducer(
    reduceToolActivity,
    INITIAL_TOOL_ACTIVITY_STATE,
  );
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
          dispatchToolActivity({
            type: 'start',
            blockId: frame.blockId,
            message: `Calling ${frame.toolName}`,
          });
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
          dispatchToolActivity({
            type: 'update',
            blockId: frame.blockId,
            message: `${frame.toolName}: ${frame.partialArgs}`,
          });
          break;
        case 'stream:tool-call-complete':
          dispatchToolActivity({
            type: 'complete',
            blockId: frame.blockId,
            message: `${frame.toolName} completed`,
          });
          break;
        case 'stream:complete':
          setStreamingAssistantContent('');
          break;
        case 'stream:error':
          dispatchToolActivity({
            type: 'append',
            message: `Streaming error: ${frame.error}`,
          });
          break;
      }
    },
    [refresh],
  );

  return {
    run,
    events,
    streamingAssistantContent,
    toolActivity: [...toolActivityState.entries],
    handleMessage,
    refresh,
  };
}
