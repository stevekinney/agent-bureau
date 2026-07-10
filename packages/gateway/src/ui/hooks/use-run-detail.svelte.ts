import type { RunDetailResponse } from '../../routes/runs';
import type { ServerFrame } from '../../types';
import {
  INITIAL_TOOL_ACTIVITY_STATE,
  reduceToolActivity,
  type ToolActivityAction,
  type ToolActivityState,
} from './tool-activity';

/** A single entry on the run-detail timeline. */
export type TimelineEvent = {
  event: string;
  detail: unknown;
  timestamp: number;
  sequence?: number;
};

/**
 * Reactive store for a single run's detail view: the run record, its event
 * timeline, the in-flight streaming assistant text, and the tool-activity log.
 *
 * The React `useReducer` for tool activity becomes a `$state`-held reducer
 * value driven through a `dispatch` helper; the `runIdRef` mirror collapses to
 * a plain local since runes reads are synchronous.
 */
export interface RunDetailStore {
  /** The current run detail record. Reactive — read directly, never destructure. */
  readonly run: RunDetailResponse;
  /** The accumulated timeline of run events. */
  readonly events: TimelineEvent[];
  /** The latest accumulated streaming assistant text ('' when idle). */
  readonly streamingAssistantContent: string;
  /** The ordered tool-activity log lines. */
  readonly toolActivity: string[];
  /** Folds a live server frame into the run-detail state. */
  handleMessage: (frame: ServerFrame) => void;
  /** Refetches the full run detail from the API. */
  refresh: () => Promise<void>;
}

function timelineFromRun(run: RunDetailResponse): TimelineEvent[] {
  return run.events.map((event) => ({
    event: event.event,
    detail: event.detail,
    timestamp: event.timestamp,
    sequence: event.sequence,
  }));
}

/**
 * Creates a {@link RunDetailStore} seeded with the server-provided initial run.
 */
export function createRunDetailStore(initialRun: RunDetailResponse): RunDetailStore {
  let run = $state<RunDetailResponse>(initialRun);
  let events = $state<TimelineEvent[]>(timelineFromRun(initialRun));
  let streamingAssistantContent = $state('');
  let toolActivityState = $state<ToolActivityState>(INITIAL_TOOL_ACTIVITY_STATE);

  // `runId` never drives UI, so it stays a plain local — not `$state`.
  const runId = initialRun.id;

  function dispatchToolActivity(action: ToolActivityAction): void {
    toolActivityState = reduceToolActivity(toolActivityState, action);
  }

  async function refresh(): Promise<void> {
    if (!runId) {
      return;
    }

    const response = await fetch(`/api/v1/runs/${runId}`);
    if (!response.ok) {
      return;
    }

    const nextRun = (await response.json()) as RunDetailResponse;
    run = nextRun;

    // Merge the freshly-fetched timeline with the locally-held one keyed on
    // `sequence`. The API can lag the websocket stream, so a sequenced event
    // already shown live (e.g. the `step.completed` that triggered this
    // refresh) may not be in `nextRun` yet — carrying only sequence-less rows
    // would drop it, making timeline rows vanish. Keep every API event, then
    // re-append (a) locally-held sequenced events the API hasn't caught up to
    // and (b) the synthetic sequence-less rows (e.g. tool-call-start). Once the
    // API includes a sequence, the Set dedup keeps it appearing exactly once.
    const apiTimeline = timelineFromRun(nextRun);
    const apiSequences = new Set(
      apiTimeline
        .map((event) => event.sequence)
        .filter((sequence): sequence is number => sequence !== undefined),
    );
    events = [
      ...apiTimeline,
      ...events.filter(
        (event) => event.sequence === undefined || !apiSequences.has(event.sequence),
      ),
    ];
  }

  function handleMessage(frame: ServerFrame): void {
    if (!('runId' in frame) || frame.runId !== runId) return;

    switch (frame.type) {
      case 'event':
        events = [
          ...events,
          {
            event: frame.event,
            detail: frame.detail,
            timestamp: frame.timestamp,
            sequence: frame.sequence,
          },
        ];

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
        streamingAssistantContent = frame.accumulated;
        break;
      case 'stream:tool-call-start':
        dispatchToolActivity({
          type: 'start',
          blockId: frame.blockId,
          message: `Calling ${frame.toolName}`,
        });
        events = [
          ...events,
          {
            event: frame.type,
            detail: { toolName: frame.toolName, blockId: frame.blockId },
            timestamp: Date.now(),
          },
        ];
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
        streamingAssistantContent = '';
        break;
      case 'stream:error':
        dispatchToolActivity({
          type: 'append',
          message: `Streaming error: ${frame.error}`,
        });
        break;
    }
  }

  return {
    get run() {
      return run;
    },
    get events() {
      return events;
    },
    get streamingAssistantContent() {
      return streamingAssistantContent;
    },
    get toolActivity() {
      return [...toolActivityState.entries];
    },
    handleMessage,
    refresh,
  };
}
