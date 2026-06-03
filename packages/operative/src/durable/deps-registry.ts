import type { Toolbox } from 'armorer';

import type { EventDispatcher } from '../run-step';
import type { RunOptions } from '../types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Toolbox generic variance; the durable layer never inspects the tool-tuple type parameter (matches gateway's GatewayToolbox).
type AnyToolbox = Toolbox<any>;

/**
 * The non-serializable, per-run behavior a durable workflow needs but cannot
 * checkpoint: the `generate` function, the `toolbox`, the hook registry, the
 * event emitter, and the other closures from {@link RunOptions}. Checkpoints
 * persist run *state* (cursor, transcript, step records); this registry holds
 * run *behavior*.
 *
 * @remarks
 * This is the load-bearing half of the recovery story. On a fresh-process
 * recovery, this registry is empty: `Engine.create({ recover: true })` relaunches
 * the generator, but the workflow body cannot advance a step without these
 * closures. They must be re-injected on recovery before the resumed generator is
 * driven forward.
 *
 * TODO(weft-integration): wire re-injection into the engine's recoverAll boot
 * path (design seam #5) — per recovered WorkflowHandle, repopulate this registry
 * from the run's persisted options/launch context before the generator advances.
 * Until then, only runs launched in the current process can advance; a run
 * resumed in a fresh process stalls at the first activity that needs deps.
 */
export interface DurableRunDeps {
  options: RunOptions;
  toolbox: AnyToolbox;
  /**
   * The event emitter the run's steps dispatch to. Present under inline mode so
   * the durable path emits the same `CombinedOperativeEventMap` events as the
   * in-memory loop (hooks/events parity); `undefined` for a headless durable run
   * with no observable surface.
   */
  emitter?: EventDispatcher;
}

/**
 * Process-lifetime registry mapping `runId` to its non-serializable
 * {@link DurableRunDeps}. Module-scoped on purpose: a Weft activity `execute`
 * function is a plain closure and can read module state, which is how the
 * durable workflow reaches the per-run toolbox without serializing it.
 */
const registry = new Map<string, DurableRunDeps>();

/** Register the per-run behavior for `runId`. Overwrites any prior entry. */
export function registerRunDeps(runId: string, deps: DurableRunDeps): void {
  registry.set(runId, deps);
}

/**
 * Resolve the per-run behavior for `runId`.
 *
 * @throws {Error} when no deps are registered — this is the recovery gap made
 *   loud rather than silent: a recovered run whose deps were never re-injected
 *   throws here instead of advancing with missing behavior.
 */
export function getRunDeps(runId: string): DurableRunDeps {
  const deps = registry.get(runId);
  if (!deps) {
    throw new Error(
      `No durable run deps registered for runId "${runId}". ` +
        `The run was likely recovered in a fresh process without re-injecting its ` +
        `generate/toolbox/hooks (see TODO(weft-integration) deps re-injection seam #5).`,
    );
  }
  return deps;
}

/** Remove the per-run behavior for `runId`, e.g. after a run completes. */
export function clearRunDeps(runId: string): void {
  registry.delete(runId);
}

/** Test helper: clear the entire registry to simulate a fresh process. */
export function resetRunDepsRegistry(): void {
  registry.clear();
}
