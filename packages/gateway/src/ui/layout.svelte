<script lang="ts">
  import type { Snippet } from 'svelte';

  import { SideNavigation } from '@lostgradient/cinder/side-navigation';
  import { SideNavigationItem } from '@lostgradient/cinder/side-navigation-item';
  import { SkipLink } from '@lostgradient/cinder/skip-link';

  import ConnectionIndicator from './components/connection-indicator.svelte';
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
  <SideNavigation ariaLabel="Primary navigation" class="sidebar">
    <li class="sidebar-title">Agent Bureau</li>
    {#each navigationLinks as link (link.href)}
      <SideNavigationItem href={link.href} active={isActive(link.href)}>
        {link.label}
      </SideNavigationItem>
    {/each}
    <li class="sidebar-footer">
      <ConnectionIndicator status={connectionStatus} />
    </li>
  </SideNavigation>
  <div id="main-content" class="main-content">
    {@render children()}
  </div>
</div>
