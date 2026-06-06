<script lang="ts">
  import { ConnectionIndicator as CinderConnectionIndicator } from '@lostgradient/cinder/connection-indicator';
  import type { ConnectionState } from '@lostgradient/cinder/connection-indicator';

  import type { ConnectionStatus } from '../hooks/use-websocket.svelte';

  let { status }: { status: ConnectionStatus } = $props();

  // `ConnectionStatus` ('connecting' | 'connected' | 'disconnected') is a
  // subset of cinder's `ConnectionState`, so the value passes through directly.
  const state = $derived<ConnectionState>(status);
</script>

<CinderConnectionIndicator {state} />
