import type { DurableRunDeps } from './types';

/**
 * Reconstructs a recovered run's behavior from durable configuration when its
 * deps are absent from the in-process registry (the cross-process recovery
 * case). The bureau registers one of these at boot; it rebuilds
 * `generate`/`toolbox`/`hooks` from the composition's own config plus the
 * persisted session/request for `runId`. Returns `null` when the run cannot be
 * reconstructed (e.g. an ad-hoc closure with no durable config) — the workflow
 * then terminates that run safely rather than the whole engine bricking.
 */
export type RunDepsReconstructor = (runId: string) => Promise<DurableRunDeps | null>;

/**
 * Process-lifetime registry mapping `runId` to its non-serializable
 * {@link DurableRunDeps}. Module-scoped on purpose: a Weft activity `execute`
 * function is a plain closure and can read module state, which is how the
 * durable workflow reaches the per-run toolbox without serializing it.
 */
const registry = new Map<string, DurableRunDeps>();

/** The currently-registered cross-process reconstructor, if any. */
let reconstructor: RunDepsReconstructor | undefined;

/** Register the per-run behavior for `runId`. Overwrites any prior entry. */
export function registerRunDeps(runId: string, deps: DurableRunDeps): void {
  registry.set(runId, deps);
}

/**
 * Register the boot-time deps reconstructor. The bureau sets this once at
 * composition; recovered runs whose deps are not already in the registry are
 * rebuilt through it (see {@link ensureRunDeps}).
 */
export function setRunDepsReconstructor(next: RunDepsReconstructor | undefined): void {
  reconstructor = next;
}

/**
 * Resolve the per-run behavior for `runId`.
 *
 * @throws {Error} when no deps are registered — this is the recovery gap made
 *   loud rather than silent: a recovered run whose deps were neither re-injected
 *   nor reconstructed (via {@link ensureRunDeps}) throws here instead of
 *   advancing with missing behavior.
 */
export function getRunDeps(runId: string): DurableRunDeps {
  const deps = registry.get(runId);
  if (!deps) {
    throw new Error(
      `No durable run deps registered for runId "${runId}". The run was recovered ` +
        `in a fresh process, but its behavior (generate/toolbox/hooks) could not be ` +
        `reconstructed from durable configuration. This typically means the run was ` +
        `created with an ad-hoc closure rather than a configuration a reconstructor ` +
        `can rebuild.`,
    );
  }
  return deps;
}

/**
 * Ensure deps exist for `runId`, reconstructing them via the registered
 * {@link RunDepsReconstructor} when absent. The durable workflow calls this as a
 * plain `await` (NOT as a `ctx.run` activity) so it re-evaluates on every
 * replay/recovery, picking up freshly registered deps from the new process
 * rather than replaying a stale cached result from the checkpoint.
 *
 * @returns `true` if deps are present (already registered or just
 *   reconstructed), `false` if the run cannot be reconstructed and should be
 *   terminated safely.
 */
export async function ensureRunDeps(runId: string): Promise<boolean> {
  if (registry.has(runId)) return true;
  if (!reconstructor) return false;
  const rebuilt = await reconstructor(runId);
  if (rebuilt === null) return false;
  registry.set(runId, rebuilt);
  return true;
}

/** Remove the per-run behavior for `runId`, e.g. after a run completes. */
export function clearRunDeps(runId: string): void {
  registry.delete(runId);
}

/** Test helper: clear the entire registry (and reconstructor) to simulate a fresh process. */
export function resetRunDepsRegistry(): void {
  registry.clear();
  reconstructor = undefined;
}
