/**
 * Package-shape gate for the publishable artifact targets (`armorer`, `conversationalist`,
 * `operative`). Keep this list aligned with the package names passed by the root script and CI.
 *
 * Builds nothing itself — it runs against an already-built package directory. For the target
 * package it produces a REAL tarball with `npm pack`, extracts it, and asserts the published
 * artifact is self-contained and internally consistent:
 *
 *   1. Every file-referencing `package.json` field (`exports` conditions, `main`, `module`,
 *      `types`, `typesVersions`, `bin`) resolves to a file that exists in the tarball.
 *   2. No shipped `.js/.mjs/.cjs/.d.ts/.d.mts/.d.cts` imports a monorepo-internal foundation
 *      package (`lifecycle`, `interoperability`) — those must be inlined at build time.
 *   3. Every other bare import in shipped code is either a Node/Bun builtin, a self-reference to
 *      this package, or declared in `dependencies`/`peerDependencies`. Catches a real external
 *      left undeclared (the same `Cannot find module` failure class as a foundation leak).
 *   4. No dependency field in the shipped manifest uses a workspace-only protocol such as
 *      `workspace:*` or `catalog:`, because external consumers cannot resolve the monorepo. And
 *      for a dependency that names another workspace package by a concrete version (as
 *      `scripts/release.ts` rewrites a `workspace:*` specifier to just before publishing): that
 *      version must actually exist — either on the npm registry already, or in the
 *      `RELEASE_KNOWN_VERSIONS` environment variable `scripts/release.ts` sets to the versions it
 *      has already published or confirmed published earlier in the same run. This is what would
 *      have caught this class of bug before it happened: publishing a package whose dependency on
 *      a sibling package hasn't actually been published yet is refused, not just one that still
 *      says `workspace:*`.
 *   5. No `package.json` lifecycle script (`prepack`/`prepare`/`prepublishOnly`/`publish`/
 *      `postpack`/`postpublish`) can mutate the publish payload — so the bytes `npm pack` validated
 *      are the bytes `npm publish` ships.
 *   6. Expected `README`/`LICENSE`/`dist` present; no source `.ts` accidentally shipped.
 *
 * The import scan strips comments first and matches only real module specifiers, avoiding the
 * false-positive classes observed during the tsdown migration: tsdown `//#region` markers, object
 * properties named like a package, JSDoc `@example` imports, and bare Node builtins (`url`).
 *
 * Usage: `bun run scripts/check-package-shape.ts <packageDirectory> [<packageDirectory> ...]`
 * Exit code 0 = all gates pass; 1 = at least one gate failed (fail-closed).
 */
import { builtinModules } from 'node:module';
import { join, resolve } from 'node:path';

import { $ } from 'bun';

const FOUNDATION_PACKAGES = new Set(['lifecycle', 'interoperability']);

const PAYLOAD_AFFECTING_LIFECYCLE_SCRIPTS = [
  'prepack',
  'prepare',
  'prepublishOnly',
  'publish',
  'postpack',
  'postpublish',
] as const;

const SHIPPED_CODE_EXTENSIONS = ['.js', '.mjs', '.cjs', '.d.ts', '.d.mts', '.d.cts'];

const BUILTINS = new Set<string>([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
]);

/**
 * `package.json#exports` condition values nest: a condition (e.g. `"import"`) can itself map to
 * further conditions (e.g. `{ "types": ..., "default": ... }`), to `null` (an explicitly blocked
 * subpath, as `conversationalist`'s `"browser": null` uses), or to an array of fallbacks. Any of
 * those can appear at any depth, so the target collector below must recurse rather than assume a
 * single level of `{ [condition]: string }`.
 */
export type ExportsConditionValue =
  string | null | readonly ExportsConditionValue[] | { [condition: string]: ExportsConditionValue };

export type PackageManifest = {
  name: string;
  version: string;
  main?: string;
  module?: string;
  types?: string;
  bin?: string | Record<string, string>;
  typesVersions?: Record<string, Record<string, string[]>>;
  exports?: Record<string, ExportsConditionValue>;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
  files?: string[];
};

type Failure = { package: string; gate: string; detail: string };

const failures: Failure[] = [];

function fail(packageName: string, gate: string, detail: string): void {
  failures.push({ package: packageName, gate, detail });
}

function dependencySections(manifest: PackageManifest): Array<{
  name: string;
  dependencies: Record<string, string>;
}> {
  return [
    { name: 'dependencies', dependencies: manifest.dependencies ?? {} },
    { name: 'optionalDependencies', dependencies: manifest.optionalDependencies ?? {} },
    { name: 'peerDependencies', dependencies: manifest.peerDependencies ?? {} },
    { name: 'devDependencies', dependencies: manifest.devDependencies ?? {} },
  ];
}

/**
 * Every workspace package's public name, from every `packages/*\/package.json` — not just
 * publishable ones. A shipped dependency on any of these by a concrete version has to resolve on
 * the registry (or have been published earlier in this run); a shipped dependency on anything else
 * is an ordinary external and is never subject to that check.
 */
async function workspacePackageNames(): Promise<Set<string>> {
  const names = new Set<string>();
  const glob = new Bun.Glob('packages/*/package.json');
  for await (const manifestPath of glob.scan({
    cwd: resolve(import.meta.dir, '..'),
    onlyFiles: true,
  })) {
    const manifest = (await Bun.file(resolve(import.meta.dir, '..', manifestPath)).json()) as {
      name?: string;
    };
    if (manifest.name) names.add(manifest.name);
  }
  return names;
}

/**
 * Versions `scripts/release.ts` already knows are good for this run — either just published or
 * confirmed already on the registry for a package processed earlier in `RELEASE_INVENTORY`'s
 * order. Set as a `{ [packageName]: version }` JSON object in `RELEASE_KNOWN_VERSIONS`. Absent (or
 * unparseable, e.g. a standalone `bun run check-package-shape` invocation with no such run in
 * progress) is treated as empty — every internal dependency then falls through to the live
 * registry check below.
 */
function knownGoodVersionsFromEnvironment(): Map<string, string> {
  const raw = process.env['RELEASE_KNOWN_VERSIONS'];
  if (!raw) return new Map();
  try {
    const parsed = JSON.parse(raw) as Record<string, string>;
    return new Map(Object.entries(parsed));
  } catch {
    return new Map();
  }
}

/** Whether `name@version` is resolvable on the configured npm registry right now. */
async function registryHasVersion(name: string, version: string): Promise<boolean> {
  const result = await $`npm view ${`${name}@${version}`} version`.quiet().nothrow();
  if (result.exitCode !== 0) return false;
  return result.stdout.toString().trim() === version;
}

export type DependencySpecifierError = {
  section: string;
  dependencyName: string;
  versionRange: string;
  reason: 'workspace-or-catalog-protocol' | 'unpublished-internal-version';
};

/**
 * Gate 4, as a pure function over one manifest's dependency sections plus an injected policy, so
 * it's testable without a filesystem, a real `npm pack`, or a real registry call:
 *
 *   - Any `workspace:` or `catalog:` specifier is always an error — external consumers cannot
 *     resolve either protocol.
 *   - A concrete-version dependency that names another *workspace* package (per `workspaceNames`)
 *     is an error unless that exact version is already known-good (`knownGoodVersions` — what
 *     `scripts/release.ts` has already published or confirmed published earlier in this run) or
 *     resolves on the registry right now (`registryHasVersion`, called only for a workspace-named
 *     dependency that isn't already known-good, so an ordinary external dependency never triggers a
 *     network call).
 *   - A concrete-version dependency on anything that isn't a workspace package name at all is never
 *     checked — it's an ordinary external and none of this gate's business.
 */
export async function findDependencySpecifierErrors(
  manifest: PackageManifest,
  policy: {
    workspaceNames: ReadonlySet<string>;
    knownGoodVersions: ReadonlyMap<string, string>;
    registryHasVersion: (name: string, version: string) => Promise<boolean>;
  },
): Promise<DependencySpecifierError[]> {
  const errors: DependencySpecifierError[] = [];

  for (const { name: section, dependencies } of dependencySections(manifest)) {
    for (const [dependencyName, versionRange] of Object.entries(dependencies)) {
      if (versionRange.startsWith('workspace:') || versionRange.startsWith('catalog:')) {
        errors.push({
          section,
          dependencyName,
          versionRange,
          reason: 'workspace-or-catalog-protocol',
        });
        continue;
      }

      if (!policy.workspaceNames.has(dependencyName)) continue; // an ordinary external

      // `scripts/release.ts` rewrites `workspace:^` and `workspace:~` to a range over the
      // sibling's exact version, so the version to confirm is the one the range names.
      const version = versionRange.replace(/^[\^~]/, '');
      if (policy.knownGoodVersions.get(dependencyName) === version) continue;
      if (await policy.registryHasVersion(dependencyName, version)) continue;

      errors.push({
        section,
        dependencyName,
        versionRange,
        reason: 'unpublished-internal-version',
      });
    }
  }

  return errors;
}

/** Strip block and line comments so doc-comment and region markers never read as imports. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Extract real module specifiers from `import`/`export ... from`/`import(...)`/`require(...)`. */
function extractSpecifiers(source: string): string[] {
  const cleaned = stripComments(source);
  const specifiers: string[] = [];
  const patterns = [
    /(?:^|[^.\w])(?:import|export)\s+[^'";]*?\s+from\s*['"]([^'"]+)['"]/g,
    /(?:^|[^.\w])import\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(cleaned)) !== null) {
      if (match[1]) specifiers.push(match[1]);
    }
  }
  return specifiers;
}

/** The bare package name of a specifier: `@scope/pkg/sub` -> `@scope/pkg`, `pkg/sub` -> `pkg`. */
function barePackageName(specifier: string): string {
  if (specifier.startsWith('@')) {
    const [scope, name] = specifier.split('/');
    return name ? `${scope}/${name}` : specifier;
  }
  return specifier.split('/')[0] ?? specifier;
}

function isRelative(specifier: string): boolean {
  return specifier.startsWith('.') || specifier.startsWith('/');
}

function isBuiltin(specifier: string): boolean {
  if (specifier.startsWith('node:') || specifier.startsWith('bun:') || specifier === 'bun') {
    return true;
  }
  return BUILTINS.has(barePackageName(specifier));
}

async function listFiles(directory: string): Promise<string[]> {
  const entries: string[] = [];
  for await (const path of new Bun.Glob('**/*').scan({ cwd: directory, onlyFiles: true })) {
    entries.push(path);
  }
  return entries;
}

/**
 * Recursively walk an `exports` condition value and hand every string leaf to `push`. Handles
 * arbitrary nesting (`"import": { "types": ..., "default": ... }`), `null` leaves (an explicitly
 * blocked subpath, e.g. `"browser": null`), and array fallbacks — a flat `Object.values(...)`
 * pass over one level is not enough once a condition itself maps to another condition object.
 */
function collectExportsConditionTargets(
  value: ExportsConditionValue,
  push: (value: string) => void,
): void {
  if (value === null) return;
  if (typeof value === 'string') {
    push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectExportsConditionTargets(entry, push);
    return;
  }
  for (const nested of Object.values(value)) collectExportsConditionTargets(nested, push);
}

export function collectManifestFileTargets(manifest: PackageManifest): string[] {
  const targets: string[] = [];
  const push = (value: string | undefined): void => {
    if (value && value.startsWith('.')) targets.push(value);
  };

  push(manifest.main);
  push(manifest.module);
  push(manifest.types);

  if (typeof manifest.bin === 'string') push(manifest.bin);
  else if (manifest.bin) for (const value of Object.values(manifest.bin)) push(value);

  for (const condition of Object.values(manifest.exports ?? {})) {
    collectExportsConditionTargets(condition, push);
  }

  for (const mapping of Object.values(manifest.typesVersions ?? {})) {
    for (const value of Object.values(mapping)) {
      for (const entry of value) push(entry.startsWith('.') ? entry : `./${entry}`);
    }
  }

  return [...new Set(targets)];
}

async function checkPackage(packageName: string): Promise<void> {
  const packageDirectory = resolve(import.meta.dir, '..', 'packages', packageName);
  const manifestPath = join(packageDirectory, 'package.json');

  const manifestFile = Bun.file(manifestPath);
  if (!(await manifestFile.exists())) {
    fail(packageName, 'manifest', `package.json not found at ${manifestPath}`);
    return;
  }
  const manifest = (await manifestFile.json()) as PackageManifest;

  // Gate 4: no payload-affecting lifecycle script (checked on the source manifest, pre-pack).
  // If one exists we cannot trust the tarball — `npm pack` would run it and its output can even
  // corrupt `--json` — so we record the failure and skip the remaining tarball-based gates.
  let hasPayloadAffectingScript = false;
  for (const scriptName of PAYLOAD_AFFECTING_LIFECYCLE_SCRIPTS) {
    if (manifest.scripts?.[scriptName]) {
      hasPayloadAffectingScript = true;
      fail(
        packageName,
        'lifecycle-scripts',
        `"${scriptName}" exists ("${manifest.scripts[scriptName]}") and can mutate the publish payload after the gate runs. Remove it or make the validator run the identical lifecycle path.`,
      );
    }
  }
  if (hasPayloadAffectingScript) return;

  // Produce a REAL tarball and extract it into a temp directory.
  const stagingRoot = resolve(import.meta.dir, '..', 'tmp', 'package-shape', packageName);
  await $`rm -rf ${stagingRoot}`.quiet();
  await $`mkdir -p ${stagingRoot}`.quiet();

  const packResult = await $`npm pack --json --pack-destination ${stagingRoot}`
    .cwd(packageDirectory)
    .quiet()
    .nothrow();
  if (packResult.exitCode !== 0) {
    fail(packageName, 'npm-pack', `npm pack failed: ${packResult.stderr.toString().trim()}`);
    return;
  }

  let packedName: string | undefined;
  try {
    const parsed = JSON.parse(packResult.stdout.toString()) as Array<{ filename?: string }>;
    packedName = parsed[0]?.filename;
  } catch {
    fail(
      packageName,
      'npm-pack',
      'npm pack --json output was not valid JSON (a lifecycle script may have printed to stdout)',
    );
    return;
  }
  if (!packedName) {
    fail(packageName, 'npm-pack', 'npm pack produced no tarball filename');
    return;
  }
  // npm normalizes scoped tarball names; the file on disk replaces the leading `@scope/` form.
  const tarballOnDisk = packedName.replace(/^@/, '').replace(/\//g, '-');
  const extractDirectory = join(stagingRoot, 'extracted');
  await $`mkdir -p ${extractDirectory}`.quiet();
  await $`tar -xzf ${join(stagingRoot, tarballOnDisk)} -C ${extractDirectory}`.quiet().nothrow();

  // npm tarballs extract under a top-level `package/` directory.
  const packageRoot = join(extractDirectory, 'package');
  const packedManifest = (await Bun.file(
    join(packageRoot, 'package.json'),
  ).json()) as PackageManifest;
  const shippedFiles = await listFiles(packageRoot);
  const shippedSet = new Set(shippedFiles);

  // Gate 1: every file-referencing manifest field resolves inside the tarball.
  for (const target of collectManifestFileTargets(packedManifest)) {
    const normalized = target.replace(/^\.\//, '');
    if (!shippedSet.has(normalized)) {
      fail(
        packageName,
        'manifest-target',
        `${target} is referenced in package.json but not shipped in the tarball`,
      );
    }
  }

  // Gate 4: no workspace- or catalog-only dependency specifiers in the shipped manifest, and every
  // dependency that names another workspace package by a concrete version actually exists --
  // either on the registry already, or published earlier in this same `scripts/release.ts` run.
  const dependencyErrors = await findDependencySpecifierErrors(packedManifest, {
    workspaceNames: await workspacePackageNames(),
    knownGoodVersions: knownGoodVersionsFromEnvironment(),
    registryHasVersion,
  });
  for (const error of dependencyErrors) {
    if (error.reason === 'workspace-or-catalog-protocol') {
      fail(
        packageName,
        'workspace-dependency',
        `${error.section}.${error.dependencyName} uses "${error.versionRange}" in the shipped package.json; publishable packages must not require monorepo workspace or catalog resolution`,
      );
    } else {
      fail(
        packageName,
        'unpublished-internal-version',
        `${error.section}.${error.dependencyName} is pinned to "${error.versionRange}", which is not on the npm registry and was not published earlier in this run -- ${error.dependencyName} must publish before ${packageName} can depend on it`,
      );
    }
  }

  // Gates 2 + 3: import audit over shipped code only.
  const declared = new Set([
    ...Object.keys(packedManifest.dependencies ?? {}),
    ...Object.keys(packedManifest.peerDependencies ?? {}),
  ]);

  for (const relativePath of shippedFiles) {
    if (!SHIPPED_CODE_EXTENSIONS.some((extension) => relativePath.endsWith(extension))) continue;

    const source = await Bun.file(join(packageRoot, relativePath)).text();
    for (const specifier of extractSpecifiers(source)) {
      if (isRelative(specifier) || isBuiltin(specifier)) continue;

      const bare = barePackageName(specifier);

      if (FOUNDATION_PACKAGES.has(bare)) {
        fail(
          packageName,
          'foundation-leak',
          `${relativePath} imports the foundation package "${specifier}" — it must be inlined, not shipped as a dependency`,
        );
        continue;
      }

      if (bare === manifest.name) continue; // self-reference via the package's own exports
      if (declared.has(bare)) continue;

      fail(
        packageName,
        'undeclared-external',
        `${relativePath} imports "${specifier}" but "${bare}" is not in dependencies/peerDependencies`,
      );
    }
  }

  // Gate 5: housekeeping — expected metadata present, no stray source shipped.
  for (const expected of ['README.md', 'LICENSE']) {
    if (!shippedSet.has(expected)) {
      fail(packageName, 'metadata-files', `${expected} is not shipped in the tarball`);
    }
  }
  if (!shippedFiles.some((path) => path.startsWith('dist/'))) {
    fail(packageName, 'dist', 'no dist/ files shipped in the tarball');
  }
  const straySource = shippedFiles.filter(
    (path) => path.startsWith('src/') && path.endsWith('.ts') && !path.endsWith('.d.ts'),
  );
  if (straySource.length > 0) {
    fail(
      packageName,
      'stray-source',
      `${straySource.length} source .ts file(s) shipped (e.g. ${straySource[0]}); publish the built dist only`,
    );
  }
}

// Guarded like `release.ts` and `check-changesets.ts`'s entrypoints: without this, merely
// `import`-ing the module (as the regression test for `collectManifestFileTargets` does) ran this
// CLI block as a side effect and called `process.exit`, before any test in the importing file got
// a chance to run.
if (import.meta.main) {
  const targets = Bun.argv.slice(2);
  if (targets.length === 0) {
    console.error(
      'Usage: bun run scripts/check-package-shape.ts <packageDirectory> [<packageDirectory> ...]',
    );
    process.exit(1);
  }

  for (const packageName of targets) {
    await checkPackage(packageName);
  }

  if (failures.length > 0) {
    console.error(`\n✖ package-shape gate FAILED (${failures.length} issue(s)):\n`);
    for (const { package: pkg, gate, detail } of failures) {
      console.error(`  [${pkg}] ${gate}: ${detail}`);
    }
    process.exit(1);
  }

  console.log(`✓ package-shape gate passed for: ${targets.join(', ')}`);
}
