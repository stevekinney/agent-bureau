<script lang="ts">
  import type { Snippet } from 'svelte';
  import { MediaQuery } from 'svelte/reactivity';

  import { Button } from '@lostgradient/cinder/button';
  import { SideNavigation } from '@lostgradient/cinder/side-navigation';
  import { SideNavigationItem } from '@lostgradient/cinder/side-navigation-item';
  import { SIDEBAR_MOBILE_MEDIA_QUERY, Sidebar } from '@lostgradient/cinder/sidebar';
  import { SkipLink } from '@lostgradient/cinder/skip-link';
  import { StatusDot } from '@lostgradient/cinder/status-dot';
  import { Menu } from 'lucide-svelte';

  import type { ConnectionStatus } from './hooks/use-websocket.svelte';

  type NavigationLink = {
    href: string;
    label: string;
  };

  const navigationLinks: NavigationLink[] = [
    { href: '/dashboard', label: 'Dashboard' },
    { href: '/reviews', label: 'Review Queue' },
    { href: '/usage', label: 'Usage' },
    { href: '/chat', label: 'Chat' },
    { href: '/evaluations', label: 'Evaluations' },
    { href: '/configuration', label: 'Configuration' },
  ];
  const mobileSidebar = new MediaQuery(SIDEBAR_MOBILE_MEDIA_QUERY, false);
  const mobileLayoutFallbackStyles = `<style data-gateway-mobile-layout>
    @media ${SIDEBAR_MOBILE_MEDIA_QUERY} {
      .layout {
        grid-template-columns: 1fr;
        grid-template-rows: auto 1fr;
      }

      .mobile-navigation-toggle {
        display: flex;
        align-items: center;
        grid-row: 1;
        padding-block: var(--cinder-space-3);
        padding-inline: var(--cinder-space-4);
        border-block-end: 1px solid var(--cinder-border);
        background: var(--cinder-surface);
      }

      .sidebar-shell {
        grid-row: 1;
        height: 0;
        overflow: visible;
      }

      .main-content {
        grid-row: 2;
        padding: 1rem;
      }
    }
  </style>`;

  let {
    children,
    connectionStatus,
    pathname,
  }: {
    children: Snippet;
    connectionStatus: ConnectionStatus;
    pathname: string;
  } = $props();

  let sidebarCollapsed = $state(mobileSidebar.current);
  const sidebarTriggerLabel = $derived(
    sidebarCollapsed ? 'Open navigation' : 'Close navigation',
  );

  const toggleSidebar = () => {
    sidebarCollapsed = !sidebarCollapsed;
  };

  const closeSidebarOnMobile = () => {
    if (mobileSidebar.current) {
      sidebarCollapsed = true;
    }
  };

  $effect(() => {
    sidebarCollapsed = mobileSidebar.current;
  });

  /**
   * Determines whether a navigation link points at the currently rendered
   * route. The dashboard owns `/` since the server redirects the root path to
   * it; every other link matches its own prefix so nested routes (e.g.
   * `/runs/:id` under a future dashboard subtree) stay highlighted.
   */
  function isActive(href: string): boolean {
    if (href === '/dashboard') {
      return pathname === '/' || pathname === '/dashboard' || pathname.startsWith('/runs');
    }
    return pathname === href || pathname.startsWith(`${href}/`);
  }
</script>

<!-- The server cannot know the viewport. Emit a CSS fallback from Cinder's
     shared query so mobile first paint is correct before hydration; the
     reactive class below takes over once MediaQuery can observe the client. -->
<svelte:head>
  {@html mobileLayoutFallbackStyles}
</svelte:head>

<div class="layout" class:layout--mobile={mobileSidebar.current}>
  <SkipLink target="main-content" />
  <div class="mobile-navigation-toggle">
    <Button
      iconOnly
      aria-label={sidebarTriggerLabel}
      aria-controls="agent-bureau-sidebar"
      aria-expanded={!sidebarCollapsed}
      class="navigation-toggle"
      size="sm"
      variant="secondary"
      onclick={toggleSidebar}
    >
      <Menu size={18} aria-hidden="true" />
    </Button>
  </div>
  <div class="sidebar-shell">
    <Sidebar
      id="agent-bureau-sidebar"
      bind:collapsed={sidebarCollapsed}
      label="Agent Bureau"
      class="sidebar"
    >
      {#snippet navigation()}
        {#if !sidebarCollapsed}
          <div class="sidebar-title">Agent Bureau</div>
        {/if}
        <SideNavigation ariaLabel="Primary navigation">
          {#each navigationLinks as link (link.href)}
            <SideNavigationItem
              href={link.href}
              active={isActive(link.href)}
              onclick={closeSidebarOnMobile}
            >
              {link.label}
            </SideNavigationItem>
          {/each}
        </SideNavigation>
      {/snippet}

      {#snippet footer()}
        <StatusDot connectionState={connectionStatus} />
      {/snippet}
    </Sidebar>
  </div>
  <div id="main-content" class="main-content" tabindex="-1">
    {@render children()}
  </div>
</div>
