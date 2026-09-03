import type { RuntimeTimers } from 'lifecycle';
import { createDefaultRuntimeServices } from 'lifecycle';

/**
 * Portable async sleep utility, driven entirely by the composed
 * `RuntimeServices.timers` seam (AB-92/AB-253) rather than a process-global
 * `setTimeout`/`Bun.sleep`. Omitting `timers` resolves the real-globals
 * default via `createDefaultRuntimeServices()` — today's behavior — while a
 * scheduler constructed with a manual runtime passes its own `timers` so
 * every sleep it drives is fully time-controlled by `advance()`.
 */
export async function sleep(milliseconds: number, timers?: RuntimeTimers): Promise<void> {
  const resolvedTimers = timers ?? createDefaultRuntimeServices().timers;
  return new Promise((resolve) => {
    resolvedTimers.setTimeout(resolve, milliseconds);
  });
}
