<script lang="ts">
  import { CodeBlock } from '@lostgradient/cinder/code-block';
  import { DescriptionList } from '@lostgradient/cinder/description-list';
  import { EmptyState } from '@lostgradient/cinder/empty-state';
  import { EventStreamViewer } from '@lostgradient/cinder/event-stream-viewer';
  import type {
    EventSeverity,
    EventStreamState,
    StreamEvent,
  } from '@lostgradient/cinder/event-stream-viewer';
  import { PayloadInspector } from '@lostgradient/cinder/payload-inspector';
  import { RunStepTimeline } from '@lostgradient/cinder/run-step-timeline';
  import type { RunStep, RunStepStatus } from '@lostgradient/cinder/run-step-timeline';
  import { SectionHeading } from '@lostgradient/cinder/section-heading';
  import { Stat } from '@lostgradient/cinder/stat';
  import { StatGroup } from '@lostgradient/cinder/stat-group';

  import type { RunDetail } from '../../types';
  import StatusBadge from '../components/status-badge.svelte';
  import type { ConnectionStatus } from '../hooks/use-websocket.svelte';

  type TimelineEvent = {
    event: string;
    detail: unknown;
    timestamp: number;
    sequence?: number;
  };

  type SerializedRunStepDetail = RunDetail['stepDetails'][number];

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
  }: {
    run: RunDetail;
    events: TimelineEvent[];
    streamingAssistantContent: string;
    toolActivity: string[];
    connectionStatus: ConnectionStatus;
  } = $props();

  let eventFilterQuery = $state('');

  /** Maps an event name onto an EventStreamViewer severity. */
  function eventSeverity(event: string): EventSeverity {
    if (event.endsWith('.completed')) return 'success';
    if (event.endsWith('.error') || event === 'stream:error') return 'error';
    if (event.endsWith('.aborted')) return 'warning';
    return 'info';
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

  function stringifyPayload(value: unknown): string {
    if (value === undefined) return '';
    if (typeof value === 'string') return value;
    try {
      return JSON.stringify(value, null, 2) ?? String(value);
    } catch {
      return String(value);
    }
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
</script>

{#snippet stepPayload(step: RunStep)}
  {@const detail = stepDetailFor(step)}
  {#if detail}
    {#if detail.toolCalls.length > 0}
      <PayloadInspector
        value={detail.toolCalls}
        activeView="raw"
        label={`${step.label} tool calls`}
        meta={{ contentType: 'application/json', source: step.label }}
      />
    {/if}
    {#if detail.results.length > 0}
      <PayloadInspector
        value={detail.results}
        activeView="raw"
        label={`${step.label} results`}
        meta={{ contentType: 'application/json', source: step.label }}
      />
    {/if}
  {/if}
{/snippet}

<main class="page-run-detail">
  <div class="run-detail-heading">
    <SectionHeading level={2} title={`Run ${run.id}`} />
    <StatusBadge status={run.status} />
  </div>

  <section>
    <SectionHeading level={3} title="Summary" />
    <DescriptionList items={summaryItems} variant="two-column" />
    <StatGroup columns={3} variant="cards" label="Token usage">
      <Stat label="Prompt" value={run.usage.prompt} />
      <Stat label="Completion" value={run.usage.completion} />
      <Stat label="Total" value={run.usage.total} />
    </StatGroup>
  </section>

  {#if streamingAssistantContent}
    <section>
      <SectionHeading level={3} title="Streaming Output" />
      <CodeBlock code={streamingAssistantContent} highlight={false} />
    </section>
  {/if}

  {#if toolActivity.length > 0}
    <section>
      <SectionHeading level={3} title="Tool Activity" />
      <ul class="run-tool-activity">
        {#each toolActivity as entry, index (`${entry}-${index}`)}
          <li>{entry}</li>
        {/each}
      </ul>
    </section>
  {/if}

  <section>
    <SectionHeading level={3} title="Steps" />
    {#if runSteps.length === 0}
      <EmptyState title="No completed steps yet." />
    {:else}
      <RunStepTimeline steps={runSteps} label="Run steps" children={stepPayload} />
    {/if}
  </section>

  <section>
    <SectionHeading level={3} title="Latest Snapshot" />
    {#if run.latestSnapshot === undefined}
      <EmptyState title="No snapshot yet." />
    {:else}
      <PayloadInspector
        value={run.latestSnapshot}
        activeView="tree"
        label="Latest conversation snapshot"
        meta={{ contentType: 'application/json', source: 'conversation snapshot' }}
      />
    {/if}
  </section>

  <section>
    <SectionHeading level={3} title="Event Stream" />
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
