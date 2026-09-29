import { sha256Hex } from '@lostgradient/cryptography';
import { describe, expect, it } from 'bun:test';

import { createFixtureArtifact, createFixtureDraft } from './fixtures/artifact-fixture';
import {
  FRESH_ATTEMPT_ARTIFACT_SCHEMA_VERSION,
  canonicalizeFreshAttemptValue,
  computeFreshAttemptArtifactDigest,
  finalizeFreshAttemptHandoffArtifact,
  freshAttemptHandoffArtifactSchema,
} from './handoff-artifact';

describe('FreshAttemptHandoffArtifact schema', () => {
  it('starts its own schema-version counter at 1', () => {
    expect(FRESH_ATTEMPT_ARTIFACT_SCHEMA_VERSION).toBe(1);
  });

  it('accepts a finalized artifact', async () => {
    const artifact = await createFixtureArtifact();
    expect(freshAttemptHandoffArtifactSchema.safeParse(artifact).success).toBe(true);
  });

  it('rejects a key the schema does not declare', async () => {
    const artifact = { ...(await createFixtureArtifact()), transcript: 'anything' };
    expect(freshAttemptHandoffArtifactSchema.safeParse(artifact).success).toBe(false);
  });

  it('has no field that can hold a Message object', async () => {
    const message = { id: 'm1', role: 'assistant', content: 'done', position: 0 };
    const artifact = await createFixtureArtifact();
    for (const candidate of [
      { ...artifact, completedWork: [message] },
      { ...artifact, objective: message },
      { ...artifact, knownFailures: [{ ...artifact.knownFailures[0], summary: message }] },
      { ...artifact, evidenceReferences: [{ kind: 'message', id: 'm1', content: message }] },
    ]) {
      expect(freshAttemptHandoffArtifactSchema.safeParse(candidate).success).toBe(false);
    }
  });

  it('only accepts the sha-256 digest algorithm', async () => {
    const artifact = await createFixtureArtifact();
    const fnv = { ...artifact, digest: { algorithm: 'fnv1a-64', value: artifact.digest.value } };
    expect(freshAttemptHandoffArtifactSchema.safeParse(fnv).success).toBe(false);
  });

  it('only accepts AgentRunErrorKind values for a known failure', async () => {
    const artifact = await createFixtureArtifact();
    const failure = { ...artifact.knownFailures[0], kind: 'timeout' };
    const candidate = { ...artifact, knownFailures: [failure] };
    expect(freshAttemptHandoffArtifactSchema.safeParse(candidate).success).toBe(false);
  });
});

describe('canonical serialization and digest', () => {
  it('serializes object keys in a stable order and drops undefined members', () => {
    expect(canonicalizeFreshAttemptValue({ b: 1, a: [true, null, 'x'], c: undefined })).toBe(
      '{"a":[true,null,"x"],"b":1}',
    );
    expect(canonicalizeFreshAttemptValue({ a: [true, null, 'x'], b: 1 })).toBe(
      canonicalizeFreshAttemptValue({ b: 1, a: [true, null, 'x'] }),
    );
  });

  it('computes a sha-256 digest over the canonical serialization without the digest field', async () => {
    const draft = createFixtureDraft();
    const body = { ...draft, schemaVersion: FRESH_ATTEMPT_ARTIFACT_SCHEMA_VERSION };
    const expected = await sha256Hex(canonicalizeFreshAttemptValue(body));

    const artifact = await finalizeFreshAttemptHandoffArtifact(draft);

    expect(artifact.schemaVersion).toBe(1);
    expect(artifact.digest).toEqual({ algorithm: 'sha-256', value: expected });
    expect(await computeFreshAttemptArtifactDigest(artifact)).toBe(expected);
  });

  it('changes the digest when any field changes', async () => {
    const first = await createFixtureArtifact();
    const second = await createFixtureArtifact({ nextRequestedAction: 'Something else.' });
    expect(second.digest.value).not.toBe(first.digest.value);
  });
});
