import { mkdir, mkdtemp, rm, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import {
  checkStaleWorkspaceDist,
  computeEffectiveSourceMtimes,
  findStaleDistPackages,
  isBuildIrrelevantSourcePath,
  newestMtimeMs,
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

describe('isBuildIrrelevantSourcePath', () => {
  test('excludes colocated test files, which every build config already excludes', () => {
    expect(isBuildIrrelevantSourcePath('create-handoff-tool.test.ts')).toBe(true);
    expect(isBuildIrrelevantSourcePath('providers/routing/routing-metrics.test.ts')).toBe(true);
  });

  test('excludes type-test files', () => {
    expect(isBuildIrrelevantSourcePath('public-api.test-d.ts')).toBe(true);
    expect(isBuildIrrelevantSourcePath('bureau-types-no-runtime-values.test-d.ts')).toBe(true);
  });

  test('keeps ordinary source files, including ones whose name merely contains "test"', () => {
    expect(isBuildIrrelevantSourcePath('index.ts')).toBe(false);
    expect(isBuildIrrelevantSourcePath('create-handoff-tool.ts')).toBe(false);
    expect(isBuildIrrelevantSourcePath('latest.ts')).toBe(false);
    expect(isBuildIrrelevantSourcePath('test-helpers.ts')).toBe(false);
  });

  test('keeps a src/test/ entry module — the directory is a real published build entry', () => {
    // operative and conversationalist both ship `./src/test/index.ts` as a build entry, so the
    // exclusion must match the FILE suffix and never skip the `test/` directory wholesale.
    expect(isBuildIrrelevantSourcePath('test/index.ts')).toBe(false);
    expect(isBuildIrrelevantSourcePath('test/store.ts')).toBe(false);
    // ...but a test file that happens to live inside it is still excluded.
    expect(isBuildIrrelevantSourcePath('test/durable-engine.test.ts')).toBe(true);
  });

  test('keeps non-TypeScript files and other build inputs', () => {
    expect(isBuildIrrelevantSourcePath('schema.json')).toBe(false);
    expect(isBuildIrrelevantSourcePath('ui/styles.css')).toBe(false);
  });
});

describe('newestMtimeMs', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'newest-mtime-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test('returns undefined for a directory that does not exist', async () => {
    expect(await newestMtimeMs(join(root, 'missing'))).toBeUndefined();
  });

  test('ignores files the predicate rejects, even when they are the newest on disk', async () => {
    const t0 = Date.UTC(2024, 0, 1);

    await writeFile(join(root, 'index.ts'), 'export const a = 1;');
    await setMtime(join(root, 'index.ts'), t0);

    await writeFile(join(root, 'index.test.ts'), 'test("a", () => {});');
    await setMtime(join(root, 'index.test.ts'), t0 + 60_000);

    // Without the filter the newest file is the test; with it, the source file wins.
    expect(await newestMtimeMs(root)).toBe(t0 + 60_000);
    expect(await newestMtimeMs(root, { ignore: isBuildIrrelevantSourcePath })).toBe(t0);
  });

  test('returns undefined when every file in the directory is ignored', async () => {
    await writeFile(join(root, 'only.test.ts'), 'test("a", () => {});');
    await setMtime(join(root, 'only.test.ts'), Date.UTC(2024, 0, 1));

    expect(await newestMtimeMs(root, { ignore: isBuildIrrelevantSourcePath })).toBeUndefined();
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

  test('editing a colocated test file does not flag the package or its consumers', async () => {
    const t0 = Date.UTC(2024, 0, 1);

    const dependency = await makeFixturePackage(root, 'dependency');
    await setMtime(join(dependency.srcDirectory, 'index.ts'), t0);
    await setMtime(join(dependency.distDirectory, 'index.js'), t0 + 1000);

    const consumer = await makeFixturePackage(root, 'consumer', {
      dependencies: { dependency: '0.0.1' },
    });
    await setMtime(join(consumer.srcDirectory, 'index.ts'), t0);
    await setMtime(join(consumer.distDirectory, 'index.js'), t0 + 1000);

    // A colocated test edited long after both dist/ directories — the AB-151 false positive.
    await writeFile(join(dependency.srcDirectory, 'index.test.ts'), 'test("a", () => {});');
    await setMtime(join(dependency.srcDirectory, 'index.test.ts'), t0 + 900_000);

    // A test file is not a build input, so nothing is stale.
    const statuses = await checkStaleWorkspaceDist(root);
    expect(statuses.map((status) => status.name).sort()).toEqual(['consumer', 'dependency']);
  });

  test('editing a real source file still flags the package and its consumers', async () => {
    const t0 = Date.UTC(2024, 0, 1);

    const dependency = await makeFixturePackage(root, 'dependency');
    await setMtime(join(dependency.srcDirectory, 'index.ts'), t0);
    await setMtime(join(dependency.distDirectory, 'index.js'), t0 + 1000);

    const consumer = await makeFixturePackage(root, 'consumer', {
      dependencies: { dependency: '0.0.1' },
    });
    await setMtime(join(consumer.srcDirectory, 'index.ts'), t0);
    await setMtime(join(consumer.distDirectory, 'index.js'), t0 + 1000);

    // Same timing as the test above, but on a real build input — the guard must still fire.
    await setMtime(join(dependency.srcDirectory, 'index.ts'), t0 + 900_000);

    await expect(checkStaleWorkspaceDist(root)).rejects.toThrow(
      /^dist\/ is older than src\/ for: consumer, dependency\./,
    );
  });

  test('a src/test/ entry module is a build input and still flags the package', async () => {
    const t0 = Date.UTC(2024, 0, 1);

    const pkg = await makeFixturePackage(root, 'has-test-entry');
    await setMtime(join(pkg.srcDirectory, 'index.ts'), t0);
    await setMtime(join(pkg.distDirectory, 'index.js'), t0 + 1000);

    // `src/test/index.ts` is a published entry for operative and conversationalist, so an edit
    // there must NOT be swallowed by the exclusion.
    await mkdir(join(pkg.srcDirectory, 'test'), { recursive: true });
    await writeFile(join(pkg.srcDirectory, 'test', 'index.ts'), 'export const helper = 1;');
    await setMtime(join(pkg.srcDirectory, 'test', 'index.ts'), t0 + 900_000);

    await expect(checkStaleWorkspaceDist(root)).rejects.toThrow(
      /^dist\/ is older than src\/ for: has-test-entry\./,
    );
  });
});
