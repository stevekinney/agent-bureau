/**
 * The standalone-run identifier seam (AB-88's Amendment 1, corrected by
 * AB-214's coordinator rulings 2026-09-02).
 *
 * A standalone (non-Bureau) run mints a process-local id at `ActiveRun`
 * construction from this seam, never a bare `crypto.randomUUID()` call
 * reached from inside run logic. It populates `LivenessSnapshot.id`
 * uniformly for standalone and Bureau-started runs; it is never registered
 * with Bureau's `Store` and confers no locator or reattachment capability.
 *
 * AB-88's own text names this seam `RuntimeServices.identifiers` (AB-92);
 * that seam does not exist in this repository as of this change. This
 * module is the narrower local seam AB-214 builds instead — a migration
 * candidate, not a divergence to leave standing, once AB-92/AB-93 land
 * `RuntimeServices.identifiers`.
 */
export interface RunIdentifierSeam {
  /** Mints the next process-local run id. */
  next(): string;
}

/**
 * The default seam: a monotonic in-process counter. Composition-root only —
 * never reached from inside run logic a test would need to replace. Tests
 * inject their own {@link RunIdentifierSeam} instead of relying on this
 * default's output.
 */
export function createDefaultRunIdentifierSeam(): RunIdentifierSeam {
  let counter = 0;
  return {
    next(): string {
      counter += 1;
      return `run-${counter}-${crypto.randomUUID()}`;
    },
  };
}

/**
 * The process-wide default instance, used by `createActiveRun` when no
 * `RunIdentifierSeam` is injected. A single shared counter keeps ids ordered
 * across every standalone run minted in this process.
 */
export const defaultRunIdentifierSeam: RunIdentifierSeam = createDefaultRunIdentifierSeam();
