/**
 * Package-shape gate for the publishable packages (`armorer`, `conversationalist`).
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
 *   4. No `package.json` lifecycle script (`prepack`/`prepare`/`prepublishOnly`/`publish`/
 *      `postpack`/`postpublish`) can mutate the publish payload — so the bytes `npm pack` validated
 *      are the bytes `npm publish` ships.
 *   5. Expected `README`/`LICENSE`/`dist` present; no source `.ts` accidentally shipped.
 *
 * The import scan strips comments first and matches only real module specifiers, avoiding the
 * false-positive classes observed during the tsdown migration: tsdown `//#region` markers, object
 * properties named like a package, JSDoc `@example` imports, and bare Node builtins (`url`).
 *
 * Usage: `bun run scripts/check-package-shape.ts <packageName> [<packageName> ...]`
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

type PackageManifest = {
  name: string;
  version: string;
  main?: string;
  module?: string;
  types?: string;
  bin?: string | Record<string, string>;
  typesVersions?: Record<string, Record<string, string[]>>;
  exports?: Record<string, Record<string, string> | string>;
  dependencies?: Record<string, string>;
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

function collectManifestFileTargets(manifest: PackageManifest): string[] {
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
    if (typeof condition === 'string') push(condition);
    else for (const value of Object.values(condition)) push(value);
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
  const shippedFiles = await listFiles(packageRoot);
  const shippedSet = new Set(shippedFiles);

  // Gate 1: every file-referencing manifest field resolves inside the tarball.
  for (const target of collectManifestFileTargets(manifest)) {
    const normalized = target.replace(/^\.\//, '');
    if (!shippedSet.has(normalized)) {
      fail(
        packageName,
        'manifest-target',
        `${target} is referenced in package.json but not shipped in the tarball`,
      );
    }
  }

  // Gates 2 + 3: import audit over shipped code only.
  const declared = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
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

const targets = Bun.argv.slice(2);
if (targets.length === 0) {
  console.error('Usage: bun run scripts/check-package-shape.ts <packageName> [<packageName> ...]');
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
