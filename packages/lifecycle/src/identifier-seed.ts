/**
 * Identifier-seed derivation for {@link createManualRuntimeServices}
 * (AB-337's Coordinator ruling on AB-337: resolution 2). Split out of
 * `manual-runtime-services.ts` so the one real-globals call this package
 * needs for identifier disambiguation — generating a process-unique
 * fallback seed when a caller supplies none — stays confined to this tiny
 * file instead of diluting `manual-runtime-services.ts`'s own "never
 * touches a real global" invariant. `scripts/determinism-manifest.json`'s
 * `realRuntimeExemptions` carries this file's rationale in full.
 */

/**
 * FNV-1a — a small, dependency-free string hash. Two calls with the same
 * `seed` always return the same value; different seeds are astronomically
 * unlikely to collide (32-bit output space) for the handful of seeds any
 * one test suite compares. Exported so `manual-runtime-services.ts` shares
 * this one implementation instead of duplicating it to seed its PRNG.
 */
export function hashSeed(seed: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index++) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Derives a short, stable, deterministic prefix from an `identifierSeed`:
 * the same seed always derives the same prefix, and two different seeds
 * derive different prefixes (short of a 32-bit hash collision) — never
 * touches a real global. Embedded on every identifier
 * {@link createManualRuntimeServices}'s `identifiers.next(kind)` mints, so
 * two runtimes constructed with different seeds can never mint the same
 * identifier (AB-337), while two runtimes constructed with the same seed
 * still mint byte-identical sequences (AB-92's reproduction guarantee).
 */
export function deriveIdentifierPrefix(seed: string): string {
  return hashSeed(seed).toString(36);
}

/**
 * Generates a process-unique identifier seed for
 * {@link createManualRuntimeServices} to fall back to when a caller
 * constructs one without an explicit `identifierSeed`. This is the ONLY
 * real-globals call in this module (`crypto.randomUUID()`) and exists for
 * exactly one reason: two independently constructed manual runtimes with no
 * explicit seed — most concretely, the same crash-conformance fixture
 * re-launched as a fresh OS process after a `SIGKILL` (AB-270, AB-321) —
 * must never derive the same identifier prefix, and no purely deterministic
 * function of in-process state (a module-level counter, a fixed literal)
 * can differ across a process boundary the way this must. A caller that
 * needs a reproducible sequence still passes an explicit `identifierSeed`
 * (AB-92, AB-263's reproduction artifact) — this fallback only ever backs
 * the *unpinned* default, which by construction can never be replayed
 * byte-for-byte across processes and was never meant to be.
 */
export function generateProcessUniqueIdentifierSeed(): string {
  return crypto.randomUUID();
}
