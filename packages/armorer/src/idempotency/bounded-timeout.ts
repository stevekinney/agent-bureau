import type { RuntimeServices } from '@lostgradient/lifecycle';

import type { ToolExecuteOptions } from '../is-tool';

export const maximumTimerDelay = 2_147_483_647;

export function scheduleBoundedTimeout(
  callback: () => void,
  delay: number,
  runtime: RuntimeServices,
  setTimeoutFunction?: ToolExecuteOptions['setTimeoutFunction'],
  clearTimeoutFunction?: ToolExecuteOptions['clearTimeoutFunction'],
): () => void {
  const scheduleTimeout = setTimeoutFunction ?? runtime.timers.setTimeout;
  const cancelTimeout = clearTimeoutFunction ?? runtime.timers.clearTimeout;
  let remaining = Math.max(0, delay);
  let cancelled = false;
  let timer: unknown;
  const schedule = () => {
    if (cancelled) return;
    const chunk = Math.min(remaining, maximumTimerDelay);
    timer = scheduleTimeout(() => {
      if (cancelled) return;
      remaining -= chunk;
      if (remaining <= 0) callback();
      else schedule();
    }, chunk);
  };
  schedule();
  return () => {
    cancelled = true;
    if (timer !== undefined) cancelTimeout(timer);
  };
}
