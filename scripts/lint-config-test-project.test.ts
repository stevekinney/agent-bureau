/**
 * Unit-tests `resolveTestTsconfigProject` (AB-368) and the AB-383 fix around it:
 * `listWorkspacePackageDirectories` and `buildPerPackageTestTypeCheckedBlocks`, which generate one
 * type-checked `test/**` config block per workspace package instead of resolving a single shared
 * block against `process.cwd()`. Uses real temporary directories rather than mocking `node:fs`,
 * per this repo's "Testing Pattern: Factory Functions and Mock Injection" convention (no module
 * mocking).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'bun:test';
import { ESLint } from 'eslint';

import {
  baseConfig,
  buildPerPackageTestTypeCheckedBlocks,
  listWorkspacePackageDirectories,
  resolveTestTsconfigProject,
  testOverrides,
} from '../eslint.config.base.ts';

describe('resolveTestTsconfigProject', () => {
  let packageRoot: string | undefined;

  afterEach(() => {
    if (packageRoot) {
      rmSync(packageRoot, { recursive: true, force: true });
      packageRoot = undefined;
    }
  });

  it('resolves to tsconfig.test.json when the package has one', () => {
    packageRoot = mkdtempSync(join(tmpdir(), 'ab-368-with-test-tsconfig-'));
    writeFileSync(join(packageRoot, 'tsconfig.json'), '{}');
    writeFileSync(join(packageRoot, 'tsconfig.test.json'), '{}');

    expect(resolveTestTsconfigProject(packageRoot)).toBe('./tsconfig.test.json');
  });

  it('falls back to tsconfig.json when the package has no tsconfig.test.json', () => {
    packageRoot = mkdtempSync(join(tmpdir(), 'ab-368-without-test-tsconfig-'));
    writeFileSync(join(packageRoot, 'tsconfig.json'), '{}');

    expect(resolveTestTsconfigProject(packageRoot)).toBe('./tsconfig.json');
  });

  it('falls back to tsconfig.json when the package directory has neither file', () => {
    packageRoot = mkdtempSync(join(tmpdir(), 'ab-368-empty-'));

    expect(resolveTestTsconfigProject(packageRoot)).toBe('./tsconfig.json');
  });
});

/** Builds `<repoRoot>/packages/<name>` (and `<repoRoot>/packages` itself) and returns its path. */
function makeFakePackage(repoRoot: string, name: string): string {
  const packageDirectory = join(repoRoot, 'packages', name);
  mkdirSync(packageDirectory, { recursive: true });
  return packageDirectory;
}

describe('listWorkspacePackageDirectories', () => {
  let repoRoot: string | undefined;

  afterEach(() => {
    if (repoRoot) {
      rmSync(repoRoot, { recursive: true, force: true });
      repoRoot = undefined;
    }
  });

  it('returns only directories under packages/ that have their own package.json', () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'ab-383-workspace-'));
    const realPackage = makeFakePackage(repoRoot, 'real-package');
    writeFileSync(join(realPackage, 'package.json'), '{}');

    makeFakePackage(repoRoot, 'no-package-json');

    // A plain file directly under packages/ (not a directory) must not be treated as a package.
    writeFileSync(join(repoRoot, 'packages', 'README.md'), 'not a package');

    expect(listWorkspacePackageDirectories(repoRoot)).toEqual([realPackage]);
  });
});

describe('buildPerPackageTestTypeCheckedBlocks', () => {
  let repoRoot: string | undefined;

  afterEach(() => {
    if (repoRoot) {
      rmSync(repoRoot, { recursive: true, force: true });
      repoRoot = undefined;
    }
  });

  it('scopes each block to its own package via basePath, files, project, and tsconfigRootDir', () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'ab-383-blocks-with-test-tsconfig-'));
    const packageDirectory = makeFakePackage(repoRoot, 'with-test-tsconfig');
    writeFileSync(join(packageDirectory, 'package.json'), '{}');
    writeFileSync(join(packageDirectory, 'tsconfig.json'), '{}');
    writeFileSync(join(packageDirectory, 'tsconfig.test.json'), '{}');

    const blocks = buildPerPackageTestTypeCheckedBlocks(repoRoot);

    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      expect(block.basePath).toBe(packageDirectory);
      expect(block.files).toEqual(['test/**/*.{ts,tsx}']);
      expect(block.languageOptions?.parserOptions).toEqual({
        project: ['./tsconfig.test.json'],
        tsconfigRootDir: packageDirectory,
      });
    }
  });

  it('falls back to tsconfig.json when the package has no tsconfig.test.json', () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'ab-383-blocks-without-test-tsconfig-'));
    const packageDirectory = makeFakePackage(repoRoot, 'without-test-tsconfig');
    writeFileSync(join(packageDirectory, 'package.json'), '{}');
    writeFileSync(join(packageDirectory, 'tsconfig.json'), '{}');

    const blocks = buildPerPackageTestTypeCheckedBlocks(repoRoot);

    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks[0]?.languageOptions?.parserOptions).toEqual({
      project: ['./tsconfig.json'],
      tsconfigRootDir: packageDirectory,
    });
  });

  it('throws loudly instead of silently skipping a package with neither tsconfig', () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'ab-383-blocks-neither-tsconfig-'));
    const packageDirectory = makeFakePackage(repoRoot, 'neither-tsconfig');
    writeFileSync(join(packageDirectory, 'package.json'), '{}');

    expect(() => buildPerPackageTestTypeCheckedBlocks(repoRoot)).toThrow(
      /neither tsconfig\.test\.json nor tsconfig\.json/,
    );
  });
});

/**
 * Proves the AB-383 fix end-to-end: a repository-root ESLint invocation (`cwd: REPO_ROOT`, the
 * exact condition that broke before this fix — see `resolveTestTsconfigProject`'s old
 * `process.cwd()` call site) type-checks a `test/**` file in a real workspace package and reports
 * a genuine type-aware finding (`@typescript-eslint/no-deprecated`) rather than dropping the file
 * with a `TS5012` parser error. Uses `packages/lifecycle` — the smallest package with both a
 * `test/` directory and a `tsconfig.test.json` — to keep the type-checked program this test builds
 * cheap.
 */
describe('AB-383: root-invocation test/** type-checking', () => {
  const REPO_ROOT = join(import.meta.dir, '..');
  // A per-run-unique filename (rather than a fixed one) so an interrupted run, or two runs
  // sharing this worktree concurrently, can never collide on or clobber each other's fixture.
  const FIXTURE_PATH = join(
    REPO_ROOT,
    `packages/lifecycle/test/ab-383-fixture-${crypto.randomUUID()}.test.ts`,
  );

  afterEach(() => {
    rmSync(FIXTURE_PATH, { force: true });
  });

  it('reports a type-aware no-deprecated finding for a test/** file from a repo-root cwd', async () => {
    writeFileSync(
      FIXTURE_PATH,
      [
        "import { describe, expect, it } from 'bun:test';",
        '',
        '/** @deprecated AB-383 fixture only; not a real deprecation. */',
        'function legacyHelper(): number {',
        '  return 1;',
        '}',
        '',
        "describe('ab-383 fixture', () => {",
        "  it('calls the deprecated helper', () => {",
        '    expect(legacyHelper()).toBe(1);',
        '  });',
        '});',
        '',
      ].join('\n'),
    );

    const eslint = new ESLint({
      cwd: REPO_ROOT,
      overrideConfigFile: true,
      overrideConfig: [...baseConfig, ...testOverrides],
    });

    const [result] = await eslint.lintFiles([FIXTURE_PATH]);
    if (!result) {
      throw new Error('expected exactly one lint result for the fixture file');
    }

    expect(result.fatalErrorCount).toBe(0);
    expect(result.messages.some((message) => message.message.includes('TS5012'))).toBe(false);

    const deprecatedMessages = result.messages.filter(
      (message) => message.ruleId === '@typescript-eslint/no-deprecated',
    );
    expect(deprecatedMessages.length).toBe(1);
  });
});
