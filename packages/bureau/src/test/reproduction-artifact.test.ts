import { tmpdir } from 'node:os';

import type { GenerateFunction } from '@lostgradient/operative';
import { createAgent } from '@lostgradient/operative';
import { createEventRecorder, type EventRecorder } from '@lostgradient/operative/test';
import { createToolbox } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';
import { createManualRuntimeServices } from 'lifecycle';

import type { BureauTestHarness } from './harness';
import { createBureauTestHarness } from './harness';
import {
  assembleReproductionArtifact,
  locateWorkspaceRoot,
  type ReproductionArtifact,
} from './reproduction-artifact';
import { createMemoryStorageFixture } from './storage-fixtures';

function mockGenerate(content = 'Done.'): GenerateFunction {
  return async () => ({ content, toolCalls: [] });
}

const disposals: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (disposals.length > 0) {
    const dispose = disposals.pop()!;
    await dispose();
  }
});

/**
 * Builds a harness, runs its `worker` agent to completion with an
 * `EventRecorder` attached to the run's own event stream, and assembles a
 * `ReproductionArtifact` from it. `overrides` lets a caller pin (or omit)
 * `runtime`/`provider` to exercise the seed and effective-model fields.
 *
 * The catalog agent is constructed with the SAME `runtime` the harness
 * itself is given — `createAgent` resolves `options.runtime ??
 * createDefaultRuntimeServices()` at construction time (a real clock,
 * independent of whatever `Bureau` is later composed over), and Bureau does
 * not retroactively rewire a pre-constructed agent's own runtime. Without
 * this, `run.result()`'s `GenerateResponseEvent.durationMilliseconds` is a
 * REAL `performance.now()` delta rather than the harness's manual monotonic
 * clock. Even with this fix, a real run through `Conversation` is still not
 * byte-identical across two processes — `conversationalist`'s own
 * `randomId`/`now` environment seam (`crypto.randomUUID()` by default) is
 * not wired to AB-92's `RuntimeServices` and `createAgent` has no option to
 * override it, so `run.result()`'s conversation id still differs run to
 * run. That gap is upstream of this package (tracked as a follow-up in this
 * pull request, not fixed here); `assembleDeterministicCase` below is the
 * byte-identical test that stays entirely within what this assembler
 * controls.
 */
async function runScriptedCase(
  overrides: Partial<Parameters<typeof createBureauTestHarness>[0]> = {},
): Promise<{
  harness: BureauTestHarness;
  recorder: EventRecorder;
  artifact: ReproductionArtifact;
}> {
  const runtime = overrides.runtime ?? createManualRuntimeServices();
  const storage = createMemoryStorageFixture();
  const harness = await createBureauTestHarness({
    agents: {
      worker: createAgent({ name: 'worker', generate: mockGenerate('worker done'), runtime }),
    },
    generate: mockGenerate(),
    toolbox: createToolbox([]),
    provider: { provider: 'anthropic', model: 'claude-test' },
    storage,
    ...overrides,
    runtime,
  });
  disposals.push(async () => {
    await harness.bureau.dispose();
    await storage.dispose();
  });

  const recorder = createEventRecorder(harness.runtime);
  const run = harness.startRun('worker', 'hello');
  recorder.attachIterable(run, { kind: 'run', id: 'worker-run' });

  const terminalResult = await run.result();
  const cleanupReport = await run.closed();
  // `attachIterable`'s consumption loop is tracked on `runtime.deferred`
  // (see `event-recorder.ts`) — drain it so every event the run emitted has
  // actually been captured before assembling, rather than racing the
  // recorder's own background iteration.
  await harness.runtime.deferred.drain();

  const artifact = await assembleReproductionArtifact(harness, recorder, {
    terminalResult,
    cleanupReport,
  });

  return { harness, recorder, artifact };
}

/**
 * Assembles an artifact from a freshly constructed harness with a fixed,
 * caller-supplied `terminalResult`/`cleanupReport` and an `EventRecorder`
 * that captures no real events — deliberately not driven through a real
 * `AgentRun`. A real run's own `RunResult` embeds a genuinely
 * non-deterministic conversation id (`conversationalist`'s `randomId`
 * environment seam — see `runScriptedCase`'s own doc comment above) that
 * this assembler does not own and cannot normalize away; the
 * byte-identical-serialization guarantee AB-263 owns is the ASSEMBLER's
 * own construction being deterministic given deterministic inputs, which
 * this exercises directly.
 */
async function assembleDeterministicCase(
  overrides: Partial<Parameters<typeof createBureauTestHarness>[0]> = {},
): Promise<ReproductionArtifact> {
  const storage = createMemoryStorageFixture();
  const harness = await createBureauTestHarness({
    agents: {},
    generate: mockGenerate(),
    toolbox: createToolbox([]),
    provider: { provider: 'anthropic', model: 'claude-test' },
    storage,
    ...overrides,
  });
  disposals.push(async () => {
    await harness.bureau.dispose();
    await storage.dispose();
  });

  const recorder = createEventRecorder(harness.runtime);
  return assembleReproductionArtifact(harness, recorder, {
    terminalResult: { output: 'ok', usage: { totalTokens: 12 } },
    cleanupReport: { status: 'completed' },
  });
}

describe('assembleReproductionArtifact', () => {
  it('produces byte-identical JSON.stringify output across two independently constructed harnesses given the same deterministic inputs', async () => {
    const first = await assembleDeterministicCase();
    const second = await assembleDeterministicCase();

    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('redacts a privileged value out of terminalResult so it never appears in JSON.stringify(artifact)', async () => {
    const storage = createMemoryStorageFixture();
    const harness = await createBureauTestHarness({
      agents: {},
      generate: mockGenerate(),
      toolbox: createToolbox([]),
      provider: { provider: 'anthropic', model: 'claude-test' },
      storage,
    });
    disposals.push(async () => {
      await harness.bureau.dispose();
      await storage.dispose();
    });

    const recorder = createEventRecorder(harness.runtime);
    const artifact = await assembleReproductionArtifact(harness, recorder, {
      terminalResult: { output: 'ok', apiKey: 'super-secret-value-should-not-leak' },
      cleanupReport: { status: 'completed' },
    });

    const serialized = JSON.stringify(artifact);
    expect(serialized).not.toContain('super-secret-value-should-not-leak');
    expect(serialized).toContain('[redacted]');
  });

  it('reads sourceRevision from git rev-parse HEAD', async () => {
    const rawOutput = await Bun.$`git rev-parse HEAD`.quiet().text();
    const expected = rawOutput.trim();
    const { artifact } = await runScriptedCase();

    expect(artifact.sourceRevision).toBe(expected);
  });

  it('reads packageVersions from every workspace package.json, keyed by name', async () => {
    const bureauManifest = (await Bun.file(
      `${await locateWorkspaceRoot()}/packages/bureau/package.json`,
    ).json()) as { name: string; version: string };
    const { artifact } = await runScriptedCase();

    expect(artifact.packageVersions[bureauManifest.name]).toBe(bureauManifest.version);
    expect(Object.keys(artifact.packageVersions).length).toBeGreaterThan(5);
  });

  it('reads clockOrigin, identifierSeed, and randomSeed from an explicitly pinned harness runtime', async () => {
    const runtime = createManualRuntimeServices({
      origin: '2031-06-01T00:00:00.000Z',
      identifierSeed: 'pinned-identifier-seed',
      randomSeed: 'pinned-random-seed',
    });
    const { artifact } = await runScriptedCase({ runtime });

    expect(artifact.clockOrigin).toBe('2031-06-01T00:00:00.000Z');
    expect(artifact.identifierSeed).toBe('pinned-identifier-seed');
    expect(artifact.randomSeed).toBe('pinned-random-seed');
  });

  it('records the generated (default) seeds rather than omitting them when the harness runtime is unpinned', async () => {
    const { artifact } = await runScriptedCase();

    expect(artifact.clockOrigin).toBe('2020-01-01T00:00:00.000Z');
    expect(artifact.identifierSeed).toBe('manual-runtime-services');
    expect(artifact.randomSeed).toBe('manual-runtime-services');
  });

  it("reads effectiveModel from the harness bureau's configured provider", async () => {
    const { artifact } = await runScriptedCase();

    expect(artifact.effectiveModel).toEqual({ provider: 'anthropic', model: 'claude-test' });
  });

  it('throws rather than inventing a provider/model when the harness has no configured provider', async () => {
    const storage = createMemoryStorageFixture();
    const harness = await createBureauTestHarness({
      agents: {},
      generate: mockGenerate(),
      toolbox: createToolbox([]),
      storage,
    });
    disposals.push(async () => {
      await harness.bureau.dispose();
      await storage.dispose();
    });
    const recorder = createEventRecorder(harness.runtime);

    expect(
      assembleReproductionArtifact(harness, recorder, {
        terminalResult: undefined,
        cleanupReport: undefined,
      }),
    ).rejects.toThrow(/no configured `provider`/);
  });

  it('sets causalTrace to exactly EventRecorder.normalize() output and nothing else', async () => {
    const { recorder, artifact } = await runScriptedCase();

    expect(artifact.causalTrace).toEqual(recorder.normalize());
    expect(artifact.causalTrace.length).toBeGreaterThan(0);
  });

  it('assembles empty scriptedOutcomes and firedFaults — no fault engine exists yet', async () => {
    const { artifact } = await runScriptedCase();

    expect(artifact.scriptedOutcomes).toEqual([]);
    expect(artifact.firedFaults).toEqual([]);
  });

  it('forwards cleanupReport verbatim', async () => {
    const { artifact } = await runScriptedCase();

    expect(artifact.cleanupReport).toMatchObject({ status: expect.any(String) });
  });

  it('bypasses sourceRevision/packageVersions discovery when an explicit environment is supplied (AB-264)', async () => {
    const storage = createMemoryStorageFixture();
    const harness = await createBureauTestHarness({
      agents: {},
      generate: mockGenerate(),
      toolbox: createToolbox([]),
      provider: { provider: 'anthropic', model: 'claude-test' },
      storage,
    });
    disposals.push(async () => {
      await harness.bureau.dispose();
      await storage.dispose();
    });

    const recorder = createEventRecorder(harness.runtime);
    const artifact = await assembleReproductionArtifact(
      harness,
      recorder,
      { terminalResult: undefined, cleanupReport: { status: 'completed' } },
      {
        sourceRevision: 'explicit-revision-not-a-sha',
        packageVersions: { 'explicit-package-one': '1.2.3', 'explicit-package-two': '4.5.6' },
      },
    );

    // Neither value could have come from `git rev-parse HEAD` (a real sha)
    // or the `packages/*/package.json` glob (which would include `bureau`
    // itself, among many others) — this is only reachable through the
    // explicit environment argument bypassing discovery.
    expect(artifact.sourceRevision).toBe('explicit-revision-not-a-sha');
    expect(artifact.packageVersions).toEqual({
      'explicit-package-one': '1.2.3',
      'explicit-package-two': '4.5.6',
    });
  });
});

describe('locateWorkspaceRoot', () => {
  it('finds the workspace root by walking up to turbo.json', async () => {
    const root = await locateWorkspaceRoot();

    expect(await Bun.file(`${root}/turbo.json`).exists()).toBe(true);
  });

  it('throws when no turbo.json exists anywhere above the starting directory', () => {
    expect(locateWorkspaceRoot(tmpdir())).rejects.toThrow(/could not locate the workspace root/);
  });
});
