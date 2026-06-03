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
 *   2. Runs the package-shape gate (`check-package-shape.ts`) immediately before publishing, as a
 *      fail-closed guard: a foundation-package leak, an undeclared external, or a payload-affecting
 *      lifecycle script aborts the publish.
 *   3. Publishes with `npm publish --provenance --access public --ignore-scripts` from the package
 *      directory. Provenance requires publishing from a directory with repository context (npm does
 *      NOT generate provenance for a prebuilt tarball), so we publish the directory whose `npm pack`
 *      output the gate just validated, with no mutation in between. `--ignore-scripts` guarantees no
 *      lifecycle hook rebuilds the payload after validation.
 *
 * Partial-failure protocol: if a publish fails mid-batch we stop, do NOT unpublish, and report
 * exactly which packages published and which did not. Recovery is fix-forward / a safe re-run — the
 * skip-if-published check makes re-running harmless.
 *
 * The npm binary is resolved from the environment (the release workflow pins `npm@^11`); we assert
 * the version is new enough for trusted publishing before touching the registry.
 */
import { resolve } from 'node:path';

import { $ } from 'bun';

const PUBLISHABLE_PACKAGES = ['armorer', 'conversationalist'] as const;

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

async function publishPackage(packageName: string): Promise<PublishOutcome> {
  const packageDirectory = resolve(repositoryRoot, 'packages', packageName);
  const localVersion = await readLocalVersion(packageDirectory);
  const published = await publishedVersions(packageName);

  if (published.has(localVersion)) {
    console.log(`• ${packageName}@${localVersion} is already published — skipping.`);
    return 'skipped';
  }

  console.log(`• ${packageName}@${localVersion}: validating package shape…`);
  const gate =
    await $`bun run ${resolve(repositoryRoot, 'scripts/check-package-shape.ts')} ${packageName}`
      .cwd(repositoryRoot)
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

const outcomes: Array<{ package: string; outcome: PublishOutcome }> = [];
let aborted = false;

for (const packageName of PUBLISHABLE_PACKAGES) {
  const outcome = await publishPackage(packageName);
  outcomes.push({ package: packageName, outcome });
  if (outcome === 'failed') {
    aborted = true;
    break;
  }
}

const published = outcomes
  .filter((entry) => entry.outcome === 'published')
  .map((entry) => entry.package);
const skipped = outcomes
  .filter((entry) => entry.outcome === 'skipped')
  .map((entry) => entry.package);
const failed = outcomes.filter((entry) => entry.outcome === 'failed').map((entry) => entry.package);

console.log('\nRelease summary:');
console.log(`  published: ${published.length ? published.join(', ') : '(none)'}`);
console.log(`  skipped:   ${skipped.length ? skipped.join(', ') : '(none)'}`);
if (failed.length) console.log(`  failed:    ${failed.join(', ')}`);

if (aborted) {
  const notAttempted = PUBLISHABLE_PACKAGES.filter(
    (name) => !outcomes.some((entry) => entry.package === name),
  );
  if (notAttempted.length) console.error(`  not attempted: ${notAttempted.join(', ')}`);
  console.error(
    '\n✖ Release aborted on failure. Already-published packages are left as-is (no unpublish). ' +
      'Fix forward and re-run — published versions are skipped automatically.',
  );
  process.exit(1);
}

console.log('\n✓ Release complete.');
