import type { RuntimeTimers } from 'lifecycle';
import { createDefaultRuntimeServices } from 'lifecycle';

// Resolved once, lazily, at module scope — not per call. `createDefaultRuntimeServices()`
// also sets up identifier and deferred-work tracking state that a bare `timers` seam never
// needs, so minting a fresh instance on every `sleep()` call (the real-globals default path)
// would be an avoidable per-call allocation. `timers` is stateless (each method just wraps
// `globalThis.setTimeout`/`clearTimeout`), so one shared instance is safe to reuse forever.
let defaultTimers: RuntimeTimers | undefined;
function resolveDefaultTimers(): RuntimeTimers {
  defaultTimers ??= createDefaultRuntimeServices().timers;
  return defaultTimers;
}

/**
 * Portable async sleep utility, driven entirely by the composed
 * `RuntimeServices.timers` seam (AB-92/AB-253) rather than a process-global
 * `setTimeout`/`Bun.sleep`. Omitting `timers` resolves the real-globals
 * default (resolved once, lazily, and reused) — today's behavior — while a
 * scheduler constructed with a manual runtime passes its own `timers` so
 * every sleep it drives is fully time-controlled by `advance()`.
 */
export async function sleep(milliseconds: number, timers?: RuntimeTimers): Promise<void> {
  const resolvedTimers = timers ?? resolveDefaultTimers();
  return new Promise((resolve) => {
    resolvedTimers.setTimeout(resolve, milliseconds);
  });
}
