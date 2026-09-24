import { describe, expect, test } from 'bun:test';

import { collectManifestFileTargets, type PackageManifest } from './check-package-shape';

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
      new Set([
        './dist/index.js',
        './dist/index.d.ts',
        './dist/index.d.cts',
        './dist/index.cjs',
      ]),
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
