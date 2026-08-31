/**
 * Workspace dist-staleness guard (AB-151).
 *
 * Bun's workspace linking resolves e.g. `import { Conversation } from 'conversationalist'`
 * inside another package to that package's `dist/`, not `src/`. Turborepo's task graph rebuilds
 * stale dependents for its OWN tasks (`build`/`test`/`check-types`), but nothing stops a plain
 * `bun run <file>.ts` from silently resolving a stale `dist/` that predates the current `src/` —
 * this produced a real false-positive bug report (AB-146, since canceled).
 *
 * Walks every workspace package that has BOTH a `src/` and a `dist/` directory, skipping the
 * colocated `*.test.ts`/`*.test-d.ts` files that this repository keeps inside `src/` — every
 * build config already excludes them and none is a build entry, so editing one can't change an
 * emitted artifact and must not flag the package (see `isBuildIrrelevantSourcePath`). For each
 * package, it
 * resolves the transitive workspace dependency graph (from each package.json's `dependencies`/
 * `devDependencies` entries that name another workspace package — matched by package NAME, since
 * internal deps are a mix of the `workspace:*` protocol and plain semver ranges) and compares the
 * newest `dist/` mtime against the newest `src/` mtime across the package AND all of its
 * transitive workspace dependencies. `armorer` and `conversationalist`, for example, inline
 * `lifecycle` and `interoperability` at build time, so a stale `dist/` for either foundation
 * package must also flag its consumers.
 *
 * Exits non-zero naming every package whose `dist/` predates that combined `src/` (fail-closed).
 *
 * Limitations (honest — this is a fast mtime heuristic, not a proof of freshness):
 *
 * - **Deletions are invisible.** Removing a source file leaves no remaining file with a newer
 *   mtime, so a `dist/` still carrying the deleted module reads as fresh. Detecting this would
 *   mean counting directory mtimes, which was tried and reverted: ordinary test runs create and
 *   delete fixture directories inside `src/`, so it made the guard fail after a plain
 *   `turbo run test` with no source edits at all.
 * - **mtime skew without content change reads as stale.** `touch`ing a file, or a branch switch
 *   that rewrites mtimes, trips the guard even though `dist/` is genuinely current. Turborepo
 *   hashes *content*, so `turbo run build` is a cache hit that leaves `dist/` mtimes untouched
 *   and the guard stays red; `turbo run build --force` is what clears that case.
 *
 * `turbo run build` remains the authority on whether `dist/` is actually current. Treat this as
 * a cheap tripwire for ad hoc scripts, not a replacement for it.
 *
 * Usage: `bun run scripts/check-stale-workspace-dist.ts` (wired to `bun run check:stale-dist`)
 * Exit code 0 = every checked package's `dist/` is at least as new as its (transitive) `src/`;
 * 1 = at least one package is stale.
 */
import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';

export type PackageDistStatus = {
  name: string;
  newestSourceMtimeMs: number;
  newestDistMtimeMs: number;
};

/** Direct workspace dependency names for every workspace package, keyed by package name. */
export type WorkspaceDependencyGraph = ReadonlyMap<string, readonly string[]>;

/**
 * Pure comparison, no filesystem access: returns the sorted names of every package whose
 * `dist/` predates its (already-combined, transitive-inclusive) `src/`. Unit-testable in
 * isolation from the real filesystem.
 */
export function findStaleDistPackages(packages: readonly PackageDistStatus[]): string[] {
  return packages
    .filter((pkg) => pkg.newestSourceMtimeMs > pkg.newestDistMtimeMs)
    .map((pkg) => pkg.name)
    .sort();
}

/**
 * Pure graph traversal, no filesystem access: returns every workspace package name reachable
 * from `packageName` via `graph` (its dependencies, their dependencies, and so on), excluding
 * `packageName` itself. Cycle-safe — a dependency cycle (direct or indirect) is visited at most
 * once per name rather than recursing forever.
 */
export function resolveTransitiveDependencyNames(
  packageName: string,
  graph: WorkspaceDependencyGraph,
): string[] {
  const visited = new Set<string>();
  const stack = [...(graph.get(packageName) ?? [])];

  while (stack.length > 0) {
    const name = stack.pop();
    if (name === undefined || name === packageName || visited.has(name)) continue;

    visited.add(name);
    for (const dependencyName of graph.get(name) ?? []) {
      if (dependencyName !== packageName && !visited.has(dependencyName)) {
        stack.push(dependencyName);
      }
    }
  }

  return [...visited].sort();
}

/**
 * Pure combination, no filesystem access: for every package in `ownSourceMtimesMs`, returns its
 * "effective" newest source mtime — the newest of its own `src/` and every transitive workspace
 * dependency's `src/` (per `graph`). A dependency with no recorded own-source mtime (for example
 * one with no `src/` directory) is skipped rather than treated as `-Infinity`/missing.
 */
export function computeEffectiveSourceMtimes(
  ownSourceMtimesMs: ReadonlyMap<string, number>,
  graph: WorkspaceDependencyGraph,
): Map<string, number> {
  const effective = new Map<string, number>();

  for (const [name, ownMtimeMs] of ownSourceMtimesMs) {
    let newest = ownMtimeMs;

    for (const dependencyName of resolveTransitiveDependencyNames(name, graph)) {
      const dependencyMtimeMs = ownSourceMtimesMs.get(dependencyName);
      if (dependencyMtimeMs !== undefined && dependencyMtimeMs > newest) newest = dependencyMtimeMs;
    }

    effective.set(name, newest);
  }

  return effective;
}

/**
 * Filename suffixes for files that live under `src/` but can never change build output.
 *
 * This mirrors what the builds themselves already ignore rather than inventing a new list:
 * nine of the eleven `packages/*\/tsconfig.build.json` files exclude `**\/*.test.ts` (two of
 * them `**\/*.test-d.ts` as well), and the two that don't — `conversationalist` and
 * `interoperability` — keep their runtime tests in a sibling `test/` directory they also
 * exclude, leaving only conversationalist's two in-`src` `.test-d.ts` type-tests.
 *
 * The structural argument has two halves, and only the first is entry-driven. *Bundling* is:
 * every package emits JavaScript from an explicit entry list (each `tsdown.config.ts`'s `entry`
 * map, skills' `entrypoints` array, interoperability's `bun build ./src/index.ts
 * ./src/embeddings.ts`), no test file is one of those entries, and no source file anywhere in the
 * repository imports a `.test.ts`/`.test-d.ts` module — so a test file cannot be pulled into a
 * bundle transitively either.
 *
 * *Declaration* emit is not entry-driven. Packages that run `tsc --emitDeclarationOnly --project
 * tsconfig.build.json` compile whatever `include` minus `exclude` selects, so a type-test file is
 * only kept out of `dist/` by that config's `exclude`. `packages/skills` previously excluded
 * `**\/*.test.ts` but not `**\/*.test-d.ts` and duly emitted `package-graph.test-d.d.ts`; that
 * exclude is now aligned with the rest of the workspace. Keep them aligned — this suffix list and
 * those `exclude` arrays have to agree for the reasoning above to hold.
 *
 * Deliberately kept to these two suffixes. Excluding more silently weakens the guard, and this
 * is a suffix match on the *file* — never a `src/test/` directory skip, since `src/test/index.ts`
 * is a real published entry for both operative and conversationalist. (A file such as
 * `packages/operative/src/test/durable-engine.test.ts` is still correctly excluded: the suffix
 * matches the filename, not the directory it sits in.)
 */
const BUILD_IRRELEVANT_SOURCE_SUFFIXES = ['.test.ts', '.test-d.ts'] as const;

/**
 * True when `relativePath` names a file the build demonstrably ignores, so its mtime must not
 * count toward a package's `src/` freshness. Exported for direct unit testing.
 */
export function isBuildIrrelevantSourcePath(relativePath: string): boolean {
  return BUILD_IRRELEVANT_SOURCE_SUFFIXES.some((suffix) => relativePath.endsWith(suffix));
}

/**
 * Newest *file* mtime (ms since epoch) under `directory`, or `undefined` if `directory` doesn't
 * exist. Pass `ignore` to skip files whose relative path it accepts — the `src/` scan passes
 * {@link isBuildIrrelevantSourcePath} so ordinary test edits don't read as a stale `dist/`.
 *
 * Directory mtimes are deliberately excluded. Counting them looks appealing — deleting a file
 * bumps its parent directory's mtime, which would make deletions detectable — but it makes the
 * guard fire constantly in normal use: several suites create and delete fixture directories
 * *inside* `src/` while running (for example `packages/gateway/src/server/pages.test.ts` and the
 * evaluation fixtures), so a plain `turbo run test` would leave every dependent package looking
 * stale with zero source edits and a clean `git status`. A tripwire that cries wolf after an
 * ordinary test run is worse than one with a documented blind spot, so deletions stay in the
 * blind spot — see the module-level limitation note.
 */
export async function newestMtimeMs(
  directory: string,
  options: { ignore?: (relativePath: string) => boolean } = {},
): Promise<number | undefined> {
  if (!existsSync(directory)) return undefined;

  const { ignore } = options;
  let newest: number | undefined;

  const glob = new Bun.Glob('**/*');
  for await (const relativePath of glob.scan({ cwd: directory, onlyFiles: true, dot: true })) {
    if (ignore?.(relativePath)) continue;

    const entryStats = await stat(resolve(directory, relativePath)).catch(() => undefined);
    if (entryStats !== undefined && (newest === undefined || entryStats.mtimeMs > newest)) {
      newest = entryStats.mtimeMs;
    }
  }

  return newest;
}

type PackageManifest = {
  name: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

async function collectWorkspacePackages(repositoryRoot: string): Promise<
  {
    name: string;
    directory: string;
    manifestDependencyNames: string[];
  }[]
> {
  const packageManifestGlob = new Bun.Glob('packages/*/package.json');
  const results: { name: string; directory: string; manifestDependencyNames: string[] }[] = [];

  for await (const packageManifestPath of packageManifestGlob.scan({
    cwd: repositoryRoot,
    onlyFiles: true,
  })) {
    const packageDirectory = resolve(repositoryRoot, packageManifestPath, '..');
    const manifest = (await Bun.file(
      resolve(repositoryRoot, packageManifestPath),
    ).json()) as PackageManifest;

    const manifestDependencyNames = Object.keys({
      ...manifest.dependencies,
      ...manifest.devDependencies,
    });

    results.push({ name: manifest.name, directory: packageDirectory, manifestDependencyNames });
  }

  return results;
}

async function collectPackageDistStatuses(repositoryRoot: string): Promise<PackageDistStatus[]> {
  const workspacePackages = await collectWorkspacePackages(repositoryRoot);
  const workspacePackageNames = new Set(workspacePackages.map((pkg) => pkg.name));

  // Resolve internal deps by NAME against the set of workspace package names, not by the
  // `workspace:*` protocol — some internal deps (e.g. armorer/conversationalist's dependency on
  // `interoperability`/`lifecycle`, or operative's on `armorer`/`conversationalist`) are declared
  // with a plain semver range instead.
  const dependencyGraph: WorkspaceDependencyGraph = new Map(
    workspacePackages.map((pkg) => [
      pkg.name,
      pkg.manifestDependencyNames.filter((name) => workspacePackageNames.has(name)),
    ]),
  );

  const ownSourceMtimesMs = new Map<string, number>();
  const ownDistMtimesMs = new Map<string, number>();

  for (const pkg of workspacePackages) {
    const srcDirectory = resolve(pkg.directory, 'src');
    const distDirectory = resolve(pkg.directory, 'dist');

    const [sourceMtimeMs, distMtimeMs] = await Promise.all([
      // Test and type-test files are skipped: they are excluded from every build config and are
      // never a build entry, so editing one cannot make dist/ stale.
      existsSync(srcDirectory)
        ? newestMtimeMs(srcDirectory, { ignore: isBuildIrrelevantSourcePath })
        : undefined,
      existsSync(distDirectory) ? newestMtimeMs(distDirectory) : undefined,
    ]);

    if (sourceMtimeMs !== undefined) ownSourceMtimesMs.set(pkg.name, sourceMtimeMs);
    if (distMtimeMs !== undefined) ownDistMtimesMs.set(pkg.name, distMtimeMs);
  }

  const effectiveSourceMtimesMs = computeEffectiveSourceMtimes(ownSourceMtimesMs, dependencyGraph);

  const statuses: PackageDistStatus[] = [];

  for (const pkg of workspacePackages) {
    // Only packages with BOTH directories participate — one without a `dist/` has nothing
    // published/built yet, and one without a `src/` isn't a source package this guard applies to.
    const newestSourceMtimeMs = effectiveSourceMtimesMs.get(pkg.name);
    const newestDistMtimeMs = ownDistMtimesMs.get(pkg.name);
    if (newestSourceMtimeMs === undefined || newestDistMtimeMs === undefined) continue;

    statuses.push({ name: pkg.name, newestSourceMtimeMs, newestDistMtimeMs });
  }

  return statuses;
}

/**
 * End-to-end check for a repository root: resolves the workspace dependency graph, walks every
 * package's `src/`/`dist/` mtimes (own and transitive), and throws naming every stale package.
 * Exported so tests can exercise the full pipeline against a fixture workspace on disk.
 */
export async function checkStaleWorkspaceDist(
  repositoryRoot: string,
): Promise<PackageDistStatus[]> {
  const statuses = await collectPackageDistStatuses(repositoryRoot);
  const stalePackages = findStaleDistPackages(statuses);

  if (stalePackages.length > 0) {
    throw new Error(
      `dist/ is older than src/ for: ${stalePackages.join(', ')}. Run \`turbo run build\` ` +
        '(or `turbo run build --filter=<package>`) before running an ad hoc script against ' +
        'workspace package code. If that reports FULL TURBO and this check still fails, the ' +
        'skew is mtime-only with unchanged content — Turborepo hashes content, so the cached ' +
        'build leaves dist/ mtimes untouched; `turbo run build --force` clears it.',
    );
  }

  return statuses;
}

if (import.meta.main) {
  try {
    const statuses = await checkStaleWorkspaceDist(resolve(import.meta.dir, '..'));
    console.log(`✓ dist/ is fresh for ${statuses.length} checked workspace package(s).`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`✖ ${message}`);
    process.exit(1);
  }
}
