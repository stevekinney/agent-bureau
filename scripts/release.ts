/**
 * Idempotent publisher for the trusted-publishing pipeline.
 *
 * Invoked by `changesets/action` as the `publish` step once a "Version Packages" pull request has
 * merged to `main`. For each publishable package it:
 *
 *   1. Reads the local version and compares it against the versions already on the npm registry.
 *      If the local version is already published, the package is SKIPPED (no error) — so re-runs
 *      after a partial failure, and releases that bumped only one package, never fail on the
 *      unchanged one.
 *   2. Rewrites any `workspace:`-protocol dependency in `dependencies`/`peerDependencies`/
 *      `optionalDependencies` to the depended-on package's concrete current version, in place, on
 *      disk (see `rewriteWorkspaceDependencies`). Internal packages keep depending on each other via
 *      `workspace:*` in source -- consumers outside the monorepo cannot resolve that protocol, so it
 *      has to become a real version before anything gets packed or published. This runs only in the
 *      release workflow's own CI checkout and is never committed.
 *   3. Runs the package-shape gate (`check-package-shape.ts`) immediately before publishing, as a
 *      fail-closed guard, against the just-rewritten manifest: a foundation-package leak, an
 *      undeclared external, a payload-affecting lifecycle script, a remaining `workspace:`/`catalog:`
 *      specifier, or a dependency on another workspace package at a version that isn't actually on
 *      the registry (or published earlier in this same run -- see `RELEASE_KNOWN_VERSIONS` below)
 *      each abort the publish.
 *   4. Publishes with `npm publish --provenance --access public --ignore-scripts` from the package
 *      directory (not a prebuilt tarball). Provenance requires publishing from a directory with
 *      repository context; this is the known-good path for this pipeline, so a package's own
 *      dependency rewrite (step 2) happens in place in that same directory before this runs, rather
 *      than switching to a packed-tarball publish. `--ignore-scripts` guarantees no lifecycle hook
 *      rebuilds the payload after validation.
 *
 * Partial-failure protocol: if a publish fails mid-batch we stop, do NOT unpublish, and report
 * exactly which packages published and which did not. Recovery is fix-forward / a safe re-run — the
 * skip-if-published check makes re-running harmless. A re-run starts from a completely fresh
 * `actions/checkout`, so an in-place dependency rewrite from an earlier, failed attempt is never
 * still on disk to worry about.
 *
 * `RELEASE_KNOWN_VERSIONS`: as this script works through `RELEASE_INVENTORY` in order, it accumulates
 * a `{ packageName: version }` map of every target it has already settled (skipped as already
 * published, or just published) and passes it to `check-package-shape.ts` for every subsequent
 * target. This is what lets the shape gate confirm a same-run dependency (e.g. `tool-protocol` on
 * `lifecycle`, published a few packages earlier in this exact run) without depending on npm registry
 * read-after-write propagation timing.
 *
 * The npm binary is resolved from the environment (the release workflow pins `npm@^11`); we assert
 * the version is new enough for trusted publishing before touching the registry.
 */
import { resolve } from 'node:path';

import { $ } from 'bun';

export type ReleaseTarget = {
  /** The package's directory under `packages/`, e.g. `operative`. */
  directory: string;
  /** The name the package publishes under on npm, e.g. `@lostgradient/operative`. */
  packageName: string;
};

export const RELEASE_INVENTORY: readonly ReleaseTarget[] = [
  // The four foundation packages armorer/conversationalist/operative declare a `workspace:*`
  // dependency on in source today, listed before their dependents in a valid dependency order:
  // `cryptography` and `embeddings` depend on nothing else here, so they lead; `lifecycle` has no
  // internal dependency either; `tool-protocol` depends on `lifecycle` and so comes after it. This
  // ordering matches the order `.github/workflows/mirror-verify.yaml` packs and verifies them in.
  //
  // This order is also what makes RELEASE_KNOWN_VERSIONS (see the module docstring) work: by the
  // time armorer/conversationalist/operative are processed, all four packages above them are
  // already settled (skipped or published), so the package-shape gate can confirm their rewritten
  // `workspace:*` dependencies against this run's own state rather than only against the registry.
  // `bunx changeset version` does NOT rewrite `workspace:*` on its own -- verified directly, and it
  // contradicts a claim RELEASING.md used to make, corrected on this branch -- so this file's own
  // rewrite step (`rewriteWorkspaceDependencies`) is what makes that safe.
  { directory: 'cryptography', packageName: '@lostgradient/cryptography' },
  { directory: 'embeddings', packageName: '@lostgradient/embeddings' },
  { directory: 'lifecycle', packageName: '@lostgradient/lifecycle' },
  { directory: 'tool-protocol', packageName: '@lostgradient/tool-protocol' },
  { directory: 'armorer', packageName: 'armorer' },
  { directory: 'conversationalist', packageName: 'conversationalist' },
  { directory: 'operative', packageName: '@lostgradient/operative' },
];

const MINIMUM_NPM_VERSION = [11, 5, 1] as const;

const repositoryRoot = resolve(import.meta.dir, '..');

type PublishOutcome = 'published' | 'skipped' | 'failed';

function parseSemver(version: string): [number, number, number] {
  const [core] = version.split('-');
  const parts = core.split('.').map((value) => Number.parseInt(value, 10));
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

function isAtLeast(
  actual: [number, number, number],
  minimum: readonly [number, number, number],
): boolean {
  for (let index = 0; index < 3; index += 1) {
    if (actual[index] > minimum[index]) return true;
    if (actual[index] < minimum[index]) return false;
  }
  return true;
}

async function assertNpmVersion(): Promise<void> {
  const result = await $`npm --version`.quiet().nothrow();
  if (result.exitCode !== 0) {
    throw new Error('npm is not available on PATH');
  }
  const version = result.stdout.toString().trim();
  if (!isAtLeast(parseSemver(version), MINIMUM_NPM_VERSION)) {
    throw new Error(
      `npm ${version} is too old for trusted publishing; need >= ${MINIMUM_NPM_VERSION.join('.')}`,
    );
  }
  console.log(`Using npm ${version}`);
}

/** The set of versions already published for a package, or an empty set if the name is unpublished. */
async function publishedVersions(packageName: string): Promise<Set<string>> {
  const result = await $`npm view ${packageName} versions --json`.quiet().nothrow();
  if (result.exitCode !== 0) {
    // A brand-new (never-published) name returns a 404 — treat as "nothing published yet".
    return new Set();
  }
  const raw = result.stdout.toString().trim();
  if (!raw) return new Set();
  const parsed = JSON.parse(raw) as string | string[];
  return new Set(Array.isArray(parsed) ? parsed : [parsed]);
}

async function readLocalVersion(packageDirectory: string): Promise<string> {
  const manifest = (await Bun.file(resolve(packageDirectory, 'package.json')).json()) as {
    version: string;
  };
  return manifest.version;
}

/** Every workspace package's public name and current local version, keyed by public name. */
export async function workspaceVersionsByName(): Promise<Map<string, string>> {
  const versions = new Map<string, string>();
  const glob = new Bun.Glob('packages/*/package.json');
  for await (const manifestPath of glob.scan({ cwd: repositoryRoot, onlyFiles: true })) {
    const manifest = (await Bun.file(resolve(repositoryRoot, manifestPath)).json()) as {
      name?: string;
      version?: string;
    };
    if (manifest.name && manifest.version) versions.set(manifest.name, manifest.version);
  }
  return versions;
}

const DEPENDENCY_SECTIONS_TO_REWRITE = [
  'dependencies',
  'peerDependencies',
  'optionalDependencies',
] as const;

/**
 * A `workspace:` specifier's part after the colon selects how the resolved version is ranged:
 * `*` (the only form this workspace uses today) becomes the exact version, matching what
 * `bun pm pack` itself produces for a `workspace:*` dependency (verified directly against
 * `tool-protocol`'s packed manifest: `"@lostgradient/lifecycle": "workspace:*"` became
 * `"@lostgradient/lifecycle": "0.0.1"`, no operator). `^`/`~` carry their operator through, and an
 * explicit version after the colon (`workspace:1.2.3`) is used as-is, per the same convention
 * Bun/pnpm/Yarn use for the workspace protocol generally.
 */
export function resolveWorkspaceRange(specifier: string, targetVersion: string): string {
  const spec = specifier.slice('workspace:'.length);
  if (spec === '*' || spec === '') return targetVersion;
  if (spec === '^') return `^${targetVersion}`;
  if (spec === '~') return `~${targetVersion}`;
  return spec; // an explicit version pinned under the workspace: protocol -- use it as given
}

/**
 * Rewrites every `workspace:`-protocol dependency in `dependencies`, `peerDependencies`, and
 * `optionalDependencies` to the depended-on package's concrete current version, in place, on disk.
 *
 * `devDependencies` is deliberately left untouched: npm never installs a package's
 * `devDependencies` for anyone depending on it, so a `workspace:*` left there cannot break a
 * consumer's install. (Today, nothing in this workspace's `devDependencies` uses the `workspace:`
 * protocol at all -- verified by scanning every `packages/*\/package.json` -- so this is a policy
 * decision for the future, not a live gap.) The package-shape gate still refuses one if it ever
 * appears, as shipped-manifest hygiene, independent of whether it would actually break an install.
 *
 * This runs only inside the release workflow's own (always freshly checked out) CI runner, and the
 * rewritten file is never committed or pushed anywhere -- `release.yml` has no `git commit`/`git
 * push` step after this runs, and the next workflow run starts from a clean `actions/checkout`
 * regardless. So this does not restore the original file afterward: nothing later in the same run
 * re-reads this package's dependency specifiers (a later package's own rewrite reads other
 * packages' `name`/`version`, never their `dependencies`), and a failed run's "re-run is safe"
 * guarantee already depends on starting from a fresh checkout, not on this file's in-place state.
 */
export async function rewriteWorkspaceDependencies(
  packageDirectory: string,
  workspaceVersions: ReadonlyMap<string, string>,
): Promise<void> {
  const manifestPath = resolve(packageDirectory, 'package.json');
  const manifest = (await Bun.file(manifestPath).json()) as Record<string, unknown>;

  for (const section of DEPENDENCY_SECTIONS_TO_REWRITE) {
    const dependencies = manifest[section] as Record<string, string> | undefined;
    if (!dependencies) continue;

    for (const [dependencyName, versionRange] of Object.entries(dependencies)) {
      if (!versionRange.startsWith('workspace:')) continue;

      const targetVersion = workspaceVersions.get(dependencyName);
      if (!targetVersion) {
        throw new Error(
          `${manifestPath}: ${section}.${dependencyName} uses "${versionRange}" but no ` +
            `packages/*/package.json declares a package named "${dependencyName}" to resolve it against.`,
        );
      }
      dependencies[dependencyName] = resolveWorkspaceRange(versionRange, targetVersion);
    }
  }

  await Bun.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function publishPackage(
  target: ReleaseTarget,
  settledVersions: ReadonlyMap<string, string>,
  workspaceVersions: ReadonlyMap<string, string>,
): Promise<PublishOutcome> {
  const { directory, packageName } = target;
  const packageDirectory = resolve(repositoryRoot, 'packages', directory);
  const localVersion = await readLocalVersion(packageDirectory);
  const published = await publishedVersions(packageName);

  if (published.has(localVersion)) {
    console.log(`• ${packageName}@${localVersion} is already published — skipping.`);
    return 'skipped';
  }

  console.log(`• ${packageName}@${localVersion}: rewriting workspace: dependencies…`);
  await rewriteWorkspaceDependencies(packageDirectory, workspaceVersions);

  console.log(`• ${packageName}@${localVersion}: validating package shape…`);
  const gate =
    await $`bun run ${resolve(repositoryRoot, 'scripts/check-package-shape.ts')} ${directory}`
      .cwd(repositoryRoot)
      .env({
        ...process.env,
        RELEASE_KNOWN_VERSIONS: JSON.stringify(Object.fromEntries(settledVersions)),
      })
      .nothrow();
  if (gate.exitCode !== 0) {
    console.error(`✖ ${packageName}: package-shape gate failed — not publishing.`);
    return 'failed';
  }

  console.log(`• ${packageName}@${localVersion}: publishing with provenance…`);
  const publish = await $`npm publish --provenance --access public --ignore-scripts`
    .cwd(packageDirectory)
    .nothrow();
  if (publish.exitCode !== 0) {
    console.error(`✖ ${packageName}: npm publish failed.`);
    return 'failed';
  }

  console.log(`✓ ${packageName}@${localVersion} published.`);
  return 'published';
}

async function main(): Promise<void> {
  // Publishing is opt-in. Until the npm trusted publishers are registered and you're ready to ship,
  // leave `RELEASE_ENABLED` unset so a merge to main lands the pipeline without attempting to publish
  // (which would otherwise fail auth and turn the run red). Set the `RELEASE_ENABLED` repository
  // variable to `true` in the release workflow's env to arm publishing.
  if (process.env['RELEASE_ENABLED'] !== 'true') {
    console.log(
      'Publishing is disabled (RELEASE_ENABLED is not "true"). ' +
        'Set the RELEASE_ENABLED repository variable once the npm trusted publishers are configured. ' +
        'Skipping publish.',
    );
    process.exit(0);
  }

  await assertNpmVersion();

  // Every workspace package's current local version, used both to resolve `workspace:*`
  // dependencies against and, for a target this run settles (skips or publishes), to record in
  // `settledVersions` below -- it's the same version either way, since a skip only happens when
  // that exact local version is already the one on the registry.
  const workspaceVersions = await workspaceVersionsByName();
  const settledVersions = new Map<string, string>();

  const outcomes: Array<{ package: string; outcome: PublishOutcome }> = [];
  let aborted = false;

  for (const target of RELEASE_INVENTORY) {
    const outcome = await publishPackage(target, settledVersions, workspaceVersions);
    outcomes.push({ package: target.packageName, outcome });
    if (outcome === 'failed') {
      aborted = true;
      break;
    }
    const localVersion = workspaceVersions.get(target.packageName);
    if (localVersion) settledVersions.set(target.packageName, localVersion);
  }

  const published = outcomes
    .filter((entry) => entry.outcome === 'published')
    .map((entry) => entry.package);
  const skipped = outcomes
    .filter((entry) => entry.outcome === 'skipped')
    .map((entry) => entry.package);
  const failed = outcomes
    .filter((entry) => entry.outcome === 'failed')
    .map((entry) => entry.package);

  console.log('\nRelease summary:');
  console.log(`  published: ${published.length ? published.join(', ') : '(none)'}`);
  console.log(`  skipped:   ${skipped.length ? skipped.join(', ') : '(none)'}`);
  if (failed.length) console.log(`  failed:    ${failed.join(', ')}`);

  if (aborted) {
    const notAttempted = RELEASE_INVENTORY.filter(
      (target) => !outcomes.some((entry) => entry.package === target.packageName),
    ).map((target) => target.packageName);
    if (notAttempted.length) console.error(`  not attempted: ${notAttempted.join(', ')}`);
    console.error(
      '\n✖ Release aborted on failure. Already-published packages are left as-is (no unpublish). ' +
        'Fix forward and re-run — published versions are skipped automatically.',
    );
    process.exit(1);
  }

  console.log('\n✓ Release complete.');
}

if (import.meta.main) {
  await main();
}
