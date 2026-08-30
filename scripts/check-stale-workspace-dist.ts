/**
 * Workspace dist-staleness guard (AB-151).
 *
 * Bun's workspace linking resolves e.g. `import { Conversation } from 'conversationalist'`
 * inside another package to that package's `dist/`, not `src/`. Turborepo's task graph rebuilds
 * stale dependents for its OWN tasks (`build`/`test`/`check-types`), but nothing stops a plain
 * `bun run <file>.ts` from silently resolving a stale `dist/` that predates the current `src/` —
 * this produced a real false-positive bug report (AB-146, since canceled).
 *
 * Walks every workspace package that has BOTH a `src/` and a `dist/` directory, compares the
 * newest file mtime under each, and exits non-zero naming every package whose `dist/` predates
 * its `src/`. Run this before any ad hoc `bun run <file>.ts` against workspace package code —
 * distinct from the Turborepo-driven `build`/`test`/`check-types` pipeline, which already
 * handles this correctly for its own tasks and does not need this guard.
 *
 * Usage: `bun run scripts/check-stale-workspace-dist.ts` (wired to `bun run check:stale-dist`)
 * Exit code 0 = every checked package's `dist/` is at least as new as its `src/`; 1 = at least
 * one package is stale (fail-closed).
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export type PackageDistStatus = {
  name: string;
  newestSourceMtimeMs: number;
  newestDistMtimeMs: number;
};

/**
 * Pure comparison, no filesystem access: returns the sorted names of every package whose
 * `dist/` predates its `src/`. Unit-testable in isolation from the real filesystem.
 */
export function findStaleDistPackages(packages: readonly PackageDistStatus[]): string[] {
  return packages
    .filter((pkg) => pkg.newestSourceMtimeMs > pkg.newestDistMtimeMs)
    .map((pkg) => pkg.name)
    .sort();
}

/** Newest file mtime (ms since epoch) under `directory`, or `undefined` if it has no files. */
async function newestMtimeMs(directory: string): Promise<number | undefined> {
  const glob = new Bun.Glob('**/*');
  let newest: number | undefined;

  for await (const relativePath of glob.scan({ cwd: directory, onlyFiles: true, dot: true })) {
    const mtime = Bun.file(resolve(directory, relativePath)).lastModified;
    if (newest === undefined || mtime > newest) newest = mtime;
  }

  return newest;
}

async function collectPackageDistStatuses(repositoryRoot: string): Promise<PackageDistStatus[]> {
  const packageManifestGlob = new Bun.Glob('packages/*/package.json');
  const statuses: PackageDistStatus[] = [];

  for await (const packageManifestPath of packageManifestGlob.scan({
    cwd: repositoryRoot,
    onlyFiles: true,
  })) {
    const packageDirectory = resolve(repositoryRoot, packageManifestPath, '..');
    const srcDirectory = resolve(packageDirectory, 'src');
    const distDirectory = resolve(packageDirectory, 'dist');

    // Only packages with BOTH directories participate — one without a `dist/` has nothing
    // published/built yet, and one without a `src/` isn't a source package this guard applies to.
    if (!existsSync(srcDirectory) || !existsSync(distDirectory)) continue;

    const manifest = (await Bun.file(resolve(repositoryRoot, packageManifestPath)).json()) as {
      name: string;
    };

    const [newestSourceMtimeMs, newestDistMtimeMs] = await Promise.all([
      newestMtimeMs(srcDirectory),
      newestMtimeMs(distDirectory),
    ]);

    // Both directories exist (checked above); an empty one has no files to compare, so there's
    // nothing to call stale — skip rather than comparing against `undefined`.
    if (newestSourceMtimeMs === undefined || newestDistMtimeMs === undefined) continue;

    statuses.push({ name: manifest.name, newestSourceMtimeMs, newestDistMtimeMs });
  }

  return statuses;
}

async function checkStaleWorkspaceDist(repositoryRoot: string): Promise<PackageDistStatus[]> {
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
