/**
 * Temporal fact-validity (AB-61 spike).
 *
 * Pure functions layered on top of the existing recall pipeline (hybrid
 * search → temporal decay → MMR) rather than forking it. A memory record is
 * "valid" over the half-open interval `[validFrom, invalidatedAt)`:
 *
 * - `validFrom` defaults to the record's `createdAt` when unset — a record is
 *   valid from the moment it exists unless the caller backdates it (e.g.
 *   importing a fact that was true before it was recorded).
 * - `invalidatedAt` is unset for currently-valid facts. It is stamped by
 *   {@link stampSupersession} when a newer fact supersedes this one.
 *
 * This is opt-in and additive: nothing here is called unless
 * `CreateMemoryOptions.experimentalTemporalValidity` is `true`, so existing
 * consumers see no behavior change.
 */

export interface TemporalValidityMetadata {
  validFrom?: number;
  invalidatedAt?: number;
  supersededBy?: string;
}

/**
 * Whether a record was valid at `asOf`, given its stored validity metadata
 * and its `createdAt` (the fallback for an unset `validFrom`).
 */
export function isValidAtTimestamp(
  metadata: TemporalValidityMetadata,
  createdAt: number,
  asOf: number,
): boolean {
  const validFrom = metadata.validFrom ?? createdAt;
  if (validFrom > asOf) return false;

  const invalidatedAt = metadata.invalidatedAt;
  if (invalidatedAt !== undefined && invalidatedAt <= asOf) return false;

  return true;
}

/**
 * Filters a result set down to records valid at `asOf`. Returns a new array;
 * does not mutate the input. Intended to run early in `recall()` — before
 * temporal decay and MMR — so downstream reranking only ever sees the
 * as-of-valid candidate pool.
 */
export function filterByValidity<
  T extends { metadata: TemporalValidityMetadata; createdAt: number },
>(results: T[], asOf: number): T[] {
  return results.filter((result) => isValidAtTimestamp(result.metadata, result.createdAt, asOf));
}

/**
 * Stamps `supersededBy` and `invalidatedAt` onto an existing record's
 * metadata, marking it invalid as of `invalidatedAt`. Returns a new metadata
 * object; does not mutate the input. Callers persist the result via
 * `storage.update(existingId, scope, { metadata })`.
 */
export function stampSupersession(
  metadata: Record<string, unknown>,
  supersededBy: string,
  invalidatedAt: number,
): Record<string, unknown> {
  return { ...metadata, supersededBy, invalidatedAt };
}
