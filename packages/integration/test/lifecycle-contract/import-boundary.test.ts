/**
 * Pins the same test-helper-parity rule AB-100's tst-09c gate will later
 * enforce repository-wide (AB-268's acceptance criteria): every workspace-
 * package specifier a file in this directory imports resolves through a
 * subpath that package's own `package.json` `exports` map actually
 * declares — never a package-private `src`/`dist` deep path. The repo-wide
 * `import-boundary.test.ts` one level up already forbids literal
 * `/src`/`/dist` substrings; this one additionally validates every
 * workspace specifier positively, against the real `exports` map, rather
 * than only a denylist of path shapes.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'bun:test';

/** Workspace packages this directory may import, mapped to their directory name under `packages/`. */
const WORKSPACE_PACKAGE_DIRECTORIES: Readonly<Record<string, string>> = {
  '@lostgradient/operative': 'operative',
  armorer: 'armorer',
  bureau: 'bureau',
  conversationalist: 'conversationalist',
};

function walk(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const entryPath = join(directory, entry);
    const stats = statSync(entryPath);
    return stats.isDirectory() ? walk(entryPath) : [entryPath];
  });
}

/** Every static or dynamic import specifier a file contains, in source order. */
function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const pattern = /\b(?:from|import\s*\()\s*['"]([^'"]+)['"]/g;
  for (const match of source.matchAll(pattern)) {
    if (match[1]) specifiers.push(match[1]);
  }
  return specifiers;
}

/** Splits `@scope/name/sub/path` or `name/sub/path` into a known workspace package name and its subpath (`'.'` when bare) — `undefined` for anything else (an external dependency, a relative import, `bun:test`, …). */
function splitWorkspaceSpecifier(
  specifier: string,
): { packageName: string; subpath: string } | undefined {
  const segments = specifier.split('/');
  const packageName = specifier.startsWith('@')
    ? segments.slice(0, 2).join('/')
    : (segments[0] ?? '');
  if (!(packageName in WORKSPACE_PACKAGE_DIRECTORIES)) return undefined;
  const rest = specifier.slice(packageName.length);
  return { packageName, subpath: rest === '' ? '.' : `.${rest}` };
}

function exportsMapFor(packageDirectoryName: string): Record<string, unknown> {
  const repositoryRoot = join(new URL('.', import.meta.url).pathname, '..', '..', '..', '..');
  const packageJsonPath = join(repositoryRoot, 'packages', packageDirectoryName, 'package.json');
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
    exports?: Record<string, unknown>;
  };
  return packageJson.exports ?? {};
}

describe('lifecycle-contract import boundaries', () => {
  it("imports every workspace-package specifier through a subpath that package's own exports map declares", () => {
    const directory = new URL('.', import.meta.url).pathname;
    const files = walk(directory).filter((path) => path.endsWith('.ts'));
    const exportsMapCache = new Map<string, Record<string, unknown>>();
    const violations: string[] = [];

    for (const filePath of files) {
      const source = readFileSync(filePath, 'utf8');
      for (const specifier of importSpecifiers(source)) {
        const split = splitWorkspaceSpecifier(specifier);
        if (!split) continue;

        const packageDirectoryName = WORKSPACE_PACKAGE_DIRECTORIES[split.packageName];
        if (!packageDirectoryName) continue;

        let exportsMap = exportsMapCache.get(packageDirectoryName);
        if (!exportsMap) {
          exportsMap = exportsMapFor(packageDirectoryName);
          exportsMapCache.set(packageDirectoryName, exportsMap);
        }
        if (!(split.subpath in exportsMap)) {
          violations.push(
            `${filePath}: "${specifier}" — "${split.subpath}" is not declared in ${split.packageName}'s package.json exports map`,
          );
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
