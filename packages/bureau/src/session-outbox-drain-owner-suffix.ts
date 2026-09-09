/**
 * The one real-globals call `create-bureau.ts`'s session-outbox drain-owner
 * id needs (AB-390). Split into its own tiny file — mirroring lifecycle's
 * `identifier-seed.ts`, which does the same thing for the identical reason
 * — so this module's `scripts/determinism-manifest.json` exemption covers
 * ONLY this one call, never `create-bureau.ts` as a whole: that file stays
 * fully covered by the `determinism/no-real-runtime-call` gate for every
 * other real-clock/timer/random call it must never make.
 */

/**
 * Generates the real-randomness suffix appended to `create-bureau.ts`'s
 * session-outbox drain-owner id (Codex P1 review finding, PR #599, "Use an
 * owner identifier unique across runtime instances"). `RuntimeServices`'
 * `identifiers.next()` is not itself a cross-PROCESS uniqueness guarantee —
 * `createManualRuntimeServices()`'s own contract lets two independently
 * constructed instances with the same `identifierSeed` intentionally mint
 * identical sequences (exact reproduction is the point of that seam), so
 * two bureau processes built that way would otherwise mint the SAME
 * drain-owner id, and `SessionStore.outbox.claim()` treats a matching
 * owner as same-owner renewal — exactly the cross-owner exclusivity the
 * claim lease exists to enforce, silently defeated.
 *
 * This mirrors what `createDefaultRuntimeServices()` itself does
 * internally for the identical reason
 * (`lifecycle/src/runtime-services.ts`, itself carrying the matching
 * exemption): real randomness is the right tool for a value that must be
 * globally unique regardless of injected determinism, and is never
 * serialized into any reproduction artifact, run report, or other
 * reproducible-output surface this codebase's determinism guarantees
 * actually cover — a drain-owner id is transient claim-lease bookkeeping,
 * read back only by `outbox.claim()`'s own compare-and-swap, never
 * asserted on by a test or replayed from a stored artifact.
 */
export function generateSessionOutboxDrainOwnerSuffix(): string {
  return crypto.randomUUID();
}
