<script lang="ts">
  import { DataList } from '@lostgradient/cinder/data-list';
  import { DescriptionList } from '@lostgradient/cinder/description-list';
  import { EmptyState } from '@lostgradient/cinder/empty-state';
  import { SectionHeading } from '@lostgradient/cinder/section-heading';
  import { StackedListItem } from '@lostgradient/cinder/stacked-list-item';

  import type { ConfigurationResponse, ToolSummary } from '../../types';

  /**
   * Configuration page. Purely presentational: it reads the real
   * {@link ConfigurationResponse} injected by the server (under the canonical
   * `config` key in `window.__INITIAL_DATA__`) and renders provider, settings,
   * and tool summaries. No client fetch, no state, no effects.
   *
   * This is the corrected seam: the React app read `initialData.config` while
   * the SSR layer injected a different top-level shape, so the page always fell
   * back to a hardcoded default. The Svelte version consumes the real
   * `ConfigurationResponse` returned by `GET /api/v1/configuration`.
   */
  let { config }: { config: ConfigurationResponse } = $props();

  let providerItems = $derived(
    config.provider
      ? [
          { term: 'Provider', definition: config.provider.provider },
          { term: 'Model', definition: config.provider.model },
        ]
      : [],
  );

  let settingsItems = $derived([
    { term: 'Maximum Steps', definition: String(config.maximumSteps) },
    { term: 'System Prompt', definition: config.systemPrompt ?? 'None' },
  ]);
</script>

<main class="page-configuration">
  <SectionHeading level={2} title="Configuration" />

  <section>
    <SectionHeading level={3} title="Provider" />
    {#if config.provider}
      <DescriptionList items={providerItems} variant="two-column" />
    {:else}
      <EmptyState title="No provider configured." />
    {/if}
  </section>

  <section>
    <SectionHeading level={3} title="Settings" />
    <DescriptionList items={settingsItems} variant="two-column" />
  </section>

  {#if config.tools.length > 0}
    <section>
      <SectionHeading level={3} title={`Tools (${config.tools.length})`} />
      <DataList items={config.tools} key={(tool: ToolSummary) => tool.name}>
        {#snippet children(tool: ToolSummary)}
          <StackedListItem>
            {#snippet title()}{tool.name}{/snippet}
            {#snippet description()}{tool.description}{/snippet}
          </StackedListItem>
        {/snippet}
      </DataList>
    </section>
  {/if}
</main>
