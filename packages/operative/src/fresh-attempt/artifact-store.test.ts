import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import { MemoryStorage, textValueStore } from '@lostgradient/weft';
import { describe, expect, it, spyOn } from 'bun:test';

import { createFreshAttemptArtifactStore } from './artifact-store';
import {
  CorruptFreshAttemptArtifactError,
  FreshAttemptArtifactError,
  InvalidFreshAttemptArtifactError,
  OversizedFreshAttemptArtifactError,
  SecretBearingFreshAttemptArtifactError,
  StaleFreshAttemptArtifactError,
} from './errors';
import {
  FIXTURE_ACTOR,
  FIXTURE_NOW,
  createFixtureArtifact,
  createFixtureSource,
  resolverFor,
} from './fixtures/artifact-fixture';
import type { FreshAttemptHandoffArtifact } from './handoff-artifact';
import {
  FRESH_ATTEMPT_ARTIFACT_MAX_BYTES,
  FRESH_ATTEMPT_ARTIFACT_RETENTION_MS,
} from './thresholds';
import { validateFreshAttemptArtifact } from './validate';

const ARTIFACT_ID = 'handoff-fixture';

function createStoreFixture() {
  const backing = textValueStore(new MemoryStorage());
  const runtime = createManualRuntimeServices({ origin: new Date(FIXTURE_NOW).toISOString() });
  const resolveSource = resolverFor(createFixtureSource());
  const store = createFreshAttemptArtifactStore(backing, { resolveSource, clock: runtime.clock });
  const writes = {
    set: spyOn(backing, 'set'),
    conditionalBatch: spyOn(backing, 'conditionalBatch'),
  };
  return { backing, store, writes, resolveSource, runtime };
}

async function rejectionOf(pending: Promise<unknown>): Promise<FreshAttemptArtifactError> {
  const outcome = await pending.then(
    () => undefined,
    (error: unknown) => error,
  );
  if (!(outcome instanceof FreshAttemptArtifactError)) {
    throw new TypeError(`Expected a FreshAttemptArtifactError, got ${String(outcome)}`);
  }
  return outcome;
}

describe('createFreshAttemptArtifactStore', () => {
  it('returns undefined for an artifact that was never published', async () => {
    const { store } = createStoreFixture();

    expect(await store.load(ARTIFACT_ID)).toBeUndefined();
    expect(await store.history(ARTIFACT_ID)).toEqual([]);
  });

  it('publishes revision 1 when nothing is stored yet', async () => {
    const { store } = createStoreFixture();
    const artifact = await createFixtureArtifact();
    let seen: FreshAttemptHandoffArtifact | undefined = artifact;

    const published = await store.update(ARTIFACT_ID, (latest) => {
      seen = latest;
      return artifact;
    });

    expect(seen).toBeUndefined();
    expect(published).toEqual(artifact);
    expect(await store.load(ARTIFACT_ID)).toEqual(artifact);
  });

  it('hands the updater the latest revision and keeps every revision in history', async () => {
    const { store } = createStoreFixture();
    const first = await createFixtureArtifact();
    const second = await createFixtureArtifact({ revision: 2, nextRequestedAction: 'Ship it.' });
    await store.update(ARTIFACT_ID, () => first);

    let seen: FreshAttemptHandoffArtifact | undefined;
    await store.update(ARTIFACT_ID, (latest) => {
      seen = latest;
      return second;
    });

    expect(seen).toEqual(first);
    expect(await store.load(ARTIFACT_ID)).toEqual(second);
    expect(await store.history(ARTIFACT_ID)).toEqual([first, second]);
  });

  it('leaves the store unchanged when the updater returns undefined', async () => {
    const { store, writes } = createStoreFixture();
    const first = await createFixtureArtifact();
    await store.update(ARTIFACT_ID, () => first);
    const writesBefore = writes.conditionalBatch.mock.calls.length;

    const result = await store.update(ARTIFACT_ID, () => undefined);

    expect(result).toEqual(first);
    expect(writes.conditionalBatch.mock.calls.length).toBe(writesBefore);
  });

  it('rejects a first publication that does not start at revision 1', async () => {
    const { store } = createStoreFixture();
    const artifact = await createFixtureArtifact({ revision: 2 });

    const error = await rejectionOf(store.update(ARTIFACT_ID, () => artifact));

    expect(error).toBeInstanceOf(StaleFreshAttemptArtifactError);
    expect(error.diagnostics).toEqual([{ path: 'revision', rule: 'revision-conflict' }]);
    expect(await store.load(ARTIFACT_ID)).toBeUndefined();
  });

  it('rejects a republish that reuses the current revision', async () => {
    const { store } = createStoreFixture();
    const first = await createFixtureArtifact();
    await store.update(ARTIFACT_ID, () => first);
    const replay = await createFixtureArtifact({ nextRequestedAction: 'Overwrite silently.' });

    const error = await rejectionOf(store.update(ARTIFACT_ID, () => replay));

    expect(error).toBeInstanceOf(StaleFreshAttemptArtifactError);
    expect(await store.load(ARTIFACT_ID)).toEqual(first);
  });

  it('lets exactly one of two concurrent publishes at the same revision win', async () => {
    const { store } = createStoreFixture();
    const left = await createFixtureArtifact({ nextRequestedAction: 'Left wins.' });
    const right = await createFixtureArtifact({ nextRequestedAction: 'Right wins.' });

    const outcomes = await Promise.allSettled([
      store.update(ARTIFACT_ID, () => left),
      store.update(ARTIFACT_ID, () => right),
    ]);

    const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    const rejected = outcomes.flatMap((outcome) =>
      outcome.status === 'rejected' ? [outcome.reason as unknown] : [],
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toBeInstanceOf(StaleFreshAttemptArtifactError);
    expect(await store.history(ARTIFACT_ID)).toHaveLength(1);
  });

  it('rejects a candidate whose artifactId is not the one being updated', async () => {
    const { store, writes } = createStoreFixture();
    const artifact = await createFixtureArtifact({ artifactId: 'some-other-handoff' });

    const error = await rejectionOf(store.update(ARTIFACT_ID, () => artifact));

    expect(error).toBeInstanceOf(InvalidFreshAttemptArtifactError);
    expect(error.diagnostics).toEqual([{ path: 'artifactId', rule: 'artifact-id-mismatch' }]);
    expect(writes.conditionalBatch).not.toHaveBeenCalled();
  });

  it('never writes an oversized artifact to the backing store', async () => {
    const { store, writes } = createStoreFixture();
    const entries = Math.ceil(FRESH_ATTEMPT_ARTIFACT_MAX_BYTES / 20) + 1;
    const artifact = await createFixtureArtifact({
      completedWork: Array.from({ length: entries }, (_, index) => `Finished step ${index}.`),
    });

    const error = await rejectionOf(store.update(ARTIFACT_ID, () => artifact));

    expect(error).toBeInstanceOf(OversizedFreshAttemptArtifactError);
    expect(writes.set.mock.calls.length).toBe(0);
    expect(writes.conditionalBatch.mock.calls.length).toBe(0);
  });

  it('never writes a secret-bearing artifact to the backing store', async () => {
    const { store, writes } = createStoreFixture();
    const artifact = await createFixtureArtifact({
      objective: 'Rerun the deploy with api_key=not-a-real-value-0000',
    });

    const error = await rejectionOf(store.update(ARTIFACT_ID, () => artifact));

    expect(error).toBeInstanceOf(SecretBearingFreshAttemptArtifactError);
    expect(writes.set.mock.calls.length).toBe(0);
    expect(writes.conditionalBatch.mock.calls.length).toBe(0);
  });

  it('never writes an artifact dated after the store clock', async () => {
    const { store, writes } = createStoreFixture();
    const artifact = await createFixtureArtifact({ timestamp: '9999-01-01T00:00:00.000Z' });

    const error = await rejectionOf(store.update(ARTIFACT_ID, () => artifact));

    expect(error).toBeInstanceOf(StaleFreshAttemptArtifactError);
    expect(error.diagnostics).toEqual([{ path: 'timestamp', rule: 'timestamp-in-future' }]);
    expect(writes.set.mock.calls.length).toBe(0);
    expect(writes.conditionalBatch.mock.calls.length).toBe(0);
  });

  it('reads the store clock afresh on every publish', async () => {
    const { store, runtime } = createStoreFixture();
    const anHourLater = new Date(FIXTURE_NOW + 60 * 60 * 1000).toISOString();
    const artifact = await createFixtureArtifact({
      timestamp: anHourLater,
      provenance: { producedAt: anHourLater, producingActor: FIXTURE_ACTOR },
    });

    const early = await rejectionOf(store.update(ARTIFACT_ID, () => artifact));
    runtime.setTime(Date.parse(anHourLater));
    const published = await store.update(ARTIFACT_ID, () => artifact);

    expect(early).toBeInstanceOf(StaleFreshAttemptArtifactError);
    expect(published).toEqual(artifact);
  });

  it('keeps an artifact past retention readable while it fails validation as stale', async () => {
    const { store, resolveSource } = createStoreFixture();
    const artifact = await createFixtureArtifact();
    await store.update(ARTIFACT_ID, () => artifact);
    const later = FIXTURE_NOW + FRESH_ATTEMPT_ARTIFACT_RETENTION_MS;

    const stored = await store.load(ARTIFACT_ID);

    expect(stored).toEqual(artifact);
    expect(await store.history(ARTIFACT_ID)).toEqual([artifact]);
    const error = await rejectionOf(
      validateFreshAttemptArtifact(stored, { resolveSource, now: later }),
    );
    expect(error).toBeInstanceOf(StaleFreshAttemptArtifactError);
    expect(error.diagnostics).toEqual([{ path: 'timestamp', rule: 'retention-window' }]);
  });

  it('keeps artifact ids that share a prefix apart', async () => {
    const { store } = createStoreFixture();
    const short = await createFixtureArtifact({ artifactId: 'handoff' });
    const long = await createFixtureArtifact({ artifactId: 'handoff:2' });
    await store.update('handoff', () => short);
    await store.update('handoff:2', () => long);

    expect(await store.history('handoff')).toEqual([short]);
    expect(await store.history('handoff:2')).toEqual([long]);
  });

  it('reports an unreadable stored body as corrupt', async () => {
    const { backing, store } = createStoreFixture();
    await store.update(ARTIFACT_ID, async () => createFixtureArtifact());
    const keys = await backing.list('');
    for (const key of keys) await backing.set(key, '{"not":"an artifact"');

    const loadError = await rejectionOf(store.load(ARTIFACT_ID));
    const historyError = await rejectionOf(store.history(ARTIFACT_ID));

    expect(loadError).toBeInstanceOf(CorruptFreshAttemptArtifactError);
    expect(loadError.kind).toBe('load');
    expect(loadError.diagnostics).toEqual([{ path: '', rule: 'unreadable-stored-artifact' }]);
    expect(historyError).toBeInstanceOf(CorruptFreshAttemptArtifactError);
  });

  it('reports a stored body that parses but fails the schema as corrupt', async () => {
    const { backing, store } = createStoreFixture();
    await store.update(ARTIFACT_ID, async () => createFixtureArtifact());
    for (const key of await backing.list('')) await backing.set(key, '{"artifactId":1}');

    expect(await rejectionOf(store.load(ARTIFACT_ID))).toBeInstanceOf(
      CorruptFreshAttemptArtifactError,
    );
  });
});
