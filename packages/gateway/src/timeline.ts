/**
 * Run-inspector timeline classification (AB-12). A pure, dependency-free
 * module — no `bureau`/`hono` imports — so it is safe to import directly
 * from CLIENT code (`ui/hooks/use-run-detail.svelte.ts`, `ui/pages/run-detail.svelte`)
 * as well as the server route (`routes/runs.ts`). Importing a server route
 * file (which pulls in `bureau`/`hono`) from the browser bundle would bloat
 * or break the client build; this module exists so both sides can share the
 * exact same classification logic without that risk.
 *
 * Groups a run's event log onto the milestone kind the run-detail view
 * highlights: durable checkpoint boundaries, multi-agent delegation
 * transitions, human-in-the-loop parks, recovery/reattach markers (including
 * AB-10's workflow-version-mismatch detail), and generate retry attempts.
 * Every other event (`step.generated`, `tools.executing`, provider-specific
 * bubbles, …) classifies as `'other'` — still present in the timeline (the
 * full event stream renders separately), just not called out as a milestone.
 */
export type RunTimelineEntryKind =
  | 'checkpoint'
  | 'human-wait-parked'
  | 'child-workflow-started'
  | 'handoff-occurred'
  | 'reattached'
  | 'retry-attempt'
  | 'other';

export interface RunTimelineEntry {
  sequence: number;
  kind: RunTimelineEntryKind;
  event: string;
  detail: unknown;
  timestamp: number;
}

/**
 * Structural input for {@link assembleRunTimeline} — matches both the
 * server's `RunEventRecord` (bureau) and the client's `TimelineEvent`
 * (`use-run-detail.svelte.ts`) once filtered to entries carrying a real
 * `sequence`, so one classifier serves the SSR snapshot and the live,
 * websocket-fed event stream.
 */
export interface TimelineSourceEvent {
  sequence: number;
  event: string;
  detail: unknown;
  timestamp: number;
}

/**
 * `step.started`/`step.completed` mark the durable path's checkpoint
 * boundaries (see `run-workflow.ts`'s "checkpoint at a step boundary" —
 * every step is one Weft yield). An inline (non-durable) run emits the same
 * two event types with no checkpoint underneath them; the distinction is
 * presentational (this IS the step boundary either way), not a claim about
 * durability.
 */
const CHECKPOINT_EVENT_TYPES = new Set(['step.started', 'step.completed']);

const TIMELINE_KIND_BY_EVENT_TYPE: Readonly<Record<string, RunTimelineEntryKind>> = {
  'multiagent.human-wait.parked': 'human-wait-parked',
  'multiagent.child-workflow.started': 'child-workflow-started',
  'multiagent.handoff.occurred': 'handoff-occurred',
  'workflow.reattached': 'reattached',
  'generate.retry': 'retry-attempt',
};

export function classifyTimelineEntry(eventType: string): RunTimelineEntryKind {
  if (CHECKPOINT_EVENT_TYPES.has(eventType)) return 'checkpoint';
  return TIMELINE_KIND_BY_EVENT_TYPE[eventType] ?? 'other';
}

/**
 * Assembles a run's step-level timeline from its event log (AB-12). Pure
 * function — every action the operative store recorded already carries a
 * monotonic `sequence` (assigned by the SAME counter whether the action came
 * from `activeRun`'s observable or a synthetic `store.recordAction` call,
 * e.g. the `workflow.reattached` marker), so sorting by `sequence` alone
 * interleaves observed and synthetic milestones in the order they actually
 * happened — regardless of whether the caller passes the server's full
 * `RunDetail.events` snapshot or the client's live-merged event list.
 */
export function assembleRunTimeline(events: readonly TimelineSourceEvent[]): RunTimelineEntry[] {
  return events
    .map((event) => ({
      sequence: event.sequence,
      kind: classifyTimelineEntry(event.event),
      event: event.event,
      detail: event.detail,
      timestamp: event.timestamp,
    }))
    .sort((a, b) => a.sequence - b.sequence);
}
