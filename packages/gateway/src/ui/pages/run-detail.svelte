<script lang="ts">
  import { Card } from '@lostgradient/cinder/card';
  import { CodeBlock } from '@lostgradient/cinder/code-block';
  import { DescriptionList } from '@lostgradient/cinder/description-list';
  import { EmptyState } from '@lostgradient/cinder/empty-state';
  import { JsonViewer } from '@lostgradient/cinder/json-viewer';
  import { SectionHeading } from '@lostgradient/cinder/section-heading';
  import { Stat } from '@lostgradient/cinder/stat';
  import { StatGroup } from '@lostgradient/cinder/stat-group';
  import { Timeline } from '@lostgradient/cinder/timeline';
  import type { TimelineEntry, TimelineTone } from '@lostgradient/cinder/timeline';

  import type { RunDetail } from '../../types';
  import StatusBadge from '../components/status-badge.svelte';

  type TimelineEvent = {
    event: string;
    detail: unknown;
    timestamp: number;
    sequence?: number;
  };

  /**
   * Run detail page. Renders the rich view of a single run: summary, usage
   * stats, streaming output, tool activity, per-step cards, the latest
   * conversation snapshot, and an event timeline.
   *
   * All reactive inputs (`run`, `events`, `streamingAssistantContent`,
   * `toolActivity`) are owned by the run-detail store (use-run-detail.svelte.ts)
   * and passed in by {@link app.svelte}. This page is presentational and holds
   * no state or effects of its own.
   */
  let {
    run,
    events,
    streamingAssistantContent,
    toolActivity,
  }: {
    run: RunDetail;
    events: TimelineEvent[];
    streamingAssistantContent: string;
    toolActivity: string[];
  } = $props();

  /** Maps an event name onto a Timeline marker tone. */
  function eventTone(event: string): TimelineTone {
    if (event.endsWith('.completed')) return 'success';
    if (event.endsWith('.error') || event === 'stream:error') return 'error';
    if (event.endsWith('.aborted')) return 'warning';
    return 'info';
  }

  /** Stable, unique key for a timeline event. Mirrors the React row key. */
  function eventKey(event: TimelineEvent, index: number): string {
    return `${event.event}-${event.timestamp}-${event.sequence ?? index}`;
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

  let summaryItems = $derived([
    { term: 'Session', definition: run.sessionId || '—' },
    { term: 'Steps', definition: String(run.steps) },
    { term: 'Finish Reason', definition: run.finishReason ?? '—' },
    ...(run.error ? [{ term: 'Error', definition: run.error }] : []),
  ]);

  // Timeline's per-entry snippet only receives a `TimelineEntry`, which carries
  // no `detail`. Build the entries plus a parallel id -> detail map so the
  // children snippet can look the raw value back up and hand it to JsonViewer.
  let timelineEntries = $derived<TimelineEntry[]>(
    events.map((event, index) => {
      const { datetime, label } = formatEventTime(event.timestamp);
      return {
        id: eventKey(event, index),
        datetime,
        timestamp: label,
        title: event.event,
        tone: eventTone(event.event),
      };
    }),
  );

  let detailById = $derived.by(() => {
    const map = new Map<string, unknown>();
    for (const [index, event] of events.entries()) {
      map.set(eventKey(event, index), event.detail);
    }
    return map;
  });
</script>

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
    {#if run.stepDetails.length === 0}
      <EmptyState title="No completed steps yet." />
    {:else}
      <div class="run-step-list">
        {#each run.stepDetails as step (step.step)}
          <Card title={`Step ${step.step + 1}`}>
            <p>{step.content || '—'}</p>
            <p>Final: {step.final ? 'yes' : 'no'}</p>
            {#if step.toolCalls.length > 0}
              <SectionHeading level={4} title="Tool Calls" />
              <JsonViewer value={step.toolCalls} />
            {/if}
            {#if step.results.length > 0}
              <SectionHeading level={4} title="Results" />
              <JsonViewer value={step.results} />
            {/if}
          </Card>
        {/each}
      </div>
    {/if}
  </section>

  <section>
    <SectionHeading level={3} title="Latest Snapshot" />
    {#if run.latestSnapshot === undefined}
      <EmptyState title="No snapshot yet." />
    {:else}
      <JsonViewer value={run.latestSnapshot} />
    {/if}
  </section>

  <section>
    <SectionHeading level={3} title="Timeline" />
    {#if timelineEntries.length === 0}
      <EmptyState title="No events yet." />
    {:else}
      <Timeline entries={timelineEntries} label="Run event timeline">
        {#snippet children(entry: TimelineEntry)}
          {@const detail = detailById.get(entry.id)}
          {#if detail !== undefined}
            <JsonViewer value={detail} />
          {/if}
        {/snippet}
      </Timeline>
    {/if}
  </section>
</main>
