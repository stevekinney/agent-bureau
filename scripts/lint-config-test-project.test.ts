/**
 * Unit-tests `resolveTestTsconfigProject` (AB-368), the pure function that decides which
 * tsconfig the shared `test/**` type-checked lint block parses against for a given package:
 * that package's own `tsconfig.test.json` when it exists, or its `tsconfig.json` (which, for the
 * two packages with no `tsconfig.test.json`, already lists `test` in its own `include`) when it
 * doesn't. Uses real temporary directories rather than mocking `node:fs`, per this repo's
 * "Testing Pattern: Factory Functions and Mock Injection" convention (no module mocking).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'bun:test';

import { resolveTestTsconfigProject } from '../eslint.config.base.ts';

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
