/**
 * COR-1354 — the fresh-attempt artifact thresholds COR-894's owner ruling
 * deferred to this slice, fixed from the sample corpus in
 * `fixtures/samples/*.json`.
 *
 * The corpus is ten handoffs written by hand from the recorded history of ten
 * fix chains in this repository (COR-198, COR-219, COR-243, COR-1327,
 * COR-1329, COR-1331, COR-1332, COR-1333, COR-1334, COR-1346). No producer
 * exists yet (that is COR-634), so none was captured from a running one.
 * Every failure, fact, and instant comes from the record: commit messages and
 * times, Linear descriptions and comments, and the pull request #5 review.
 * The identifiers (artifact, session, and run ids, revisions, lineage, the
 * producing actor, and the carry-forward allowlist) are illustrative.
 *
 * A failure is dated at the earliest instant the record allows, and the
 * handoff at the author time of the commit that carried out its next
 * requested action; `samples.test.ts` lists the source of each instant. Each
 * failure-to-handoff span is therefore the widest the record allows. What the
 * corpus measured:
 *
 * - largest canonical serialization: 2,668 bytes (COR-1329);
 * - highest token entropy: 4.24 bits per character (a 30-character
 *   camelCase identifier; 64-character sha-256 hex digests peak at 3.92 and
 *   40-character git object ids at 3.87);
 * - longest span from a source attempt's first recorded failure to its
 *   handoff: 22.0 hours (COR-219, from the claim comment that reported the
 *   overwrite to the commit that fixed it); every other span is under 1.6
 *   hours;
 * - longest carry-forward allowlist: 4 sources.
 *
 * `samples.test.ts` recomputes each observation and fails when a constant no
 * longer covers it with the margin documented here, so a sample that outgrows
 * a threshold cannot land without the threshold being revisited.
 */

/**
 * Serialized-byte ceiling over the canonical serialization: 10 KiB, the
 * smallest whole KiB at least 3.5 times the largest sample (3.8 times). A
 * breach is a hard reject, never a truncation: truncating would silently drop
 * `knownFailures` or `unresolvedQuestions`.
 */
export const FRESH_ATTEMPT_ARTIFACT_MAX_BYTES = 10 * 1024;

/**
 * How long after its `timestamp` an artifact may seed a fresh attempt: seven
 * days. The corpus sets a floor of three times the longest failure-to-handoff
 * span (66 hours); seven days is 7.6 times that span, so a handoff survives a
 * weekend but not a week of the repository moving underneath it. Past this
 * the artifact still reads back from the store; it only fails validation as
 * stale.
 */
export const FRESH_ATTEMPT_ARTIFACT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How far an artifact's `timestamp` or `provenance.producedAt` may run ahead
 * of the validating clock: one minute. Not corpus-derived. It absorbs
 * ordinary drift between a producer's clock and a consumer's, while bounding
 * how far a future-dated artifact can stretch its window: without it, a
 * timestamp after `now` gives a negative age that never exceeds the retention
 * window, so the artifact would seed fresh attempts forever.
 */
export const FRESH_ATTEMPT_ARTIFACT_CLOCK_SKEW_MS = 60 * 1000;

/**
 * Shannon entropy, in bits per character, above which a token of at least
 * {@link FRESH_ATTEMPT_ARTIFACT_ENTROPY_MINIMUM_TOKEN_LENGTH} characters is
 * treated as a bare secret: 4.5, a quarter bit above the corpus maximum.
 * Hex digests can never reach it (a 16-symbol alphabet tops out at 4.0),
 * while a random base64 token of 40 characters averages about 4.8.
 */
export const FRESH_ATTEMPT_ARTIFACT_ENTROPY_THRESHOLD = 4.5;

/** Shortest run of token characters the entropy scan measures. */
export const FRESH_ATTEMPT_ARTIFACT_ENTROPY_MINIMUM_TOKEN_LENGTH = 20;

/**
 * Bound on `allowedCarryForwardContext`. `sealContextEpoch` records eight
 * sources, so an allowlist longer than that names more than one epoch holds.
 */
export const FRESH_ATTEMPT_ARTIFACT_MAX_CARRY_FORWARD_SOURCES = 8;
