import { describe, expect, test } from 'bun:test';

import {
  collectManifestFileTargets,
  findDependencySpecifierErrors,
  type PackageManifest,
} from './check-package-shape';

describe('collectManifestFileTargets', () => {
  test('recurses into nested import/require condition objects (the tsdown dual-package shape)', () => {
    // Matches the real shape emitted for armorer, tool-protocol, cryptography, embeddings, and
    // lifecycle: `Object.values()` over `manifest.exports['.']` yields `import`/`require`, whose
    // values are themselves condition objects, not strings. A single-level `Object.values` pass
    // previously called `.startsWith` on those nested objects and crashed with a `TypeError`.
    const manifest: PackageManifest = {
      name: '@lostgradient/tool-protocol',
      version: '0.0.0',
      exports: {
        '.': {
          bun: './dist/index.js',
          browser: './dist/index.js',
          import: {
            types: './dist/index.d.ts',
            default: './dist/index.js',
          },
          require: {
            types: './dist/index.d.cts',
            default: './dist/index.cjs',
          },
          default: './dist/index.js',
        },
      },
    };

    expect(new Set(collectManifestFileTargets(manifest))).toEqual(
      new Set(['./dist/index.js', './dist/index.d.ts', './dist/index.d.cts', './dist/index.cjs']),
    );
  });

  test('skips an explicitly blocked subpath (a `null` condition, as conversationalist uses for `browser`)', () => {
    const manifest: PackageManifest = {
      name: 'conversationalist',
      version: '1.2.0',
      exports: {
        './markdown': {
          types: './dist/markdown/index.d.ts',
          browser: null,
          import: './dist/markdown/index.js',
          default: './dist/markdown/index.js',
        },
      },
    };

    expect(new Set(collectManifestFileTargets(manifest))).toEqual(
      new Set(['./dist/markdown/index.d.ts', './dist/markdown/index.js']),
    );
  });

  test('walks an array of fallback targets inside a condition', () => {
    const manifest: PackageManifest = {
      name: 'fixture',
      version: '0.0.0',
      exports: {
        '.': {
          import: ['./dist/preferred.js', './dist/fallback.js'],
        },
      },
    };

    expect(new Set(collectManifestFileTargets(manifest))).toEqual(
      new Set(['./dist/preferred.js', './dist/fallback.js']),
    );
  });

  test('still collects top-level main/module/types and string-only exports', () => {
    const manifest: PackageManifest = {
      name: 'fixture',
      version: '0.0.0',
      main: './dist/index.cjs',
      module: './dist/index.js',
      types: './dist/index.d.ts',
      bin: './dist/cli.js',
      exports: {
        '.': './dist/index.js',
      },
    };

    expect(new Set(collectManifestFileTargets(manifest))).toEqual(
      new Set(['./dist/index.cjs', './dist/index.js', './dist/index.d.ts', './dist/cli.js']),
    );
  });
});

describe('findDependencySpecifierErrors', () => {
  // A registry check that fails the test if it's ever called with a name that isn't the one this
  // test explicitly whitelisted -- proves an ordinary external dependency, or one already settled
  // by knownGoodVersions, never triggers a network call.
  function registryCheckExpecting(
    expected: Record<string, string>,
    result: boolean,
  ): (name: string, version: string) => Promise<boolean> {
    return async (name, version) => {
      if (expected[name] !== version) {
        throw new Error(`unexpected registry check for ${name}@${version}`);
      }
      return result;
    };
  }

  const neverCalled = registryCheckExpecting({}, false);

  test('checks the version a rewritten `workspace:^` or `workspace:~` range names', async () => {
    const manifest: PackageManifest = {
      name: '@lostgradient/operative',
      version: '0.12.1',
      dependencies: { armorer: '^2.4.0', conversationalist: '~1.3.0' },
    };

    const errors = await findDependencySpecifierErrors(manifest, {
      workspaceNames: new Set(['armorer', 'conversationalist']),
      knownGoodVersions: new Map([['conversationalist', '1.3.0']]),
      registryHasVersion: registryCheckExpecting({ armorer: '2.4.0' }, true),
    });

    expect(errors).toEqual([]);
  });

  test('flags a `workspace:*` dependency -- this is "today\'s path" before any rewrite runs, reproduced directly against a fixture shaped like tool-protocol\'s real dependency on lifecycle', async () => {
    const manifest: PackageManifest = {
      name: '@lostgradient/tool-protocol',
      version: '0.0.0',
      dependencies: { '@lostgradient/lifecycle': 'workspace:*' },
    };

    const errors = await findDependencySpecifierErrors(manifest, {
      workspaceNames: new Set(['@lostgradient/lifecycle']),
      knownGoodVersions: new Map(),
      registryHasVersion: neverCalled,
    });

    expect(errors).toEqual([
      {
        section: 'dependencies',
        dependencyName: '@lostgradient/lifecycle',
        versionRange: 'workspace:*',
        reason: 'workspace-or-catalog-protocol',
      },
    ]);
  });

  test('flags a `catalog:` dependency the same way', async () => {
    const manifest: PackageManifest = {
      name: 'fixture',
      version: '0.0.0',
      dependencies: { zod: 'catalog:' },
    };

    const errors = await findDependencySpecifierErrors(manifest, {
      workspaceNames: new Set(),
      knownGoodVersions: new Map(),
      registryHasVersion: neverCalled,
    });

    expect(errors).toEqual([
      {
        section: 'dependencies',
        dependencyName: 'zod',
        versionRange: 'catalog:',
        reason: 'workspace-or-catalog-protocol',
      },
    ]);
  });

  test('flags a concrete-version dependency on a workspace package that is neither known-good nor on the registry -- the check this class of bug needed', async () => {
    const manifest: PackageManifest = {
      name: 'conversationalist',
      version: '1.3.0',
      dependencies: {
        '@lostgradient/lifecycle': '0.0.1',
        '@lostgradient/tool-protocol': '0.0.0',
      },
    };

    const errors = await findDependencySpecifierErrors(manifest, {
      workspaceNames: new Set(['@lostgradient/lifecycle', '@lostgradient/tool-protocol']),
      knownGoodVersions: new Map(), // simulates a run where neither has actually published yet
      registryHasVersion: registryCheckExpecting(
        { '@lostgradient/lifecycle': '0.0.1', '@lostgradient/tool-protocol': '0.0.0' },
        false,
      ),
    });

    expect(errors).toEqual([
      {
        section: 'dependencies',
        dependencyName: '@lostgradient/lifecycle',
        versionRange: '0.0.1',
        reason: 'unpublished-internal-version',
      },
      {
        section: 'dependencies',
        dependencyName: '@lostgradient/tool-protocol',
        versionRange: '0.0.0',
        reason: 'unpublished-internal-version',
      },
    ]);
  });

  test('accepts a concrete-version dependency confirmed by knownGoodVersions, with no registry call', async () => {
    const manifest: PackageManifest = {
      name: '@lostgradient/tool-protocol',
      version: '0.0.0',
      dependencies: { '@lostgradient/lifecycle': '0.0.1' },
    };

    const errors = await findDependencySpecifierErrors(manifest, {
      workspaceNames: new Set(['@lostgradient/lifecycle']),
      knownGoodVersions: new Map([['@lostgradient/lifecycle', '0.0.1']]),
      registryHasVersion: neverCalled, // must not be reached: knownGoodVersions already settles it
    });

    expect(errors).toEqual([]);
  });

  test('accepts a concrete-version dependency confirmed by a live registry check', async () => {
    const manifest: PackageManifest = {
      name: '@lostgradient/operative',
      version: '0.12.0',
      dependencies: { armorer: '2.4.0' },
    };

    const errors = await findDependencySpecifierErrors(manifest, {
      workspaceNames: new Set(['armorer']),
      knownGoodVersions: new Map(),
      registryHasVersion: registryCheckExpecting({ armorer: '2.4.0' }, true),
    });

    expect(errors).toEqual([]);
  });

  test('never checks an ordinary external dependency, even at an arbitrary version', async () => {
    const manifest: PackageManifest = {
      name: 'fixture',
      version: '0.0.0',
      dependencies: { zod: '^4.4.3' },
      peerDependencies: { '@anthropic-ai/sdk': '>=0.50.0' },
    };

    const errors = await findDependencySpecifierErrors(manifest, {
      workspaceNames: new Set(['@lostgradient/lifecycle']), // neither zod nor the SDK is in this set
      knownGoodVersions: new Map(),
      registryHasVersion: neverCalled,
    });

    expect(errors).toEqual([]);
  });
});
