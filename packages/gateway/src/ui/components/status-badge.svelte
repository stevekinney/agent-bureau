<script lang="ts" module>
  import type { BadgeVariant } from '@lostgradient/cinder/badge';

  /**
   * Maps a run status string onto a cinder {@link BadgeVariant}. The bureau
   * emits `running`, `completed`, `error`, and `aborted` (plus a transient
   * `pending` before the first step); anything unrecognized falls back to the
   * neutral variant so a new status never renders as an unstyled label.
   */
  function statusToVariant(status: string): BadgeVariant {
    switch (status) {
      case 'running':
        return 'info';
      case 'completed':
        return 'success';
      case 'error':
        return 'danger';
      case 'aborted':
        return 'warning';
      case 'pending':
        return 'accent';
      default:
        return 'neutral';
    }
  }
</script>

<script lang="ts">
  import { Badge } from '@lostgradient/cinder/badge';

  let { status }: { status: string } = $props();

  const variant = $derived(statusToVariant(status));
</script>

<Badge {variant} size="sm">{status}</Badge>
