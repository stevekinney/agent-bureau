/**
 * Workspace dist-staleness guard (AB-151).
 *
 * Bun's workspace linking resolves e.g. `import { Conversation } from 'conversationalist'`
 * inside another package to that package's `dist/`, not `src/`. Turborepo's task graph rebuilds
 * stale dependents for its OWN tasks (`build`/`test`/`check-types`), but nothing stops a plain
 * `bun run <file>.ts` from silently resolving a stale `dist/` that predates the current `src/` —
 * this produced a real false-positive bug report (AB-146, since canceled).
 *
 * Walks every workspace package that has BOTH a `src/` and a `dist/` directory. For each one, it
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
 * Limitation (honest, not fixable within this guard's design): this is a fast mtime heuristic,
 * not a proof of freshness. It walks directory mtimes as well as file mtimes, which catches the
 * common case of a deleted source file (removing a file bumps its parent directory's mtime on
 * macOS and Linux) — but it can still miss a deletion on a filesystem that doesn't update
 * directory mtimes on unlink, and it has no way to detect a change that doesn't touch mtime at
 * all (e.g. a file rewritten with `utimes` preserved, or a content change on a filesystem with
 * coarse mtime resolution). `turbo run build` remains the authority on whether `dist/` is
 * actually current — treat this guard as a cheap tripwire for ad hoc scripts, not a replacement
 * for it.
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
 * Newest mtime (ms since epoch) under `directory`, across both files and directories, or
 * `undefined` if `directory` doesn't exist. Including directory mtimes (not just file mtimes)
 * means deleting a source file is detectable: removing a file bumps its parent directory's
 * mtime on macOS and Linux, even though no remaining file gets a newer mtime of its own. This is
 * a heuristic, not a guarantee — see the module-level limitation note above.
 */
export async function newestMtimeMs(directory: string): Promise<number | undefined> {
  const rootStats = await stat(directory).catch(() => undefined);
  if (rootStats === undefined) return undefined;

  let newest = rootStats.mtimeMs;

  const glob = new Bun.Glob('**/*');
  for await (const relativePath of glob.scan({ cwd: directory, onlyFiles: false, dot: true })) {
    const entryStats = await stat(resolve(directory, relativePath)).catch(() => undefined);
    if (entryStats !== undefined && entryStats.mtimeMs > newest) newest = entryStats.mtimeMs;
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
      existsSync(srcDirectory) ? newestMtimeMs(srcDirectory) : undefined,
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
        'workspace package code.',
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
