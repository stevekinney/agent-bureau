import { AgentRunError, type AgentRunErrorKind } from '../errors';

/** COR-894's rejection taxonomy for a fresh-attempt handoff artifact. */
export type FreshAttemptRejectionOutcome =
  | 'invalid'
  | 'stale'
  | 'incompatible'
  | 'oversized'
  | 'secret-bearing'
  | 'unauthorized'
  | 'overbroad'
  | 'provenance-free'
  | 'corrupt';

/**
 * Where a rejection fired and which rule fired it. There is deliberately no
 * field for the offending value: a diagnostic that echoed a matched secret
 * would become a second place that secret leaks.
 */
export interface FreshAttemptRejectionDiagnostic {
  /** Field path such as `knownFailures[0].summary`; `''` is the artifact itself. */
  readonly path: string;
  readonly rule: string;
}

function describeRejection(
  outcome: FreshAttemptRejectionOutcome,
  diagnostics: readonly FreshAttemptRejectionDiagnostic[],
): string {
  const detail = diagnostics
    .map(
      (diagnostic) =>
        `${diagnostic.path === '' ? '<artifact>' : diagnostic.path} (${diagnostic.rule})`,
    )
    .join('; ');
  return `Fresh-attempt handoff artifact rejected as ${outcome}: ${detail}`;
}

/**
 * Base class for every fresh-attempt artifact rejection. Each subclass fixes
 * its outcome and its COR-843 `kind`, so a rejection surfaces through the same
 * terminal-result vocabulary as the rest of the runtime.
 */
export class FreshAttemptArtifactError extends AgentRunError {
  readonly outcome: FreshAttemptRejectionOutcome;
  readonly diagnostics: readonly FreshAttemptRejectionDiagnostic[];

  protected constructor(
    outcome: FreshAttemptRejectionOutcome,
    kind: AgentRunErrorKind,
    diagnostics: readonly FreshAttemptRejectionDiagnostic[],
  ) {
    super(describeRejection(outcome, diagnostics), {
      kind,
      // Not a new code: `AgentRunErrorCode` is mirrored by Chat's wire
      // contract (COR-248), so the class name and kind identify a rejection.
      code: 'UNKNOWN',
    });
    this.name = 'FreshAttemptArtifactError';
    this.outcome = outcome;
    this.diagnostics = diagnostics;
  }
}

/** Fails the artifact schema. */
export class InvalidFreshAttemptArtifactError extends FreshAttemptArtifactError {
  constructor(diagnostics: readonly FreshAttemptRejectionDiagnostic[]) {
    super('invalid', 'contract', diagnostics);
    this.name = 'InvalidFreshAttemptArtifactError';
  }
}

/**
 * Stale in either sense COR-894 names: outside its retention window at
 * consumption, or published against a `revision` that is no longer current.
 * The diagnostic's rule says which: `retention-window` when `now` is past the
 * window, `timestamp-in-future` when a date is after `now` (at publication
 * as well as consumption), and `revision-conflict` for a lost write.
 */
export class StaleFreshAttemptArtifactError extends FreshAttemptArtifactError {
  constructor(diagnostics: readonly FreshAttemptRejectionDiagnostic[]) {
    super('stale', 'load', diagnostics);
    this.name = 'StaleFreshAttemptArtifactError';
  }
}

/** Carries a `schemaVersion` this consumer does not read. Never dual-read. */
export class IncompatibleFreshAttemptArtifactError extends FreshAttemptArtifactError {
  constructor(diagnostics: readonly FreshAttemptRejectionDiagnostic[]) {
    super('incompatible', 'contract', diagnostics);
    this.name = 'IncompatibleFreshAttemptArtifactError';
  }
}

/** Exceeds the serialized byte ceiling. Rejected, never truncated. */
export class OversizedFreshAttemptArtifactError extends FreshAttemptArtifactError {
  constructor(diagnostics: readonly FreshAttemptRejectionDiagnostic[]) {
    super('oversized', 'contract', diagnostics);
    this.name = 'OversizedFreshAttemptArtifactError';
  }
}

/** Carries transcript content, a credential, a protected source, or a high-entropy token. */
export class SecretBearingFreshAttemptArtifactError extends FreshAttemptArtifactError {
  constructor(diagnostics: readonly FreshAttemptRejectionDiagnostic[]) {
    super('secret-bearing', 'policy', diagnostics);
    this.name = 'SecretBearingFreshAttemptArtifactError';
  }
}

/** `producer`/`provenance` does not match the principal permitted for its source run. */
export class UnauthorizedFreshAttemptArtifactError extends FreshAttemptArtifactError {
  constructor(diagnostics: readonly FreshAttemptRejectionDiagnostic[]) {
    super('unauthorized', 'policy', diagnostics);
    this.name = 'UnauthorizedFreshAttemptArtifactError';
  }
}

/** Allowlists a source its producing epoch does not hold or does not let leave. */
export class OverbroadFreshAttemptArtifactError extends FreshAttemptArtifactError {
  constructor(diagnostics: readonly FreshAttemptRejectionDiagnostic[]) {
    super('overbroad', 'contract', diagnostics);
    this.name = 'OverbroadFreshAttemptArtifactError';
  }
}

/** Lacks `producer`, `provenance`, `sourceRunOrAttempt`, or `timestamp`. */
export class ProvenanceFreeFreshAttemptArtifactError extends FreshAttemptArtifactError {
  constructor(diagnostics: readonly FreshAttemptRejectionDiagnostic[]) {
    super('provenance-free', 'contract', diagnostics);
    this.name = 'ProvenanceFreeFreshAttemptArtifactError';
  }
}

/** Its recomputed digest does not match, or its stored body cannot be read back. */
export class CorruptFreshAttemptArtifactError extends FreshAttemptArtifactError {
  constructor(diagnostics: readonly FreshAttemptRejectionDiagnostic[]) {
    super('corrupt', 'load', diagnostics);
    this.name = 'CorruptFreshAttemptArtifactError';
  }
}
