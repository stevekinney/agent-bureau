import { afterEach, describe, expect, it } from 'bun:test';

import {
  assembleBaselineArtifact,
  InvalidReproductionArtifactError,
  readReproductionArtifact,
  replayReproductionArtifact,
  ReproductionArtifactMismatchError,
  writeReproductionArtifact,
} from './artifact-io';

const scratchPaths: string[] = [];

function scratchPath(name: string): string {
  const path = `${import.meta.dir}/.artifact-io-scratch-${name}-${Bun.randomUUIDv7()}.json`;
  scratchPaths.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(
    scratchPaths.splice(0).map(async (path) => {
      if (await Bun.file(path).exists()) {
        await Bun.file(path).delete?.();
      }
    }),
  );
});

describe('writeReproductionArtifact / readReproductionArtifact — byte stability', () => {
  it('writes the same artifact twice to byte-identical files', async () => {
    const artifact = await assembleBaselineArtifact({ randomSeed: 'byte-stability' });

    const pathA = scratchPath('a');
    const pathB = scratchPath('b');
    await writeReproductionArtifact(artifact, pathA);
    await writeReproductionArtifact(artifact, pathB);

    const [bytesA, bytesB] = await Promise.all([Bun.file(pathA).text(), Bun.file(pathB).text()]);
    expect(bytesA).toBe(bytesB);
  });

  it('produces byte-identical files from two independently assembled artifacts of the same seeded case', async () => {
    const first = await assembleBaselineArtifact({
      identifierSeed: 'independent-assembly',
      randomSeed: 'independent-assembly',
    });
    const second = await assembleBaselineArtifact({
      identifierSeed: 'independent-assembly',
      randomSeed: 'independent-assembly',
    });

    const pathA = scratchPath('independent-a');
    const pathB = scratchPath('independent-b');
    await writeReproductionArtifact(first, pathA);
    await writeReproductionArtifact(second, pathB);

    const [bytesA, bytesB] = await Promise.all([Bun.file(pathA).text(), Bun.file(pathB).text()]);
    expect(bytesA).toBe(bytesB);
  });

  it('round-trips every field through write then read', async () => {
    const artifact = await assembleBaselineArtifact({ randomSeed: 'round-trip' });
    const path = scratchPath('round-trip');
    await writeReproductionArtifact(artifact, path);

    const read = await readReproductionArtifact(path);

    expect(read.sourceRevision).toBe(artifact.sourceRevision);
    expect(read.packageVersions).toEqual(artifact.packageVersions);
    expect(read.effectiveModel).toEqual(artifact.effectiveModel);
    expect(read.clockOrigin).toBe(artifact.clockOrigin);
    expect(read.identifierSeed).toBe(artifact.identifierSeed);
    expect(read.randomSeed).toBe(artifact.randomSeed);
    expect(read.scriptedOutcomes).toEqual(artifact.scriptedOutcomes);
    expect(read.firedFaults).toEqual(artifact.firedFaults);
    expect(read.causalTrace).toEqual(artifact.causalTrace);
    expect(read.terminalResult).toEqual(artifact.terminalResult);
    expect(read.cleanupReport).toEqual(artifact.cleanupReport);
  });

  it('round-trips an effectiveModel.effort when present', async () => {
    const artifact = await assembleBaselineArtifact({ randomSeed: 'with-effort' });
    const withEffort = {
      ...artifact,
      effectiveModel: { ...artifact.effectiveModel, effort: 'high' },
    };
    const path = scratchPath('with-effort');
    await writeReproductionArtifact(withEffort, path);

    const read = await readReproductionArtifact(path);
    expect(read.effectiveModel).toEqual({
      provider: artifact.effectiveModel.provider,
      model: artifact.effectiveModel.model,
      effort: 'high',
    });
  });

  it('sorts packageVersions keys regardless of input insertion order', async () => {
    const artifact = await assembleBaselineArtifact({ randomSeed: 'sorted-keys' });
    const unsorted = {
      ...artifact,
      packageVersions: { zeta: '1.0.0', alpha: '2.0.0' },
    };
    const path = scratchPath('sorted-keys');
    await writeReproductionArtifact(unsorted, path);

    const text = await Bun.file(path).text();
    expect(text.indexOf('"alpha"')).toBeLessThan(text.indexOf('"zeta"'));
  });
});

describe('readReproductionArtifact — validation', () => {
  it('rejects malformed JSON as InvalidReproductionArtifactError, not a raw parse error', async () => {
    const path = scratchPath('malformed-json');
    await Bun.write(path, '{ this is not valid JSON');

    expect(readReproductionArtifact(path)).rejects.toBeInstanceOf(InvalidReproductionArtifactError);
  });

  it('rejects a file whose top-level value is not an object', async () => {
    const path = scratchPath('not-an-object');
    await Bun.write(path, JSON.stringify([1, 2, 3]));

    expect(readReproductionArtifact(path)).rejects.toBeInstanceOf(InvalidReproductionArtifactError);
  });

  it('rejects a file missing a required field', async () => {
    const artifact = await assembleBaselineArtifact({ randomSeed: 'missing-field' });
    const path = scratchPath('missing-field');
    const { sourceRevision: _sourceRevision, ...withoutSourceRevision } = artifact;
    await Bun.write(path, JSON.stringify(withoutSourceRevision));

    expect(readReproductionArtifact(path)).rejects.toBeInstanceOf(InvalidReproductionArtifactError);
  });

  it('rejects a non-object packageVersions', async () => {
    const artifact = await assembleBaselineArtifact({ randomSeed: 'invalid-package-versions' });
    const path = scratchPath('invalid-package-versions');
    await Bun.write(path, JSON.stringify({ ...artifact, packageVersions: 'not-an-object' }));

    expect(readReproductionArtifact(path)).rejects.toBeInstanceOf(InvalidReproductionArtifactError);
  });

  it('rejects a packageVersions entry that is not a string', async () => {
    const artifact = await assembleBaselineArtifact({ randomSeed: 'invalid-package-entry' });
    const path = scratchPath('invalid-package-entry');
    await Bun.write(path, JSON.stringify({ ...artifact, packageVersions: { operative: 123 } }));

    expect(readReproductionArtifact(path)).rejects.toThrow(/packageVersions\.operative/);
  });

  it('rejects a non-object effectiveModel', async () => {
    const artifact = await assembleBaselineArtifact({ randomSeed: 'invalid-effective-model' });
    const path = scratchPath('invalid-effective-model');
    await Bun.write(path, JSON.stringify({ ...artifact, effectiveModel: 'not-an-object' }));

    expect(readReproductionArtifact(path)).rejects.toThrow(/"effectiveModel" must be an object/);
  });

  it('rejects an effectiveModel.effort that is not a string', async () => {
    const artifact = await assembleBaselineArtifact({ randomSeed: 'invalid-effort' });
    const path = scratchPath('invalid-effort');
    await Bun.write(
      path,
      JSON.stringify({
        ...artifact,
        effectiveModel: { ...artifact.effectiveModel, effort: 42 },
      }),
    );

    expect(readReproductionArtifact(path)).rejects.toThrow(/effectiveModel\.effort/);
  });

  it('rejects a non-array causalTrace', async () => {
    const artifact = await assembleBaselineArtifact({ randomSeed: 'invalid-causal-trace' });
    const path = scratchPath('invalid-causal-trace');
    await Bun.write(path, JSON.stringify({ ...artifact, causalTrace: 'not-an-array' }));

    expect(readReproductionArtifact(path)).rejects.toThrow(/"causalTrace" must be an array/);
  });
});

describe('replayReproductionArtifact', () => {
  it('replays a freshly assembled artifact green', async () => {
    const artifact = await assembleBaselineArtifact({ randomSeed: 'replay-green' });
    expect(replayReproductionArtifact(artifact)).resolves.toBeUndefined();
  });

  it('compares causalTrace and firedFaults entries by value, not by key insertion order', async () => {
    const artifact = await assembleBaselineArtifact({ randomSeed: 'key-order-independent' });
    // Rebuild every causalTrace entry and firedFault with the SAME values
    // but keys inserted in reverse order — a plain `JSON.stringify`
    // comparison would treat these as different strings even though they
    // are semantically identical.
    const reorderedTrace = artifact.causalTrace.map(
      (entry) => Object.fromEntries(Object.entries(entry).reverse()) as typeof entry,
    );
    const reorderedFaults = artifact.firedFaults.map(
      (fault) => Object.fromEntries(Object.entries(fault).reverse()) as typeof fault,
    );
    const reordered = {
      ...artifact,
      causalTrace: reorderedTrace,
      firedFaults: reorderedFaults,
    };

    expect(replayReproductionArtifact(reordered)).resolves.toBeUndefined();
  });

  it('replays the same artifact from disk green', async () => {
    const artifact = await assembleBaselineArtifact({ randomSeed: 'replay-from-disk' });
    const path = scratchPath('replay-from-disk');
    await writeReproductionArtifact(artifact, path);

    const read = await readReproductionArtifact(path);
    expect(replayReproductionArtifact(read)).resolves.toBeUndefined();
  });

  it('fails naming the mismatching causalTrace entry when a trace field is corrupted', async () => {
    const artifact = await assembleBaselineArtifact({ randomSeed: 'corrupt-trace' });
    const [firstEntry, ...restEntries] = artifact.causalTrace;
    if (!firstEntry) throw new Error('expected at least one causalTrace entry');
    const corruptedEntry = { ...firstEntry, event: 'corrupted.event' };
    const corrupted = {
      ...artifact,
      causalTrace: [corruptedEntry, ...restEntries],
    };

    expect(replayReproductionArtifact(corrupted)).rejects.toThrow(
      ReproductionArtifactMismatchError,
    );
    expect(replayReproductionArtifact(corrupted)).rejects.toThrow(/causalTrace\[0\]/);
  });

  it('fails when clockOrigin is corrupted, since firedFaults[].firedAt is origin-relative', async () => {
    const artifact = await assembleBaselineArtifact({ randomSeed: 'corrupt-clock-origin' });
    const corrupted = { ...artifact, clockOrigin: '2099-01-01T00:00:00.000Z' };

    expect(replayReproductionArtifact(corrupted)).rejects.toThrow(
      ReproductionArtifactMismatchError,
    );
  });

  it('fails when the recorded firedFaults length does not match the replayed run', async () => {
    const artifact = await assembleBaselineArtifact({ randomSeed: 'corrupt-fired-length' });
    const corrupted = {
      ...artifact,
      firedFaults: [...artifact.firedFaults, ...artifact.firedFaults],
    };

    expect(replayReproductionArtifact(corrupted)).rejects.toThrow(/firedFaults length mismatch/);
  });

  it('fails when the recorded causalTrace length does not match the replayed run', async () => {
    const artifact = await assembleBaselineArtifact({ randomSeed: 'corrupt-trace-length' });
    const corrupted = { ...artifact, causalTrace: artifact.causalTrace.slice(0, -1) };

    expect(replayReproductionArtifact(corrupted)).rejects.toThrow(/causalTrace length mismatch/);
  });
});
