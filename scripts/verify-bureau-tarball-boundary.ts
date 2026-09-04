/**
 * Proves the `bureau` tarball boundary (AB-23 / AB-92): `bureau` is
 * `"private": true` and MUST NEVER be packed for a registry-style consumer
 * install — its manifest depends on `lifecycle`, `memory`, and `skills` at
 * their internal workspace versions, and none of those three names is safe
 * to resolve from the public npm registry: `memory` and `skills` are real,
 * unrelated third-party packages there today, and installing bureau's
 * tarball against the public registry would silently pull in someone else's
 * package under those names (a dependency-confusion outcome), not fail
 * loudly. This script never queries the public registry for any of
 * bureau's private siblings — the proof is entirely local tarballs.
 *
 * The proof, per AB-92's packed-consumer tier ("bureau is private, so its
 * proof is bun pack plus path install, never a registry install"):
 *
 *   1. `bun pm pack` bureau AND every one of its own `workspace:*`
 *      dependencies (armorer, conversationalist, @lostgradient/operative,
 *      interoperability, lifecycle, memory, skills) into real tarballs.
 *   2. Install ALL of them together, by absolute `file:` path, into one
 *      isolated consumer outside the workspace — `@lostgradient/weft` and
 *      `zod` (bureau's only genuinely-published/registry-safe dependencies)
 *      are the only names resolved from the registry.
 *   3. Prove the tarball boundary structurally: `lifecycle`, `memory`, and
 *      `skills` are exactly the packages this monorepo's own
 *      `.changeset/config.json` `ignore` list marks as never-published —
 *      i.e. the packages a path install must supply itself, by construction,
 *      because no released version of them exists.
 *   4. `bunx tsc --noEmit` and `bun test` a small consumer proving the
 *      installed tarball's public surface (`createBureau`) and `./test`
 *      subpath both import and run.
 *
 * AB-264 extends step 4 with an executed harness-driven probe of
 * `bureau/test`'s full kit — `createBureauTestHarness`,
 * `createMemoryStorageFixture`/`createSqliteStorageFixture`/
 * `createLmdbStorageFixture`, `assertBureauQuiescent`, and
 * `assembleReproductionArtifact` (plus their types), all imported from the
 * INSTALLED tarball, never `packages/bureau/src`. The probe drives one run
 * to completion over the memory fixture, assembles a reproduction artifact
 * — through the explicit `environment` argument AB-264's coordinator
 * amendment adds to `assembleReproductionArtifact`, since neither `.git`
 * nor `turbo.json` exists inside this isolated consumer for the assembler's
 * own filesystem discovery to find — and closes the harness quiescent. It
 * is type-checked with its own `tsc --ignoreConfig` invocation (mirroring
 * AB-259's fix for TypeScript 6's `TS5112`), a negative probe proves
 * importing a name `bureau/test` has never exported still fails to
 * compile, and the packed tarball is asserted to actually contain
 * `dist/test/index.js`, `dist/test/index.cjs`, and `dist/test/index.d.ts`.
 *
 * Usage: `bun run scripts/verify-bureau-tarball-boundary.ts`
 */
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { $ } from 'bun';

const root = join(import.meta.dir, '..');

async function run(command: string[], cwd: string): Promise<string> {
  const [executable, ...arguments_] = command;
  const result = await $`${executable} ${arguments_}`.cwd(cwd).nothrow().quiet();
  const output = `${result.stdout}${result.stderr}`;
  if (result.exitCode !== 0) throw new Error(`${command.join(' ')} failed:\n${output}`);
  return output;
}

/**
 * Like {@link run}, but returns ONLY stdout on success — for a command
 * whose stdout is meant to be parsed directly (`tar -tzf`'s entry list).
 * Mirrors `scripts/verify-operative-consumer.ts`'s `runForStdout`.
 */
async function runForStdout(command: string[], cwd: string): Promise<string> {
  const [executable, ...arguments_] = command;
  const result = await $`${executable} ${arguments_}`.cwd(cwd).nothrow().quiet();
  if (result.exitCode !== 0) {
    throw new Error(`${command.join(' ')} failed:\n${result.stdout}${result.stderr}`);
  }
  return result.stdout.toString();
}

/**
 * Runs a command and returns its exit code and combined output without
 * throwing — for a probe expected to FAIL compilation. Mirrors
 * `scripts/verify-operative-consumer.ts`'s `runExpectingFailure`.
 */
async function runExpectingFailure(
  command: string[],
  cwd: string,
): Promise<{ exitCode: number; output: string }> {
  const [executable, ...arguments_] = command;
  const result = await $`${executable} ${arguments_}`.cwd(cwd).nothrow().quiet();
  return { exitCode: result.exitCode, output: `${result.stdout}${result.stderr}` };
}

/**
 * A hard-coded sibling list silently goes stale the moment bureau's own
 * `package.json` gains (or drops) a `workspace:*` dependency — this script
 * would then neither pack nor override the new one, and the lockfile
 * scanner (derived from the same list) would not even look for it,
 * defeating the dependency-confusion check entirely. Derived instead: read
 * bureau's manifest's own `dependencies`, keep only the `workspace:*`
 * entries, then map each dependency NAME back to its `packages/<dir>`
 * directory by reading every sibling package's own `name` field (a
 * directory name and its package name can differ, e.g. `operative` ->
 * `@lostgradient/operative`).
 */
async function resolveBureauWorkspaceSiblings(): Promise<Record<string, string>> {
  const bureauManifest = JSON.parse(
    await Bun.file(join(root, 'packages', 'bureau', 'package.json')).text(),
  ) as { dependencies?: Record<string, string> };
  const workspaceDependencyNames = Object.entries(bureauManifest.dependencies ?? {})
    .filter(([, range]) => range === 'workspace:*')
    .map(([name]) => name);

  const nameToDirectory = new Map<string, string>();
  for (const directoryName of await readdir(join(root, 'packages'))) {
    const manifestPath = join(root, 'packages', directoryName, 'package.json');
    if (!(await Bun.file(manifestPath).exists())) continue;
    const manifest = JSON.parse(await Bun.file(manifestPath).text()) as { name?: string };
    if (manifest.name) nameToDirectory.set(manifest.name, directoryName);
  }

  const directoryByName: Record<string, string> = {};
  for (const name of workspaceDependencyNames) {
    const directoryName = nameToDirectory.get(name);
    if (!directoryName) {
      throw new Error(
        `bureau depends on "${name}" (workspace:*), but no packages/* directory declares that name`,
      );
    }
    directoryByName[name] = directoryName;
  }
  return directoryByName;
}

/**
 * Bureau's own `workspace:*` dependencies (private, unpublished) plus
 * bureau itself — every one of these must be packed and installed by local
 * path, never resolved from the registry. Mirrors `packages/bureau/package.json`'s
 * `dependencies` — see {@link resolveBureauWorkspaceSiblings} above, which
 * derives this set instead of hard-coding it.
 */

async function packWorkspacePackage(directoryName: string, staging: string): Promise<string> {
  const packageDirectory = join(root, 'packages', directoryName);
  const output = await run(['bun', 'pm', 'pack', '--destination', staging], packageDirectory);
  const tarballLine = output
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.endsWith('.tgz') && !line.startsWith('packed '));
  if (!tarballLine) {
    throw new Error(`bun pm pack for ${directoryName} did not report a tarball path:\n${output}`);
  }
  return tarballLine;
}

async function verifyStructuralBoundary(): Promise<void> {
  const changesetConfiguration = JSON.parse(
    await Bun.file(join(root, '.changeset', 'config.json')).text(),
  ) as { ignore?: string[] };
  const ignored = new Set(changesetConfiguration.ignore ?? []);
  const neverPublished = ['lifecycle', 'memory', 'skills'] as const;
  for (const name of neverPublished) {
    if (!ignored.has(name)) {
      throw new Error(
        `Expected .changeset/config.json's ignore list to mark "${name}" as never-published ` +
          `(bureau's tarball boundary depends on this); it does not.`,
      );
    }
  }

  const bureauManifest = JSON.parse(
    await Bun.file(join(root, 'packages', 'bureau', 'package.json')).text(),
  ) as { private?: boolean; dependencies?: Record<string, string> };
  if (bureauManifest.private !== true) {
    throw new Error('bureau must remain "private": true — its manifest boundary depends on it.');
  }
  for (const name of neverPublished) {
    if (!bureauManifest.dependencies?.[name]) {
      throw new Error(`Expected bureau's package.json to depend on "${name}"; it does not.`);
    }
  }
}

// ---------------------------------------------------------------------------
// AB-264: the executed harness-driven probe of `bureau/test`'s full kit.
// ---------------------------------------------------------------------------

/**
 * Reads the same `sourceRevision`/`packageVersions` pair
 * `assembleReproductionArtifact`'s own filesystem discovery would compute
 * (`git rev-parse HEAD`; every workspace package's `package.json` `name`/`version`,
 * sorted by name) — computed here, from the real checkout, so the probe can
 * pass them through AB-264's explicit `environment` argument instead of
 * relying on discovery that cannot succeed inside the isolated consumer (no
 * `.git`, no `turbo.json`).
 */
async function readProbeEnvironment(): Promise<{
  sourceRevision: string;
  packageVersions: Record<string, string>;
}> {
  const sourceRevision = (await run(['git', 'rev-parse', 'HEAD'], root)).trim();
  const entries: [string, string][] = [];
  for (const directoryName of await readdir(join(root, 'packages'))) {
    const manifestPath = join(root, 'packages', directoryName, 'package.json');
    if (!(await Bun.file(manifestPath).exists())) continue;
    const manifest = JSON.parse(await Bun.file(manifestPath).text()) as {
      name?: unknown;
      version?: unknown;
    };
    if (typeof manifest.name === 'string' && typeof manifest.version === 'string') {
      entries.push([manifest.name, manifest.version]);
    }
  }
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return { sourceRevision, packageVersions: Object.fromEntries(entries) };
}

/** Generates `src/probe-environment.ts` for the consumer — a plain data module the harness probe imports, never computed inside the consumer itself. */
function renderProbeEnvironmentModule(environment: {
  sourceRevision: string;
  packageVersions: Record<string, string>;
}): string {
  return `// Generated by scripts/verify-bureau-tarball-boundary.ts (AB-264) from the real
// checkout this consumer was packed from. Fed into assembleReproductionArtifact's
// explicit \`environment\` argument — neither \`.git\` nor \`turbo.json\` exists
// inside this isolated consumer for the assembler's own filesystem discovery.
export const sourceRevision: string = ${JSON.stringify(environment.sourceRevision)};
export const packageVersions: Readonly<Record<string, string>> = Object.freeze(
  ${JSON.stringify(environment.packageVersions, null, 2)},
);
`;
}

/**
 * The executed harness probe: every value/type export the issue's
 * acceptance criteria names is imported from `bureau/test`, and the
 * executed scenario (`createBureauTestHarness` over the memory fixture with
 * a scripted `generate`, one run driven to completion, an assembled
 * reproduction artifact, a quiescent close) is genuinely run — not merely
 * compiled. `createSqliteStorageFixture`/`createLmdbStorageFixture` are
 * imported and re-exported (proving the name resolves through the tarball)
 * but not executed here — the issue's own executed scenario is the memory
 * fixture only.
 */
const HARNESS_PROBE_MODULE = `import { createAgent } from '@lostgradient/operative';
import { createEventRecorder } from '@lostgradient/operative/test';
import type {
  BureauQuiescenceReport,
  BureauStorageFixture,
  BureauTestHarness,
  BureauTestHarnessOptions,
  ReproductionArtifact,
} from 'bureau/test';
import {
  assembleReproductionArtifact,
  assertBureauQuiescent,
  createBureauTestHarness,
  createLmdbStorageFixture,
  createMemoryStorageFixture,
  createSqliteStorageFixture,
} from 'bureau/test';

import { packageVersions, sourceRevision } from './probe-environment';

// Imported and re-exported so \`tsc\` proves each name resolves through the
// installed tarball, even though the executed scenario below drives only
// the memory fixture.
export { assertBureauQuiescent, createLmdbStorageFixture, createSqliteStorageFixture };
export type { BureauStorageFixture, BureauTestHarnessOptions };

export interface HarnessProbeOutcome {
  readonly artifact: ReproductionArtifact;
  readonly report: BureauQuiescenceReport;
}

export async function runHarnessProbe(): Promise<HarnessProbeOutcome> {
  const storage = createMemoryStorageFixture();
  const harness = await createBureauTestHarness({
    agents: {
      worker: createAgent({
        name: 'worker',
        generate: async () => ({ content: 'worker done', toolCalls: [] }),
      }),
    },
    generate: async () => ({ content: 'harness probe done', toolCalls: [] }),
    provider: { provider: 'anthropic', model: 'claude-test' },
    storage,
  });

  const recorder = createEventRecorder(harness.runtime);
  const run = harness.startRun('worker', 'hello');
  recorder.attachIterable(run, { kind: 'run', id: 'harness-probe-run' });

  const terminalResult = await run.result();
  const cleanupReport = await run.closed();
  await harness.runtime.deferred.drain();

  if (terminalResult.finishReason !== 'stop-condition') {
    throw new Error(\`harness probe: unexpected finishReason \${terminalResult.finishReason}\`);
  }

  const artifact = await assembleReproductionArtifact(
    harness,
    recorder,
    { terminalResult, cleanupReport },
    { sourceRevision, packageVersions },
  );

  if (artifact.sourceRevision !== sourceRevision) {
    throw new Error(
      \`harness probe: artifact.sourceRevision did not come from the explicit environment argument\`,
    );
  }
  if (JSON.stringify(artifact.packageVersions) !== JSON.stringify(packageVersions)) {
    throw new Error(
      \`harness probe: artifact.packageVersions did not come from the explicit environment argument\`,
    );
  }

  const report = await harness.close();
  if (!report.quiescent) {
    throw new Error(
      \`harness probe: harness not quiescent after close(): \${JSON.stringify(report.leaked)}\`,
    );
  }

  return { artifact, report };
}
`;

const HARNESS_PROBE_TEST = `import { describe, expect, it } from 'bun:test';

import { runHarnessProbe } from '../src/harness-probe';

describe('bureau test-kit harness probe (AB-264)', () => {
  it('drives a real harness run through the memory fixture, assembles a reproduction artifact via the explicit environment argument, and closes quiescent', async () => {
    const { artifact, report } = await runHarnessProbe();

    expect(report.quiescent).toBe(true);
    expect(report.leaked).toEqual([]);
    expect(artifact.effectiveModel).toEqual({ provider: 'anthropic', model: 'claude-test' });
    expect(artifact.causalTrace.length).toBeGreaterThan(0);
  });
});
`;

// AB-264: a negative probe naming an export \`bureau/test\` has never had —
// proves the check is load-bearing rather than vacuous (mirrors AB-259's
// \`kit-negative/\` pattern). Written outside \`src/\`/\`test/\` so it is
// excluded from the whole-consumer \`tsc --noEmit\` and checked individually.
const BUREAU_NEGATIVE_PROBES: Record<string, string> = {
  'bureau-nonexistent-export.ts': `// This name has never existed on the \`bureau/test\` kit. If this ever
// compiles, the negative probe has gone vacuous — a future kit rename could
// then silently pass verification. See AB-264.
import { createBureauTestExportThatDoesNotExist } from 'bureau/test';

export { createBureauTestExportThatDoesNotExist };
`,
};

/**
 * Checks every probe file in `subdirectory` (relative to `directory`)
 * individually with its own `tsc` invocation, asserting each one FAILS to
 * compile. Mirrors `scripts/verify-operative-consumer.ts`'s
 * `verifyProbesFailCompilation`, including the `TS5xxx`-rejection guard: a
 * nonzero exit alone is not sufficient evidence, since TypeScript 6's
 * `TS5112` ("a file was named on the command line inside a directory that
 * also has a tsconfig.json") fails EVERY per-file invocation regardless of
 * whether the probe's own import genuinely fails to compile — `--ignoreConfig`
 * avoids that, and this guard requires at least one genuine `TSxxxx`
 * diagnostic outside the `TS5xxx` configuration range so a future
 * TypeScript version adding another such diagnostic cannot silently
 * re-vacuate the check.
 */
async function verifyProbesFailCompilation(
  directory: string,
  subdirectory: string,
  probes: Readonly<Record<string, string>>,
): Promise<void> {
  for (const filename of Object.keys(probes)) {
    const relativePath = join(subdirectory, filename);
    const result = await runExpectingFailure(
      [
        'bunx',
        'tsc',
        '--noEmit',
        '--strict',
        '--module',
        'esnext',
        '--moduleResolution',
        'bundler',
        '--target',
        'esnext',
        '--ignoreConfig',
        relativePath,
      ],
      directory,
    );
    if (result.exitCode === 0) {
      throw new Error(
        `Probe ${relativePath} unexpectedly compiled — the surface it targets still exists:\n${result.output}`,
      );
    }
    if (!/\bTS(?!5\d{3}\b)\d{4}\b/.test(result.output)) {
      throw new Error(
        `Probe ${relativePath} failed to compile, but only with a TS5xxx configuration ` +
          `diagnostic — not a genuine failure of the probe's own nonexistent import:\n${result.output}`,
      );
    }
    console.log(`  ${relativePath}: ${result.output.trim().split('\n')[0]}`);
  }
}

/**
 * The executed harness probe (`src/harness-probe.ts`) type-checks on its
 * own, with its own `tsc` invocation — mirroring AB-259's
 * `verifyKitProbeTypeChecksStandalone`, asserting SUCCESS instead of
 * failure.
 */
async function verifyHarnessProbeTypeChecksStandalone(directory: string): Promise<void> {
  const relativePath = join('src', 'harness-probe.ts');
  await run(
    [
      'bunx',
      'tsc',
      '--noEmit',
      '--strict',
      '--module',
      'esnext',
      '--moduleResolution',
      'bundler',
      '--target',
      'esnext',
      '--ignoreConfig',
      relativePath,
    ],
    directory,
  );
}

/**
 * Asserts a packed `bureau` tarball actually contains the `./test`
 * subpath's build output — matching `packages/bureau/package.json`'s
 * `exports["./test"]` — so a build-configuration regression that stops
 * emitting it fails here, at verification time, rather than surfacing only
 * at a real consumer's install.
 */
async function verifyTarballContainsTestSubpath(tarball: string): Promise<void> {
  const requiredEntries = [
    'package/dist/test/index.js',
    'package/dist/test/index.cjs',
    'package/dist/test/index.d.ts',
  ];
  const stdout = await runForStdout(['tar', '-tzf', tarball], root);
  const entries = new Set(
    stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  );
  const missing = requiredEntries.filter((entry) => !entries.has(entry));
  if (missing.length > 0) {
    throw new Error(
      `Packed bureau tarball is missing the ./test subpath's build output: ${missing.join(', ')}`,
    );
  }
}

async function main(): Promise<void> {
  await run(['turbo', 'run', 'build', '--filter=bureau'], root);
  await verifyStructuralBoundary();

  const directoryByPackageName = await resolveBureauWorkspaceSiblings();
  const staging = await mkdtemp(join(tmpdir(), 'bureau-tarball-pack-'));
  const directory = await mkdtemp(join(tmpdir(), 'bureau-tarball-consumer-'));
  try {
    const tarballs: Record<string, string> = {};
    for (const [packageName, directoryName] of Object.entries(directoryByPackageName)) {
      tarballs[packageName] = await packWorkspacePackage(directoryName, staging);
    }
    const bureauTarball = await packWorkspacePackage('bureau', staging);
    await verifyTarballContainsTestSubpath(bureauTarball);
    const probeEnvironment = await readProbeEnvironment();

    await Bun.write(
      join(directory, 'package.json'),
      JSON.stringify(
        {
          name: 'bureau-tarball-consumer-check',
          private: true,
          type: 'module',
          dependencies: {
            bureau: `file:${bureauTarball}`,
            ...Object.fromEntries(
              Object.entries(tarballs).map(([name, tarball]) => [name, `file:${tarball}`]),
            ),
            // Bureau's only two genuinely-published, registry-safe
            // dependencies — the ONLY names this manifest lets resolve
            // from the public registry.
            '@lostgradient/weft': '^0.23.1',
            zod: '^4.4.3',
          },
          devDependencies: { typescript: '6.0.3', '@types/bun': '1.3.14' },
          // bureau's OWN packed manifest declares its private siblings at
          // their internal workspace-resolved semver (e.g. "0.0.1") — a
          // version that does not, and never will, exist on the registry.
          // These overrides force every transitive reference to those names
          // (from bureau's packed manifest, or anyone else's) onto the SAME
          // local tarballs declared above, regardless of what version range
          // was requested — the point being proved: nothing here is ever
          // satisfied by a registry lookup.
          overrides: Object.fromEntries(
            Object.entries(tarballs).map(([name, tarball]) => [name, `file:${tarball}`]),
          ),
        },
        null,
        2,
      ),
    );
    await Bun.write(
      join(directory, 'tsconfig.json'),
      JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            skipLibCheck: false,
            module: 'Preserve',
            moduleResolution: 'bundler',
            target: 'ESNext',
            types: ['bun'],
            noEmit: true,
          },
          include: ['src/**/*.ts', 'test/**/*.ts'],
        },
        null,
        2,
      ),
    );
    await Bun.write(
      join(directory, 'src', 'index.ts'),
      `import { createBureau } from 'bureau';
import { waitForCondition } from 'bureau/test';

export { createBureau, waitForCondition };
`,
    );
    await Bun.write(
      join(directory, 'test', 'smoke.test.ts'),
      `import { createBureau } from 'bureau';
import { waitForCondition } from 'bureau/test';
import { describe, expect, it } from 'bun:test';

describe('bureau tarball boundary — path-installed consumer', () => {
  it('imports and constructs a bureau with no agents from the packed tarball', async () => {
    const bureau = await createBureau({
      agents: {},
      generate: async () => ({ content: 'ok', toolCalls: [] }),
    });
    try {
      expect(bureau.ready).toBe(true);
      expect(bureau.agents.names()).toEqual([]);
      // Exercises the ./test subpath too — waitForCondition is a plain
      // predicate-poll helper, satisfied immediately here.
      await waitForCondition(() => bureau.ready, 'bureau never became ready');
    } finally {
      bureau.dispose();
    }
  });
});
`,
    );
    await Bun.write(
      join(directory, 'src', 'probe-environment.ts'),
      renderProbeEnvironmentModule(probeEnvironment),
    );
    await Bun.write(join(directory, 'src', 'harness-probe.ts'), HARNESS_PROBE_MODULE);
    await Bun.write(join(directory, 'test', 'harness-probe.test.ts'), HARNESS_PROBE_TEST);
    for (const [filename, content] of Object.entries(BUREAU_NEGATIVE_PROBES)) {
      await Bun.write(join(directory, 'bureau-negative', filename), content);
    }

    await run(['bun', 'install'], directory);
    // The lockfile itself is the strongest evidence: it resolves bureau and
    // every one of its private siblings to local file paths, never to a
    // registry entry — there is no registry entry to resolve them to. Each
    // package's OWN "packages" entry is checked individually (rather than a
    // whole-file substring search) so a sibling that slipped through to the
    // registry is caught even when other siblings are correctly local.
    const lockText = await Bun.file(join(directory, 'bun.lock')).text();
    const packagesStart = lockText.indexOf('"packages": {');
    if (packagesStart === -1) throw new Error('bun.lock has no "packages" block');
    const packageLines = lockText
      .slice(packagesStart)
      .split('\n')
      .filter((line) => /^\s*"[^"]+":\s*\[/.test(line));

    const expectedLocalPackages = new Set(['bureau', ...Object.keys(directoryByPackageName)]);
    const seen = new Set<string>();
    for (const line of packageLines) {
      const keyMatch = /^\s*"([^"]+)":/.exec(line);
      const key = keyMatch?.[1];
      if (!key) continue;
      // A NESTED resolution of one of our expected packages (a different
      // version resolved beneath a specific importer, e.g. one Bureau
      // sibling depending on another) gets an importer-PREFIXED lock key
      // like "bureau/memory", not the bare "memory" the top-level
      // resolution uses. Match either form — a nested resolution that
      // slipped through to the registry while the top-level one stayed
      // local must still fail this check.
      const matched = [...expectedLocalPackages].find(
        (name) => key === name || key.endsWith(`/${name}`),
      );
      if (!matched) continue;
      seen.add(matched);
      // `bun.lock` embeds a `file:`-installed dependency's resolved spec as
      // `"<name>@<absolute path>.tgz"` — no literal "file:" scheme prefix.
      // The one thing that conclusively distinguishes it from a registry
      // resolution (always a bare semver, e.g. `"<name>@1.2.3"`) is that the
      // path lives inside OUR staging directory.
      if (!line.includes(staging) || !line.includes('.tgz')) {
        throw new Error(
          `${key} did not resolve through this run's local tarball in bun.lock:\n${line}`,
        );
      }
    }
    for (const name of expectedLocalPackages) {
      if (!seen.has(name)) {
        throw new Error(`bun.lock never resolved ${name} at all`);
      }
    }

    await run(['bunx', 'tsc', '--noEmit'], directory);
    await verifyHarnessProbeTypeChecksStandalone(directory);
    await run(['bun', 'test'], directory);
    await verifyProbesFailCompilation(directory, 'bureau-negative', BUREAU_NEGATIVE_PROBES);

    console.log(
      'Bureau tarball boundary verification passed: bureau and every workspace-private ' +
        'sibling install by local path only, the public surface + ./test subpath work, the ' +
        'tarball carries the ./test subpath build output, the executed harness-driven kit ' +
        'probe (assembleReproductionArtifact via the explicit environment argument, AB-264) ' +
        'ran to a quiescent close, and the negative probe still fails compilation.',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(staging, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
