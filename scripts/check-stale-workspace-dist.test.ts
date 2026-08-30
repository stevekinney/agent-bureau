import { mkdir, mkdtemp, rm, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import {
  checkStaleWorkspaceDist,
  computeEffectiveSourceMtimes,
  findStaleDistPackages,
  resolveTransitiveDependencyNames,
  type WorkspaceDependencyGraph,
} from './check-stale-workspace-dist';

describe('findStaleDistPackages', () => {
  test('returns an empty array when every package is at least as new as its dist/', () => {
    const stale = findStaleDistPackages([
      { name: 'armorer', newestSourceMtimeMs: 100, newestDistMtimeMs: 200 },
      { name: 'conversationalist', newestSourceMtimeMs: 100, newestDistMtimeMs: 100 },
    ]);

    expect(stale).toEqual([]);
  });

  test('names a package whose dist/ predates its src/', () => {
    const stale = findStaleDistPackages([
      { name: 'conversationalist', newestSourceMtimeMs: 200, newestDistMtimeMs: 100 },
    ]);

    expect(stale).toEqual(['conversationalist']);
  });

  test('names every stale package, sorted, and omits fresh ones', () => {
    const stale = findStaleDistPackages([
      { name: '@lostgradient/operative', newestSourceMtimeMs: 300, newestDistMtimeMs: 100 },
      { name: 'armorer', newestSourceMtimeMs: 100, newestDistMtimeMs: 200 },
      { name: 'conversationalist', newestSourceMtimeMs: 200, newestDistMtimeMs: 100 },
    ]);

    expect(stale).toEqual(['@lostgradient/operative', 'conversationalist']);
  });

  test('returns an empty array for an empty input', () => {
    expect(findStaleDistPackages([])).toEqual([]);
  });

  test('treats an exactly-equal mtime as fresh, not stale', () => {
    const stale = findStaleDistPackages([
      { name: 'armorer', newestSourceMtimeMs: 100, newestDistMtimeMs: 100 },
    ]);

    expect(stale).toEqual([]);
  });
});

describe('resolveTransitiveDependencyNames', () => {
  test('returns an empty array for a package with no workspace dependencies', () => {
    const graph: WorkspaceDependencyGraph = new Map([['lifecycle', []]]);

    expect(resolveTransitiveDependencyNames('lifecycle', graph)).toEqual([]);
  });

  test('returns an empty array for a package name absent from the graph', () => {
    const graph: WorkspaceDependencyGraph = new Map();

    expect(resolveTransitiveDependencyNames('unknown', graph)).toEqual([]);
  });

  test('resolves a multi-hop transitive chain, not just direct dependencies', () => {
    // operative -> armorer -> lifecycle
    const graph: WorkspaceDependencyGraph = new Map([
      ['operative', ['armorer']],
      ['armorer', ['lifecycle']],
      ['lifecycle', []],
    ]);

    expect(resolveTransitiveDependencyNames('operative', graph)).toEqual(['armorer', 'lifecycle']);
  });

  test('deduplicates a diamond dependency reached through two paths', () => {
    // gateway -> armorer -> lifecycle
    // gateway -> conversationalist -> lifecycle
    const graph: WorkspaceDependencyGraph = new Map([
      ['gateway', ['armorer', 'conversationalist']],
      ['armorer', ['lifecycle']],
      ['conversationalist', ['lifecycle']],
      ['lifecycle', []],
    ]);

    expect(resolveTransitiveDependencyNames('gateway', graph)).toEqual([
      'armorer',
      'conversationalist',
      'lifecycle',
    ]);
  });

  test('terminates on a dependency cycle instead of recursing forever', () => {
    const graph: WorkspaceDependencyGraph = new Map([
      ['a', ['b']],
      ['b', ['a']],
    ]);

    expect(resolveTransitiveDependencyNames('a', graph)).toEqual(['b']);
    expect(resolveTransitiveDependencyNames('b', graph)).toEqual(['a']);
  });

  test('terminates on a longer indirect cycle', () => {
    const graph: WorkspaceDependencyGraph = new Map([
      ['a', ['b']],
      ['b', ['c']],
      ['c', ['a']],
    ]);

    expect(resolveTransitiveDependencyNames('a', graph)).toEqual(['b', 'c']);
  });
});

describe('computeEffectiveSourceMtimes', () => {
  test('a package with no workspace dependencies keeps its own mtime', () => {
    const graph: WorkspaceDependencyGraph = new Map([['lifecycle', []]]);
    const own = new Map([['lifecycle', 100]]);

    expect(computeEffectiveSourceMtimes(own, graph)).toEqual(new Map([['lifecycle', 100]]));
  });

  test('a consumer picks up a transitive dependency mtime newer than its own', () => {
    // conversationalist inlines lifecycle; lifecycle's src/ was touched after
    // conversationalist's own src/, so conversationalist must be treated as effectively
    // that new, even though nothing under conversationalist/src/ itself changed.
    const graph: WorkspaceDependencyGraph = new Map([
      ['conversationalist', ['lifecycle']],
      ['lifecycle', []],
    ]);
    const own = new Map([
      ['conversationalist', 100],
      ['lifecycle', 500],
    ]);

    expect(computeEffectiveSourceMtimes(own, graph)).toEqual(
      new Map([
        ['conversationalist', 500],
        ['lifecycle', 500],
      ]),
    );
  });

  test('ignores a transitive dependency mtime older than the consumer own mtime', () => {
    const graph: WorkspaceDependencyGraph = new Map([
      ['conversationalist', ['lifecycle']],
      ['lifecycle', []],
    ]);
    const own = new Map([
      ['conversationalist', 500],
      ['lifecycle', 100],
    ]);

    expect(computeEffectiveSourceMtimes(own, graph)).toEqual(
      new Map([
        ['conversationalist', 500],
        ['lifecycle', 100],
      ]),
    );
  });

  test('is cycle-safe and still produces the correct combined maximum', () => {
    const graph: WorkspaceDependencyGraph = new Map([
      ['a', ['b']],
      ['b', ['a']],
    ]);
    const own = new Map([
      ['a', 100],
      ['b', 900],
    ]);

    expect(computeEffectiveSourceMtimes(own, graph)).toEqual(
      new Map([
        ['a', 900],
        ['b', 900],
      ]),
    );
  });

  test('skips a dependency with no recorded own mtime rather than treating it as missing', () => {
    const graph: WorkspaceDependencyGraph = new Map([['consumer', ['no-src-package']]]);
    const own = new Map([['consumer', 100]]);

    expect(computeEffectiveSourceMtimes(own, graph)).toEqual(new Map([['consumer', 100]]));
  });
});

/** Builds a minimal fixture workspace package under `root/packages/<name>`. */
async function makeFixturePackage(
  root: string,
  name: string,
  options: { dependencies?: Record<string, string>; withDist?: boolean } = {},
): Promise<{ srcDirectory: string; distDirectory: string }> {
  const packageDirectory = join(root, 'packages', name);
  const srcDirectory = join(packageDirectory, 'src');
  const distDirectory = join(packageDirectory, 'dist');

  await mkdir(srcDirectory, { recursive: true });
  await writeFile(
    join(packageDirectory, 'package.json'),
    JSON.stringify({ name, dependencies: options.dependencies ?? {} }),
  );
  await writeFile(join(srcDirectory, 'index.ts'), `export const name = ${JSON.stringify(name)};`);

  if (options.withDist !== false) {
    await mkdir(distDirectory, { recursive: true });
    await writeFile(join(distDirectory, 'index.js'), `exports.name = ${JSON.stringify(name)};`);
  }

  return { srcDirectory, distDirectory };
}

/** Sets both the atime and mtime of `path` to `epochMs`. */
async function setMtime(path: string, epochMs: number): Promise<void> {
  const seconds = epochMs / 1000;
  await utimes(path, seconds, seconds);
}

describe('checkStaleWorkspaceDist (fixture end-to-end)', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'stale-dist-fixture-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test('reports nothing stale when every dist/ postdates its own src/', async () => {
    const t0 = Date.UTC(2024, 0, 1);
    const dependency = await makeFixturePackage(root, 'dependency');
    await setMtime(join(dependency.srcDirectory, 'index.ts'), t0);
    await setMtime(dependency.srcDirectory, t0);
    await setMtime(join(dependency.distDirectory, 'index.js'), t0 + 1000);
    await setMtime(dependency.distDirectory, t0 + 1000);

    const statuses = await checkStaleWorkspaceDist(root);

    expect(statuses.map((status) => status.name).sort()).toEqual(['dependency']);
  });

  test('flags a consumer as stale only because a transitive dependency src/ is newer', async () => {
    const t0 = Date.UTC(2024, 0, 1);

    const dependency = await makeFixturePackage(root, 'dependency');
    await setMtime(join(dependency.srcDirectory, 'index.ts'), t0);
    await setMtime(dependency.srcDirectory, t0);
    await setMtime(join(dependency.distDirectory, 'index.js'), t0 + 1000);
    await setMtime(dependency.distDirectory, t0 + 1000);

    // Consumer's own src/dist are both fresh relative to each other...
    const consumer = await makeFixturePackage(root, 'consumer', {
      dependencies: { dependency: '0.0.1' },
    });
    await setMtime(join(consumer.srcDirectory, 'index.ts'), t0);
    await setMtime(consumer.srcDirectory, t0);
    await setMtime(join(consumer.distDirectory, 'index.js'), t0 + 1000);
    await setMtime(consumer.distDirectory, t0 + 1000);

    // ...but the dependency's src/ is rebuilt (touched) after both dist/ directories.
    await setMtime(join(dependency.srcDirectory, 'index.ts'), t0 + 5000);
    await setMtime(dependency.srcDirectory, t0 + 5000);

    await expect(checkStaleWorkspaceDist(root)).rejects.toThrow(
      /^dist\/ is older than src\/ for: consumer, dependency\./,
    );
  });

  test('a package with no workspace dependencies is unaffected by an unrelated stale package', async () => {
    const t0 = Date.UTC(2024, 0, 1);

    const isolated = await makeFixturePackage(root, 'isolated');
    await setMtime(join(isolated.srcDirectory, 'index.ts'), t0);
    await setMtime(isolated.srcDirectory, t0);
    await setMtime(join(isolated.distDirectory, 'index.js'), t0 + 1000);
    await setMtime(isolated.distDirectory, t0 + 1000);

    const stale = await makeFixturePackage(root, 'stale');
    await setMtime(join(stale.srcDirectory, 'index.ts'), t0 + 5000);
    await setMtime(stale.srcDirectory, t0 + 5000);
    await setMtime(join(stale.distDirectory, 'index.js'), t0);
    await setMtime(stale.distDirectory, t0);

    await expect(checkStaleWorkspaceDist(root)).rejects.toThrow(
      /^dist\/ is older than src\/ for: stale\./,
    );
  });

  test('does not hang on a dependency cycle and still detects staleness through it', async () => {
    const t0 = Date.UTC(2024, 0, 1);

    const a = await makeFixturePackage(root, 'cycle-a', { dependencies: { 'cycle-b': '0.0.1' } });
    const b = await makeFixturePackage(root, 'cycle-b', { dependencies: { 'cycle-a': '0.0.1' } });

    await setMtime(join(a.srcDirectory, 'index.ts'), t0);
    await setMtime(a.srcDirectory, t0);
    await setMtime(join(a.distDirectory, 'index.js'), t0 + 1000);
    await setMtime(a.distDirectory, t0 + 1000);

    await setMtime(join(b.srcDirectory, 'index.ts'), t0);
    await setMtime(b.srcDirectory, t0);
    await setMtime(join(b.distDirectory, 'index.js'), t0 + 1000);
    await setMtime(b.distDirectory, t0 + 1000);

    // Touch cycle-a's src/ after both dist/ directories; because of the cycle, cycle-b's
    // effective source mtime must also pick this up.
    await setMtime(join(a.srcDirectory, 'index.ts'), t0 + 5000);
    await setMtime(a.srcDirectory, t0 + 5000);

    await expect(checkStaleWorkspaceDist(root)).rejects.toThrow(
      /^dist\/ is older than src\/ for: cycle-a, cycle-b\./,
    );
  });

  test('reports a package stale when a source file is deleted after its dist/ was built', async () => {
    const t0 = Date.UTC(2024, 0, 1);

    const pkg = await makeFixturePackage(root, 'deletion-target');
    const extraFile = join(pkg.srcDirectory, 'extra.ts');
    await writeFile(extraFile, 'export const extra = true;');
    await setMtime(extraFile, t0);
    await setMtime(join(pkg.srcDirectory, 'index.ts'), t0);
    await setMtime(pkg.srcDirectory, t0);
    await setMtime(join(pkg.distDirectory, 'index.js'), t0 + 1000);
    await setMtime(pkg.distDirectory, t0 + 1000);

    // Precondition: with both source files intact and predating dist/, nothing is stale yet.
    const beforeDeletion = await checkStaleWorkspaceDist(root);
    expect(beforeDeletion.map((status) => status.name)).toEqual(['deletion-target']);

    // Deleting extra.ts (real deletion, no manual mtime set on the directory) bumps
    // src/'s own mtime to "now" — after dist/'s mtime — even though the remaining
    // index.ts file's own mtime is untouched.
    await unlink(extraFile);

    await expect(checkStaleWorkspaceDist(root)).rejects.toThrow(
      /^dist\/ is older than src\/ for: deletion-target\./,
    );
  });
});
