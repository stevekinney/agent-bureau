<script lang="ts">
  import { Badge, type BadgeVariant } from '@lostgradient/cinder/badge';
  import { CodeBlock } from '@lostgradient/cinder/code-block';
  import { DataList } from '@lostgradient/cinder/data-list';
  import { DescriptionList } from '@lostgradient/cinder/description-list';
  import { EmptyState } from '@lostgradient/cinder/empty-state';
  import { EventStreamViewer } from '@lostgradient/cinder/event-stream-viewer';
  import type {
    EventSeverity,
    EventStreamState,
    StreamEvent,
  } from '@lostgradient/cinder/event-stream-viewer';
  import { PayloadInspector } from '@lostgradient/cinder/payload-inspector';
  import { PageHeader } from '@lostgradient/cinder/page-header';
  import { RunStepTimeline } from '@lostgradient/cinder/run-step-timeline';
  import type { RunStep, RunStepStatus } from '@lostgradient/cinder/run-step-timeline';
  import { SectionHeading } from '@lostgradient/cinder/section-heading';
  import { Stat } from '@lostgradient/cinder/stat';
  import { StatGroup } from '@lostgradient/cinder/stat-group';
  import { StackedListItem } from '@lostgradient/cinder/stacked-list-item';

  import type { RunDetailResponse } from '../../routes/runs';
  import { assembleRunTimeline } from '../../timeline';
  import type { RunTimelineEntry, RunTimelineEntryKind } from '../../timeline';
  import ReviewRow from '../components/review-row.svelte';
  import StatusBadge from '../components/status-badge.svelte';
  import type { ReviewsStore } from '../hooks/use-reviews.svelte';
  import type { ConnectionStatus } from '../hooks/use-websocket.svelte';

  type TimelineEvent = {
    event: string;
    detail: unknown;
    timestamp: number;
    sequence?: number;
  };

  type SerializedRunStepDetail = RunDetailResponse['stepDetails'][number];
  const MAX_CODE_BLOCK_PAYLOAD_BYTES = 1_048_576;
  const PAYLOAD_TRUNCATION_SUFFIX = '\n[Payload truncated at 1 MiB]';

  /**
   * Run detail page. Renders the rich view of a single run: summary, usage
   * stats, streaming output, tool activity, per-step cards, the latest
   * conversation snapshot, and an event stream.
   *
   * All reactive inputs (`run`, `events`, `streamingAssistantContent`,
   * `toolActivity`) are owned by the run-detail store (use-run-detail.svelte.ts).
   * The only local state is the event-stream filter query owned by Cinder's
   * EventStreamViewer control.
   */
  let {
    run,
    events,
    streamingAssistantContent,
    toolActivity,
    connectionStatus,
    reviews,
  }: {
    run: RunDetailResponse;
    events: TimelineEvent[];
    streamingAssistantContent: string;
    toolActivity: string[];
    connectionStatus: ConnectionStatus;
    /**
     * The shared review-queue store (AB-20), reused here so a parked run
     * offers a resume affordance without a second approve/deny code path.
     * Optional — omitted by tests that render this page without the wider
     * app shell (e.g. `server/render.test.ts`), in which case no resume
     * section renders.
     */
    reviews?: ReviewsStore;
  } = $props();

  let eventFilterQuery = $state('');

  /** Maps an event name onto an EventStreamViewer severity. */
  function eventSeverity(event: string): EventSeverity {
    if (event.endsWith('.completed')) return 'success';
    if (event.endsWith('.error') || event === 'stream:error') return 'error';
    if (event.endsWith('.aborted')) return 'warning';
    return 'info';
  }

  /**
   * Badge tone for a timeline milestone kind (AB-12). `kind` is classified
   * server- or client-side from JSON over the wire, so a value outside the
   * current `RunTimelineEntryKind` union (an older client talking to a
   * newer server, or malformed data) must still fall through to a safe
   * default rather than leaving the badge's `variant` prop `undefined`.
   */
  function timelineBadgeVariant(kind: RunTimelineEntryKind): BadgeVariant {
    switch (kind) {
      case 'human-wait-parked':
        return 'warning';
      case 'retry-attempt':
        return 'danger';
      case 'reattached':
        return 'accent';
      case 'child-workflow-started':
      case 'handoff-occurred':
        return 'info';
      case 'checkpoint':
      case 'other':
        return 'neutral';
      default:
        return 'neutral';
    }
  }

  /**
   * Human-readable label for a timeline milestone kind (AB-12). Same
   * unknown-kind safety net as {@link timelineBadgeVariant} above.
   */
  function timelineKindLabel(kind: RunTimelineEntryKind): string {
    switch (kind) {
      case 'checkpoint':
        return 'Checkpoint';
      case 'human-wait-parked':
        return 'Parked';
      case 'child-workflow-started':
        return 'Child workflow';
      case 'handoff-occurred':
        return 'Handoff';
      case 'reattached':
        return 'Reattached';
      case 'retry-attempt':
        return 'Retry';
      case 'other':
        return 'Event';
      default:
        return 'Event';
    }
  }

  /** Stable, unique key for a timeline event. Mirrors the React row key. */
  function eventKey(event: TimelineEvent, index: number): string {
    return `${event.event}-${event.timestamp}-${event.sequence ?? index}`;
  }

  function eventSource(event: string): string | undefined {
    const [source] = event.split('.');
    return source || undefined;
  }

  /**
   * Formats an event timestamp for both SSR and client without a hydration
   * mismatch: the displayed value is the UTC clock portion of the ISO string,
   * not `toLocaleTimeString()` (which is locale/timezone-dependent and differs
   * between server and browser). Returns the ISO datetime for the machine
   * `<time datetime>` and a stable human label, guarding against malformed
   * timestamps that would otherwise throw inside `toISOString()`.
   */
  function formatEventTime(timestamp: number): { datetime: string; label: string } {
    const date = new Date(timestamp);
    if (Number.isNaN(date.valueOf())) {
      return { datetime: '', label: 'Invalid timestamp' };
    }
    const datetime = date.toISOString();
    return { datetime, label: `${datetime.slice(11, 19)} UTC` };
  }

  function stringifyPayload(value: unknown, maxBytes?: number): string {
    if (value === undefined) return '';
    const serialized = (() => {
      if (typeof value === 'string') return value;
      try {
        return JSON.stringify(value, null, 2) ?? String(value);
      } catch {
        return String(value);
      }
    })();

    if (maxBytes === undefined) return serialized;

    const encoded = new TextEncoder().encode(serialized);
    if (encoded.byteLength <= maxBytes) return serialized;

    const suffix = new TextEncoder().encode(PAYLOAD_TRUNCATION_SUFFIX);
    const contentBytes = Math.max(0, maxBytes - suffix.byteLength);
    return `${new TextDecoder().decode(encoded.slice(0, contentBytes))}${PAYLOAD_TRUNCATION_SUFFIX}`;
  }

  function stepStatus(step: SerializedRunStepDetail): RunStepStatus {
    if (step.results.some((result) => result.error)) return 'failed';
    return 'succeeded';
  }

  function stepDetails(step: SerializedRunStepDetail): NonNullable<RunStep['details']> {
    const details: NonNullable<RunStep['details']> = [
      {
        id: `step-${step.step}-content`,
        label: 'Content',
        content: step.content || 'No content.',
      },
    ];

    if (step.usage) {
      details.push({
        id: `step-${step.step}-usage`,
        label: 'Token usage',
        content: [
          `Prompt: ${step.usage.prompt}`,
          `Completion: ${step.usage.completion}`,
          `Total: ${step.usage.total}`,
        ].join('\n'),
      });
    }

    return details;
  }

  function eventMatchesQuery(event: StreamEvent, query: string): boolean {
    const haystack = [
      event.summary,
      event.source ?? '',
      event.timestamp ?? '',
      event.datetime,
      stringifyPayload(event.details),
    ]
      .join('\n')
      .toLowerCase();

    return haystack.includes(query);
  }

  let summaryItems = $derived([
    { term: 'Session', definition: run.sessionId || '—' },
    { term: 'Steps', definition: String(run.steps) },
    { term: 'Finish Reason', definition: run.finishReason ?? '—' },
    ...(run.error ? [{ term: 'Error', definition: run.error }] : []),
  ]);

  let runSteps = $derived<RunStep[]>(
    run.stepDetails.map((step) => ({
      id: `step-${step.step}`,
      label: `Step ${step.step + 1}${step.final ? ' (final)' : ''}`,
      status: stepStatus(step),
      details: stepDetails(step),
    })),
  );

  function stepDetailFor(step: RunStep): SerializedRunStepDetail | undefined {
    return run.stepDetails.find((detail) => `step-${detail.step}` === step.id);
  }

  let streamEvents = $derived<StreamEvent[]>(
    events.map((event, index) => {
      const { datetime, label } = formatEventTime(event.timestamp);
      return {
        id: eventKey(event, index),
        datetime,
        timestamp: label,
        severity: eventSeverity(event.event),
        source: eventSource(event.event),
        summary: event.event,
        details: event.detail,
      };
    }),
  );

  let visibleStreamEvents = $derived.by(() => {
    const query = eventFilterQuery.trim().toLowerCase();
    if (!query) {
      return streamEvents;
    }
    return streamEvents.filter((event) => eventMatchesQuery(event, query));
  });

  let eventStreamConnectionState = $derived<EventStreamState>(connectionStatus);

  // AB-12 run-inspector: the milestone timeline — checkpoint boundaries,
  // multi-agent delegation transitions, human-wait parks, recovery/reattach
  // markers, and retry attempts.
  //
  // Classified from the `events` prop (the store's live-merged event list),
  // NOT `run.timeline` (a snapshot fetched at page load / last refresh).
  // A milestone that arrives over the live stream — e.g. a
  // `multiagent.human-wait.parked` the operator is watching happen — must
  // show up immediately, not wait for a refresh-triggering terminal event
  // (which, for a park, may never come until the operator responds). Only
  // sequenced entries are classified: synthetic client-only rows (e.g. the
  // `stream:tool-call-start` marker) have no `sequence` and are not part of
  // the durable action log this timeline represents.
  // `'other'` entries are excluded here — they still render in the full
  // Event Stream section below, just not called out as a milestone.
  let milestoneEntries = $derived<RunTimelineEntry[]>(
    assembleRunTimeline(
      events.filter((event): event is TimelineEvent & { sequence: number } => {
        return event.sequence !== undefined;
      }),
    ).filter((entry) => entry.kind !== 'other'),
  );

  // The pending human-wait review (if any) parking this run, reused from the
  // AB-20 review queue store — the same data and approve/deny plumbing the
  // Review Queue page uses, so there is exactly one resume code path.
  let parkedReview = $derived(
    reviews?.reviews.find((review) => review.kind === 'human-wait' && review.runId === run.id),
  );
</script>

{#snippet timelineEmpty()}
  <p>No milestone events yet.</p>
{/snippet}

{#snippet timelineTitle(entry: RunTimelineEntry)}
  {entry.event}
{/snippet}

{#snippet timelineDescription(entry: RunTimelineEntry)}
  {stringifyPayload(entry.detail)}
{/snippet}

{#snippet timelineMeta(entry: RunTimelineEntry)}
  {formatEventTime(entry.timestamp).label}
{/snippet}

{#snippet timelineRow(entry: RunTimelineEntry)}
  <StackedListItem>
    {#snippet leading()}
      <Badge variant={timelineBadgeVariant(entry.kind)} size="sm">
        {timelineKindLabel(entry.kind)}
      </Badge>
    {/snippet}
    {#snippet title()}{@render timelineTitle(entry)}{/snippet}
    {#snippet description()}{@render timelineDescription(entry)}{/snippet}
    {#snippet meta()}{@render timelineMeta(entry)}{/snippet}
  </StackedListItem>
{/snippet}

{#snippet stepPayload(step: RunStep)}
  {@const detail = stepDetailFor(step)}
  {#if detail}
    {#if detail.toolCalls.length > 0}
      <div class="run-step-payload">
        <h4>{step.label} tool calls</h4>
        <CodeBlock
          code={stringifyPayload(detail.toolCalls, MAX_CODE_BLOCK_PAYLOAD_BYTES)}
          language="json"
          highlight={false}
        />
      </div>
    {/if}
    {#if detail.results.length > 0}
      <div class="run-step-payload">
        <h4>{step.label} results</h4>
        <CodeBlock
          code={stringifyPayload(detail.results, MAX_CODE_BLOCK_PAYLOAD_BYTES)}
          language="json"
          highlight={false}
        />
      </div>
    {/if}
  {/if}
{/snippet}

<main class="page-run-detail">
  <div class="run-detail-heading">
    <PageHeader title={`Run ${run.id}`} />
    <StatusBadge status={run.status} />
  </div>

  <section>
    <SectionHeading level={2} title="Summary" />
    <DescriptionList items={summaryItems} variant="two-column" />
    <StatGroup columns={3} variant="cards" label="Token usage">
      <Stat label="Prompt" value={run.usage.prompt} />
      <Stat label="Completion" value={run.usage.completion} />
      <Stat label="Total" value={run.usage.total} />
    </StatGroup>
  </section>

  {#if parkedReview}
    <section>
      <SectionHeading level={2} title="Awaiting Human Input" />
      <ReviewRow
        review={parkedReview}
        pending={reviews?.pendingId === parkedReview.id}
        onapprove={(id, payload) => void reviews?.approve(id, { payload })}
        ondeny={(id, reason) => void reviews?.deny(id, { reason })}
      />
    </section>
  {/if}

  <section>
    <SectionHeading level={2} title="Timeline" />
    {#if milestoneEntries.length === 0}
      <EmptyState
        title="No milestone events yet."
        description="Checkpoint boundaries, delegation, human-wait parks, recovery markers, and retries appear here as the run progresses."
      />
    {:else}
      <DataList
        items={milestoneEntries}
        key={(entry) => `${entry.sequence}-${entry.event}`}
        children={timelineRow}
        empty={timelineEmpty}
      />
    {/if}
  </section>

  {#if streamingAssistantContent}
    <section>
    <SectionHeading level={2} title="Streaming Output" />
      <CodeBlock code={streamingAssistantContent} highlight={false} />
    </section>
  {/if}

  {#if toolActivity.length > 0}
    <section>
    <SectionHeading level={2} title="Tool Activity" />
      <ul class="run-tool-activity">
        {#each toolActivity as entry, index (`${entry}-${index}`)}
          <li>{entry}</li>
        {/each}
      </ul>
    </section>
  {/if}

  <section>
    <SectionHeading level={2} title="Steps" />
    {#if runSteps.length === 0}
      <EmptyState title="No completed steps yet." />
    {:else}
      <RunStepTimeline steps={runSteps} label="Run steps" children={stepPayload} />
    {/if}
  </section>

  <section>
    <SectionHeading level={2} title="Latest Snapshot" />
    {#if run.latestSnapshot === undefined}
      <EmptyState title="No snapshot yet." />
    {:else}
      <PayloadInspector
        value={run.latestSnapshot}
        label="Latest conversation snapshot"
      />
    {/if}
  </section>

  <section>
    <SectionHeading level={2} title="Event Stream" />
    <EventStreamViewer
      events={visibleStreamEvents}
      connectionState={eventStreamConnectionState}
      filterQuery={eventFilterQuery}
      onfilter={(query) => {
        eventFilterQuery = query;
      }}
      label="Run event stream"
    />
  </section>
</main>
