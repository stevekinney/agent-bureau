<script lang="ts">
  import type { Snippet } from 'svelte';
  import { onMount } from 'svelte';

  import { Button } from '@lostgradient/cinder/button';
  import { SideNavigation } from '@lostgradient/cinder/side-navigation';
  import { SideNavigationItem } from '@lostgradient/cinder/side-navigation-item';
  import { Sidebar } from '@lostgradient/cinder/sidebar';
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
    { href: '/chat', label: 'Chat' },
    { href: '/configuration', label: 'Configuration' },
  ];

  let {
    children,
    connectionStatus,
    pathname,
  }: {
    children: Snippet;
    connectionStatus: ConnectionStatus;
    pathname: string;
  } = $props();

  let sidebarCollapsed = $state(false);
  let mobileSidebar = $state(false);

  const openSidebar = () => {
    sidebarCollapsed = false;
  };

  const closeSidebarOnMobile = () => {
    if (mobileSidebar) {
      sidebarCollapsed = true;
    }
  };

  onMount(() => {
    const mediaQuery = window.matchMedia('(max-width: 47.99rem)');
    const syncSidebarState = () => {
      mobileSidebar = mediaQuery.matches;
      sidebarCollapsed = mediaQuery.matches;
    };

    syncSidebarState();
    mediaQuery.addEventListener('change', syncSidebarState);

    return () => {
      mediaQuery.removeEventListener('change', syncSidebarState);
    };
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

<div class="layout">
  <SkipLink target="main-content" />
  <div class="mobile-navigation-toggle">
    <Button
      iconOnly
      aria-label="Open navigation"
      class="navigation-toggle"
      size="sm"
      variant="secondary"
      onclick={openSidebar}
    >
      <Menu size={18} aria-hidden="true" />
    </Button>
  </div>
  <Sidebar bind:collapsed={sidebarCollapsed} label="Agent Bureau" class="sidebar">
    {#snippet brand()}
      <div class="sidebar-title">Agent Bureau</div>
    {/snippet}

    {#snippet navigation()}
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
  <div id="main-content" class="main-content" tabindex="-1">
    {@render children()}
  </div>
</div>
