import { describe, expect, it } from 'bun:test';

import * as operative from '../index';

describe('@lostgradient/operative fresh-attempt surface (COR-1354)', () => {
  it('exports the threshold constants', () => {
    expect(operative.FRESH_ATTEMPT_ARTIFACT_MAX_BYTES).toBe(10 * 1024);
    expect(operative.FRESH_ATTEMPT_ARTIFACT_RETENTION_MS).toBe(7 * 24 * 60 * 60 * 1000);
    expect(operative.FRESH_ATTEMPT_ARTIFACT_ENTROPY_THRESHOLD).toBe(4.5);
    expect(operative.FRESH_ATTEMPT_ARTIFACT_CLOCK_SKEW_MS).toBe(60 * 1000);
  });

  it('exports StaleFreshAttemptArtifactError and the rest of the rejection taxonomy', () => {
    expect(
      [
        operative.InvalidFreshAttemptArtifactError,
        operative.StaleFreshAttemptArtifactError,
        operative.IncompatibleFreshAttemptArtifactError,
        operative.OversizedFreshAttemptArtifactError,
        operative.SecretBearingFreshAttemptArtifactError,
        operative.UnauthorizedFreshAttemptArtifactError,
        operative.OverbroadFreshAttemptArtifactError,
        operative.ProvenanceFreeFreshAttemptArtifactError,
        operative.CorruptFreshAttemptArtifactError,
      ].every((errorClass) => errorClass.prototype instanceof operative.FreshAttemptArtifactError),
    ).toBe(true);
  });

  it('exports the artifact, store, validation, and policy entry points', () => {
    expect(typeof operative.finalizeFreshAttemptHandoffArtifact).toBe('function');
    expect(typeof operative.freshAttemptHandoffArtifactSchema.safeParse).toBe('function');
    expect(typeof operative.validateFreshAttemptArtifact).toBe('function');
    expect(typeof operative.validateFreshAttemptArtifactForPublication).toBe('function');
    expect(typeof operative.createFreshAttemptArtifactStore).toBe('function');
    expect(typeof operative.applyConversationPolicy).toBe('function');
  });

  it('exports the ConversationPolicy and FreshAttemptHandoffArtifact types', () => {
    const policies: operative.ConversationPolicy[] = [
      { kind: 'continue' },
      { kind: 'fork-from-baseline', throughRun: 2 },
    ];
    const artifactOf = (
      policy: operative.ConversationPolicy,
    ): operative.FreshAttemptHandoffArtifact | undefined =>
      policy.kind === 'fresh-from-artifact' ? policy.artifact : undefined;

    expect(policies.map(artifactOf)).toEqual([undefined, undefined]);
  });
});
