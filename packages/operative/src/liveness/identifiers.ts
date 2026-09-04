import { createDefaultRuntimeServices, type RuntimeServices } from 'lifecycle';

/**
 * The standalone-run identifier seam (AB-88's Amendment 1, corrected by
 * AB-214's coordinator rulings 2026-09-02, migrated onto `RuntimeServices`
 * by AB-325).
 *
 * A standalone (non-Bureau) run mints a process-local id at `ActiveRun`
 * construction from this seam, never a bare `crypto.randomUUID()` call
 * reached from inside run logic. It populates `LivenessSnapshot.id`
 * uniformly for standalone and Bureau-started runs; it is never registered
 * with Bureau's `Store` and confers no locator or reattachment capability.
 *
 * `createActiveRun` (`create-run.ts`) itself now mints a standalone run's id
 * straight from its resolved `RuntimeServices.identifiers` and no longer
 * reaches this module by default — this seam remains only as the
 * `CreateActiveRunDependencies.identifiers` explicit-override escape hatch,
 * and as public API on the `@lostgradient/operative/liveness` subpath.
 */
export interface RunIdentifierSeam {
  /** Mints the next process-local run id. */
  next(): string;
}

/**
 * The default seam: reads through a `RuntimeServices.identifiers` instance
 * (AB-92/AB-252/AB-325) rather than a bare `crypto.randomUUID()` call, so a
 * manual runtime controls its output. Composition-root only — never reached
 * from inside run logic a test would need to replace. Tests inject their
 * own {@link RunIdentifierSeam} instead of relying on this default's
 * output.
 */
export function createDefaultRunIdentifierSeam(
  runtime: RuntimeServices = createDefaultRuntimeServices(),
): RunIdentifierSeam {
  return {
    next(): string {
      return runtime.identifiers.next('run');
    },
  };
}

/**
 * The process-wide default instance, used by `createActiveRun` when no
 * `RunIdentifierSeam` is injected. Reads through the real `RuntimeServices`
 * implementation — a single shared counter keeps ids ordered across every
 * standalone run minted in this process.
 */
export const defaultRunIdentifierSeam: RunIdentifierSeam = createDefaultRunIdentifierSeam();
