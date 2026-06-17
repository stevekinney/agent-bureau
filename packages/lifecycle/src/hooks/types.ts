export type HookMap = Record<string, (...args: never[]) => unknown>;

export type HookErrorHandler = (
  error: unknown,
  context: { hookName: string; handlerIndex: number },
) => 'continue' | 'abort';

/**
 * How a hook behaves when its step re-runs on durable recovery (seam #11).
 *
 * - `safe` — read-only / no external side effect; re-running it is harmless.
 * - `effectful` — performs an external side effect (writes to a store, posts to
 *   a service). On a durable recovery the crashed in-flight step re-runs from its
 *   boundary, so an `effectful` hook fires AGAIN (at-least-once). The correct
 *   mitigation is to make the hook IDEMPOTENT (e.g. content/key-addressed writes),
 *   NOT to skip it on replay — skipping would drop the side effect for a step
 *   whose work (generate + tools) did re-execute. This classification is
 *   METADATA ONLY: it documents a hook's replay contract for authors and review.
 *   It does NOT gate execution, and nothing currently reads it at runtime —
 *   `HookRegistry` stores `replay` but does not act on it (a future dev-time
 *   warning could, but none exists yet). When unset, treat a hook as the
 *   conservative `effectful`.
 */
export type HookReplayPolicy = 'safe' | 'effectful';

export interface HookRegistrationOptions {
  priority?: number;
  onError?: HookErrorHandler;
  /**
   * Durable-recovery replay classification — see {@link HookReplayPolicy}.
   * Documentation/diagnostics only; never gates whether the hook runs.
   */
  replay?: HookReplayPolicy;
}

export interface HookRegistryOptions {
  onError?: HookErrorHandler;
}
