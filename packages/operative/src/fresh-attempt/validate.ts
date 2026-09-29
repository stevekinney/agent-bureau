import type { z } from 'zod';

import type { ContextSourceRecord, EffectiveContextEpoch } from '../context-epoch';
import type { FreshAttemptRejectionDiagnostic } from './errors';
import {
  CorruptFreshAttemptArtifactError,
  IncompatibleFreshAttemptArtifactError,
  InvalidFreshAttemptArtifactError,
  OverbroadFreshAttemptArtifactError,
  OversizedFreshAttemptArtifactError,
  ProvenanceFreeFreshAttemptArtifactError,
  SecretBearingFreshAttemptArtifactError,
  StaleFreshAttemptArtifactError,
  UnauthorizedFreshAttemptArtifactError,
} from './errors';
import { formatFieldPath, valueAtFieldPath } from './field-path';
import type {
  FreshAttemptHandoffArtifact,
  FreshAttemptSourceRunOrAttempt,
} from './handoff-artifact';
import {
  FRESH_ATTEMPT_ARTIFACT_SCHEMA_VERSION,
  canonicalizeFreshAttemptValue,
  computeFreshAttemptArtifactDigest,
  freshAttemptHandoffArtifactSchema,
} from './handoff-artifact';
import {
  findSecretBearingFields,
  findTranscriptShape,
  isProtectedContextSource,
} from './secret-scan';
import {
  FRESH_ATTEMPT_ARTIFACT_CLOCK_SKEW_MS,
  FRESH_ATTEMPT_ARTIFACT_MAX_BYTES,
  FRESH_ATTEMPT_ARTIFACT_MAX_CARRY_FORWARD_SOURCES,
  FRESH_ATTEMPT_ARTIFACT_RETENTION_MS,
} from './thresholds';

/** What the validator needs to know about the run an artifact hands off from. */
export interface FreshAttemptSourceRecord {
  /** The producing run's sealed effective-context epoch. */
  readonly epoch: EffectiveContextEpoch;
  /** Actors (`provenance.producingActor`) permitted to publish for this run. */
  readonly permittedActors: readonly string[];
}

/**
 * Resolves the record for an artifact's `sourceRunOrAttempt`. Returning
 * `undefined` fails authorization closed: no principal can be established
 * for a run nobody can vouch for.
 */
export type FreshAttemptSourceResolver = (
  source: FreshAttemptSourceRunOrAttempt,
) => FreshAttemptSourceRecord | undefined | Promise<FreshAttemptSourceRecord | undefined>;

export interface FreshAttemptValidationContext {
  readonly resolveSource: FreshAttemptSourceResolver;
  /**
   * Wall-clock milliseconds. Neither `timestamp` nor `provenance.producedAt`
   * may run ahead of it by more than the clock-skew allowance; at consumption
   * the retention window is measured against it as well.
   */
  readonly now: number;
}

export interface ValidatedFreshAttemptArtifact {
  readonly artifact: FreshAttemptHandoffArtifact;
  readonly source: FreshAttemptSourceRecord;
  /** The epoch records for `allowedCarryForwardContext`, in allowlist order. */
  readonly carryForward: readonly ContextSourceRecord[];
}

const PROVENANCE_FIELDS: ReadonlySet<PropertyKey> = new Set([
  'producer',
  'provenance',
  'sourceRunOrAttempt',
  'timestamp',
]);

function issueDiagnostics(
  root: unknown,
  issue: z.core.$ZodIssue,
): FreshAttemptRejectionDiagnostic[] {
  if (issue.code === 'unrecognized_keys') {
    return issue.keys.map((key) => ({
      path: formatFieldPath([...issue.path, key]),
      rule: issue.code,
    }));
  }
  const missing = valueAtFieldPath(root, issue.path) === undefined;
  return [{ path: formatFieldPath(issue.path), rule: missing ? 'required' : issue.code }];
}

/**
 * The schema stage. An incompatible `schemaVersion` fails before the body is
 * read at all, mirroring `UnsupportedRunResultVersionError`: an old or future
 * payload is never dual-read. A transcript-shaped value is classified as a
 * policy violation before the strict schema would call it a shape defect.
 */
function parseArtifact(value: unknown): FreshAttemptHandoffArtifact {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvalidFreshAttemptArtifactError([{ path: '', rule: 'not-an-object' }]);
  }
  const schemaVersion = (value as Record<string, unknown>)['schemaVersion'];
  if (
    typeof schemaVersion === 'number' &&
    schemaVersion !== FRESH_ATTEMPT_ARTIFACT_SCHEMA_VERSION
  ) {
    throw new IncompatibleFreshAttemptArtifactError([
      { path: 'schemaVersion', rule: 'unsupported-schema-version' },
    ]);
  }
  const transcript = findTranscriptShape(value);
  if (transcript !== undefined) throw new SecretBearingFreshAttemptArtifactError([transcript]);

  const result = freshAttemptHandoffArtifactSchema.safeParse(value);
  if (result.success) return result.data;

  const { issues } = result.error;
  const diagnostics = issues.flatMap((issue) => issueDiagnostics(value, issue));
  const provenanceFree = issues.some(
    (issue) =>
      PROVENANCE_FIELDS.has(issue.path[0] ?? '') &&
      valueAtFieldPath(value, issue.path) === undefined,
  );
  throw provenanceFree
    ? new ProvenanceFreeFreshAttemptArtifactError(diagnostics)
    : new InvalidFreshAttemptArtifactError(diagnostics);
}

async function authorize(
  artifact: FreshAttemptHandoffArtifact,
  resolveSource: FreshAttemptSourceResolver,
): Promise<FreshAttemptSourceRecord> {
  const source = await resolveSource(artifact.sourceRunOrAttempt);
  if (source === undefined) {
    throw new UnauthorizedFreshAttemptArtifactError([
      { path: 'sourceRunOrAttempt', rule: 'source-unresolved' },
    ]);
  }
  const diagnostics: FreshAttemptRejectionDiagnostic[] = [];
  if (artifact.producer.sessionId !== artifact.sourceRunOrAttempt.sessionId) {
    diagnostics.push({ path: 'producer.sessionId', rule: 'producer-source-mismatch' });
  }
  if (artifact.producer.runId !== artifact.sourceRunOrAttempt.runId) {
    diagnostics.push({ path: 'producer.runId', rule: 'producer-source-mismatch' });
  }
  if (!source.permittedActors.includes(artifact.provenance.producingActor)) {
    diagnostics.push({ path: 'provenance.producingActor', rule: 'actor-not-permitted' });
  }
  if (diagnostics.length > 0) throw new UnauthorizedFreshAttemptArtifactError(diagnostics);
  return source;
}

function resolveCarryForward(
  artifact: FreshAttemptHandoffArtifact,
  epoch: EffectiveContextEpoch,
): ContextSourceRecord[] {
  const allowlist = artifact.allowedCarryForwardContext;
  if (allowlist.length > FRESH_ATTEMPT_ARTIFACT_MAX_CARRY_FORWARD_SOURCES) {
    throw new OverbroadFreshAttemptArtifactError([
      { path: 'allowedCarryForwardContext', rule: 'exceeds-bounded-count' },
    ]);
  }
  const diagnostics: FreshAttemptRejectionDiagnostic[] = [];
  const records: ContextSourceRecord[] = [];
  for (const [index, sourceId] of allowlist.entries()) {
    const path = formatFieldPath(['allowedCarryForwardContext', index]);
    const record = epoch.sources.find((candidate) => candidate.sourceId === sourceId);
    if (record === undefined) {
      diagnostics.push({ path, rule: 'source-absent-from-epoch' });
    } else if (isProtectedContextSource(record)) {
      diagnostics.push({ path, rule: 'source-not-carriable' });
    } else {
      records.push(record);
    }
  }
  if (diagnostics.length > 0) throw new OverbroadFreshAttemptArtifactError(diagnostics);
  return records;
}

/**
 * The staleness stage. An artifact may seed only while `now` lies inside
 * `[timestamp, timestamp + retention]`. The lower edge is checked everywhere:
 * a date after `now` (beyond the skew allowance) would give a negative age
 * that never exceeds the window, so without it a future-dated artifact would
 * never go stale. `provenance.producedAt` gets the same lower edge. The upper
 * edge, retention, applies only at consumption.
 */
function assertInsideWindow(
  artifact: FreshAttemptHandoffArtifact,
  now: number,
  applyRetention: boolean,
): void {
  const diagnostics: FreshAttemptRejectionDiagnostic[] = [];
  const dates: [path: string, value: string][] = [
    ['timestamp', artifact.timestamp],
    ['provenance.producedAt', artifact.provenance.producedAt],
  ];
  for (const [path, date] of dates) {
    if (Date.parse(date) - now > FRESH_ATTEMPT_ARTIFACT_CLOCK_SKEW_MS) {
      diagnostics.push({ path, rule: 'timestamp-in-future' });
    }
  }
  if (
    applyRetention &&
    now - Date.parse(artifact.timestamp) > FRESH_ATTEMPT_ARTIFACT_RETENTION_MS
  ) {
    diagnostics.push({ path: 'timestamp', rule: 'retention-window' });
  }
  if (diagnostics.length > 0) throw new StaleFreshAttemptArtifactError(diagnostics);
}

/**
 * Runs COR-894's four consumption checks in their fixed order (schema, digest,
 * staleness and retention, authorization) with the publish-time checks around
 * them: the byte ceiling after the schema, and the secret-bearing and
 * overbroad checks after authorization, once the producing run's epoch is
 * known. Retention applies only at consumption; every other check, including
 * the rejection of a future date, runs at both.
 */
async function runChecks(
  value: unknown,
  context: FreshAttemptValidationContext,
  applyRetention: boolean,
): Promise<ValidatedFreshAttemptArtifact> {
  const artifact = parseArtifact(value);

  const bytes = new TextEncoder().encode(canonicalizeFreshAttemptValue(artifact)).byteLength;
  if (bytes > FRESH_ATTEMPT_ARTIFACT_MAX_BYTES) {
    throw new OversizedFreshAttemptArtifactError([{ path: '', rule: 'exceeds-byte-ceiling' }]);
  }

  if ((await computeFreshAttemptArtifactDigest(artifact)) !== artifact.digest.value) {
    throw new CorruptFreshAttemptArtifactError([{ path: 'digest.value', rule: 'digest-mismatch' }]);
  }

  assertInsideWindow(artifact, context.now, applyRetention);

  const source = await authorize(artifact, context.resolveSource);

  const secrets = findSecretBearingFields(artifact, source.epoch);
  if (secrets.length > 0) throw new SecretBearingFreshAttemptArtifactError(secrets);

  return { artifact, source, carryForward: resolveCarryForward(artifact, source.epoch) };
}

/**
 * Validates an artifact before it is written. Every check except retention
 * runs: an artifact past its window is still a legitimate audit record. One
 * dated after `context.now` is rejected, though: stored, it would become
 * usable once that date arrived and stay usable for a full window after it,
 * long past the moment it was really produced.
 */
export function validateFreshAttemptArtifactForPublication(
  value: unknown,
  context: FreshAttemptValidationContext,
): Promise<ValidatedFreshAttemptArtifact> {
  return runChecks(value, context, false);
}

/**
 * Validates an artifact before a fresh attempt consumes it. Runs every
 * publish-time check as well, because the artifact a caller hands a
 * `fresh-from-artifact` policy need not have come through the store.
 */
export function validateFreshAttemptArtifact(
  value: unknown,
  context: FreshAttemptValidationContext,
): Promise<ValidatedFreshAttemptArtifact> {
  return runChecks(value, context, true);
}
