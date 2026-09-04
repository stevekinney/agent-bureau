/**
 * AB-282 PROOF BRANCH — NOT part of the shipped acceptance criteria. This
 * file exists only to demonstrate, in a real CI run, that a failing
 * lifecycle fixture (a) prints its full ownership tree and pending
 * resources and (b) has its generated reproduction artifact picked up by
 * the `lifecycle-contract` job's upload step. The pull request this proves
 * links the resulting CI run and workflow-artifact download here, then
 * this file is deleted — it never merges.
 */
import { join } from 'node:path';

import { createAgent } from '@lostgradient/operative';
import { type ReproductionArtifact, writeReproductionArtifact } from '@lostgradient/operative/test';
import { describe, it } from 'bun:test';
import { createBureauTestHarness, createMemoryStorageFixture } from 'bureau/test';

describe('AB-282 proof branch: deliberate lifecycle-contract failure', () => {
  it('[ab282-proof] deliberately leaks a child run so close() renders the ownership tree, and writes a reproduction artifact', async () => {
    const storage = createMemoryStorageFixture();
    const harness = await createBureauTestHarness({
      agents: {
        worker: createAgent({
          name: 'worker',
          generate: async () => ({ content: 'ok', toolCalls: [] }),
        }),
        stuck: createAgent({ name: 'stuck', generate: () => new Promise<never>(() => {}) }),
      },
      generate: async () => ({ content: 'ok', toolCalls: [] }),
      storage,
    });

    const parent = harness.startRun('worker', 'parent');
    harness.startChild(parent.snapshot().id, 'stuck', 'child input');

    const artifactDirectory = Bun.env['REPRODUCTION_ARTIFACT_DIR'] ?? '.';
    const artifact: ReproductionArtifact = {
      sourceRevision: 'ab-282-proof-branch',
      packageVersions: {},
      effectiveModel: { provider: 'ab282-proof', model: 'ab282-proof' },
      clockOrigin: new Date(0).toISOString(),
      identifierSeed: 'ab282-proof-seed',
      randomSeed: 'ab282-proof-seed',
      scriptedOutcomes: [],
      firedFaults: [],
      causalTrace: [],
      terminalResult: null,
      cleanupReport: null,
    };
    await writeReproductionArtifact(artifact, join(artifactDirectory, 'ab-282-proof.json'));

    try {
      // Deliberately not caught: close() rejects with BureauQuiescenceError,
      // whose message IS the rendered QuiescenceReport ownership tree.
      // (close() disposes `storage` itself on every path, success or not.)
      await harness.close();
    } finally {
      await harness.bureau.dispose();
    }
  });
});
