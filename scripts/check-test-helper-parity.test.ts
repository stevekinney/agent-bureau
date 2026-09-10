import { resolve } from 'node:path';

import { beforeAll, describe, expect, it } from 'bun:test';
import ts from 'typescript';

import {
  checkTestHelperParity,
  evaluateTestHelperParity,
  findCrossPackageFindings,
  formatBrokenPairing,
  formatViolation,
  isPackageManifestPath,
  isSubpathReachable,
  loadWorkspacePackages,
  parseAdapterSuiteManifest,
  REMEDIATION_SENTENCE,
  type CrossPackageFinding,
  type WorkspacePackage,
} from './check-test-helper-parity';

const repositoryRoot = resolve(import.meta.dir, '..');
const fixtureRoot = resolve(repositoryRoot, 'scripts/fixtures/test-helper-parity');

// The exports-map-resolution fixture, written first per the issue's testing plan: a gate that
// misreads an `exports` map either reports everything or nothing, and both look like it works.
describe('isSubpathReachable', () => {
  it('treats a bare string exports field as exporting only "."', () => {
    expect(isSubpathReachable('./dist/index.js', '.')).toBe(true);
    expect(isSubpathReachable('./dist/index.js', './internal')).toBe(false);
  });

  it('treats an object with no dot-prefixed key as a conditions object for "."', () => {
    const exportsField = { import: './dist/index.js', types: './dist/index.d.ts' };
    expect(isSubpathReachable(exportsField, '.')).toBe(true);
    expect(isSubpathReachable(exportsField, './internal')).toBe(false);
  });

  it('resolves "." reachable when its only condition is types', () => {
    expect(isSubpathReachable({ types: './dist/index.d.ts' }, '.')).toBe(true);
  });

  it('resolves an exact subpath key in a subpath map', () => {
    const exportsField = { '.': './dist/index.js', './test': './dist/test/index.js' };
    expect(isSubpathReachable(exportsField, './test')).toBe(true);
    expect(isSubpathReachable(exportsField, './src/internal')).toBe(false);
  });

  it('resolves a "*" wildcard subpath pattern', () => {
    const exportsField = { '.': './dist/index.js', './providers/*': './dist/providers/*.js' };
    expect(isSubpathReachable(exportsField, './providers/anthropic')).toBe(true);
    expect(isSubpathReachable(exportsField, './internal/anthropic')).toBe(false);
  });

  it('prefers the longest matching wildcard pattern, even when it forbids what the shorter one would allow', () => {
    const exportsField = {
      './*': './dist/*.js',
      './internal/*': null,
    };
    // Both patterns match './internal/x'; the longer, more specific one wins and forbids it —
    // proving the tie-break actually changes the outcome, not merely that reachability holds.
    expect(isSubpathReachable(exportsField, './internal/x')).toBe(false);
    expect(isSubpathReachable(exportsField, './public/x')).toBe(true);
  });

  it("breaks a wildcard tie by the pattern's PREFIX length, not the key's total length (Node's own precedence)", () => {
    // Node: './foo/bar/*' (prefix './foo/bar/', 10 chars) is MORE specific than
    // './foo/*-longsuffix' (prefix './foo/', 6 chars) even though the second key is the LONGER
    // string overall — a total-key-length comparison picks the wrong one and would incorrectly
    // report this subpath reachable.
    const exportsField = {
      './foo/*-longsuffix': './dist/*.js',
      './foo/bar/*': null,
    };
    expect(isSubpathReachable(exportsField, './foo/bar/x-longsuffix')).toBe(false);
  });

  it('never matches a key with more than one "*" — an invalid pattern is not silently matched on its first wildcard alone', () => {
    // '.\/a\*b\*c' has two '*'s: Node rejects multi-wildcard exports keys outright, so this must
    // never be treated as a match even though a naive first-'*'-only split would report one.
    const exportsField = { './a*b*c': './dist/index.js' };
    expect(isSubpathReachable(exportsField, './aXbYc')).toBe(false);
  });

  it('treats a subpath explicitly mapped to null as forbidden, not reachable', () => {
    const exportsField = { '.': './dist/index.js', './internal': null };
    expect(isSubpathReachable(exportsField, './internal')).toBe(false);
  });

  it('treats an array of alternatives as exporting only "."', () => {
    expect(isSubpathReachable(['./dist/index.js', './dist/index.cjs'], '.')).toBe(true);
    expect(isSubpathReachable(['./dist/index.js'], './internal')).toBe(false);
  });

  it('treats a missing exports field as fully reachable (Node legacy-resolution fallback)', () => {
    expect(isSubpathReachable(undefined, './anything')).toBe(true);
  });

  it('treats a malformed leaf (neither string, array, object, null, nor undefined) as not resolving', () => {
    // A boolean/number leaf is not valid `exports` JSON, but the resolver must still terminate
    // safely rather than throwing on unexpected shapes.
    expect(isSubpathReachable({ '.': true }, '.')).toBe(false);
  });

  it('resolves against the real @lostgradient/operative exports map (AC fixture)', async () => {
    const raw: unknown = await Bun.file(
      resolve(repositoryRoot, 'packages/operative/package.json'),
    ).json();
    const record = raw as { exports?: unknown };
    expect(isSubpathReachable(record.exports, './test')).toBe(true);
    expect(isSubpathReachable(record.exports, './src/create-run')).toBe(false);
  });
});

describe('isPackageManifestPath', () => {
  it('is true for the package root manifest subpath', () => {
    expect(isPackageManifestPath('./package.json')).toBe(true);
  });

  it('is true for a manifest nested under a subdirectory subpath', () => {
    expect(isPackageManifestPath('./nested/package.json')).toBe(true);
  });

  it('is false for a subpath that merely contains "package.json" as part of a longer name', () => {
    expect(isPackageManifestPath('./package.json.bak')).toBe(false);
    expect(isPackageManifestPath('./src/package.json.ts')).toBe(false);
  });

  it('is false for an ordinary internal subpath', () => {
    expect(isPackageManifestPath('./src/internal')).toBe(false);
    expect(isPackageManifestPath('.')).toBe(false);
  });
});

describe('parseAdapterSuiteManifest', () => {
  it('accepts an empty entries/notRuled manifest', () => {
    expect(parseAdapterSuiteManifest({ entries: [], notRuled: [] })).toEqual({
      entries: [],
      notRuled: [],
    });
  });

  it('rejects a non-object value', () => {
    expect(() => parseAdapterSuiteManifest('nope')).toThrow(TypeError);
  });

  it('rejects null', () => {
    expect(() => parseAdapterSuiteManifest(null)).toThrow(TypeError);
  });

  it('rejects an array (entries/notRuled must be object properties, not the value itself)', () => {
    expect(() => parseAdapterSuiteManifest([])).toThrow(TypeError);
  });

  it('rejects an entries array with a missing field', () => {
    expect(() =>
      parseAdapterSuiteManifest({
        entries: [{ adapterSuite: 'x', guarantee: 'y', blackBoxTest: 'z' }],
        notRuled: [],
      }),
    ).toThrow(TypeError);
  });

  it('rejects a notRuled array with a missing field', () => {
    expect(() => parseAdapterSuiteManifest({ entries: [], notRuled: [{ path: 'x' }] })).toThrow(
      TypeError,
    );
  });

  it('parses the real adapter-suite-manifest.json', async () => {
    const raw: unknown = await Bun.file(
      resolve(repositoryRoot, 'scripts/adapter-suite-manifest.json'),
    ).json();
    const manifest = parseAdapterSuiteManifest(raw);
    expect(manifest.entries.length).toBeGreaterThan(0);
    expect(manifest.notRuled.length).toBeGreaterThan(0);
  });
});

describe('loadWorkspacePackages', () => {
  it('loads name, directory, and exports for every package under the fixture root', async () => {
    const packages = await loadWorkspacePackages(fixtureRoot);
    const byName = new Map(packages.map((pkg) => [pkg.name, pkg] as const));

    expect(byName.get('fixture-pkg-a')).toEqual({
      name: 'fixture-pkg-a',
      directory: 'packages/pkg-a',
      exportsField: { '.': './src/index.ts', './test': './src/test/index.ts' },
    });
    expect(byName.get('fixture-pkg-b')).toEqual({
      name: 'fixture-pkg-b',
      directory: 'packages/pkg-b',
      exportsField: undefined,
    });
  });

  it('loads every real workspace package with a name', async () => {
    const packages = await loadWorkspacePackages(repositoryRoot);
    const names = packages.map((pkg) => pkg.name);
    expect(names).toContain('@lostgradient/operative');
    expect(names).toContain('bureau');
    expect(names).toContain('armorer');
  });
});

describe('findCrossPackageFindings', () => {
  let packages: WorkspacePackage[];

  beforeAll(async () => {
    packages = await loadWorkspacePackages(fixtureRoot);
  });

  function findingsFor(filePath: string, sourceText: string): CrossPackageFinding[] {
    const sourceFile = ts.createSourceFile(
      filePath,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    return findCrossPackageFindings(filePath, sourceFile, packages);
  }

  it('does not report a cross-package import reachable through the exports map', () => {
    const findings = findingsFor(
      'packages/pkg-b/test/exports-reachable.ts',
      `import type { testHelper } from 'fixture-pkg-a/test';\nexport type X = typeof testHelper;\n`,
    );
    expect(findings).toEqual([]);
  });

  it('reports a cross-package import not reachable through the exports map', () => {
    const findings = findingsFor(
      'packages/pkg-b/test/internal-no-manifest.ts',
      `import type { internalThing } from 'fixture-pkg-a/src/internal';\nexport type X = typeof internalThing;\n`,
    );
    expect(findings).toEqual([
      {
        importingFile: 'packages/pkg-b/test/internal-no-manifest.ts',
        importingPackage: 'fixture-pkg-b',
        targetPackage: 'fixture-pkg-a',
        internalPath: './src/internal',
        line: 1,
      },
    ]);
  });

  it('does not report a bare-specifier import of a package manifest even though the exports map declares no ./package.json subpath', () => {
    // fixture-pkg-a's exports map (see loadWorkspacePackages tests above) declares only '.' and
    // './test' — no './package.json' — yet a manifest read is metadata, not a piece of internal
    // surface, and must never be reported regardless of what the exports map declares.
    const findings = findingsFor(
      'packages/pkg-b/test/reads-manifest.ts',
      `import packageJson from 'fixture-pkg-a/package.json';\nexport const version = packageJson.version;\n`,
    );
    expect(findings).toEqual([]);
  });

  it('does not report a relative import of a package manifest across a package boundary', () => {
    const findings = findingsFor(
      'packages/pkg-b/test/reads-manifest-relative.ts',
      `import packageJson from '../../pkg-a/package.json';\nexport const version = packageJson.version;\n`,
    );
    expect(findings).toEqual([]);
  });

  it('does not report a same-package relative import', () => {
    const findings = findingsFor(
      'packages/pkg-a/src/same-package.test.ts',
      `import { internalThing } from './internal';\nexport const x = internalThing;\n`,
    );
    expect(findings).toEqual([]);
  });

  it('ignores an empty-string specifier rather than throwing', () => {
    const findings = findingsFor('packages/pkg-b/test/empty.ts', `import {} from '';\n`);
    expect(findings).toEqual([]);
  });

  it('does not report an import of a package this repository does not build as a workspace member', () => {
    const findings = findingsFor(
      'packages/pkg-b/test/external.ts',
      `import { z } from 'zod';\nexport const schema = z.string();\n`,
    );
    expect(findings).toEqual([]);
  });

  it('reports a relative import that crosses into a different package directory at an undeclared subpath', () => {
    const findings = findingsFor(
      'packages/pkg-b/test/relative-cross-package.ts',
      `import { internalThing } from '../../pkg-a/src/internal';\nexport const x = internalThing;\n`,
    );
    expect(findings).toEqual([
      {
        importingFile: 'packages/pkg-b/test/relative-cross-package.ts',
        importingPackage: 'fixture-pkg-b',
        targetPackage: 'fixture-pkg-a',
        internalPath: './src/internal',
        line: 1,
      },
    ]);
  });

  it('does not report a relative import that crosses into a package with no exports field at all', () => {
    // pkg-a has no reference to pkg-b, but the reachability rule applies symmetrically: a
    // relative import into a package with no declared exports map is fully reachable, exactly as
    // a bare specifier import of that same package would be (mirrors the real `integration`
    // package, which declares no exports and is reached only via relative imports today).
    const findings = findingsFor(
      'packages/pkg-a/src/reaches-pkg-b.ts',
      `import { x } from '../../pkg-b/test/black-box-proof';\nexport const y = x;\n`,
    );
    expect(findings).toEqual([]);
  });

  it('sees a dynamic import() the same way it sees a static import', () => {
    const findings = findingsFor(
      'packages/pkg-b/test/dynamic.ts',
      `export async function load() {\n  return import('fixture-pkg-a/src/internal');\n}\n`,
    );
    expect(findings).toEqual([
      {
        importingFile: 'packages/pkg-b/test/dynamic.ts',
        importingPackage: 'fixture-pkg-b',
        targetPackage: 'fixture-pkg-a',
        internalPath: './src/internal',
        line: 2,
      },
    ]);
  });

  it('sees a type-only import() expression (ImportTypeNode) the same way it sees a value import', () => {
    // `type T = import('...').T` parses as an `ImportTypeNode`, not a call expression — a
    // TypeScript-only equivalent to a dynamic import that reaches the same internal path without
    // ever appearing as `ts.isCallExpression`.
    const findings = findingsFor(
      'packages/pkg-b/test/type-only.ts',
      `export type X = import('fixture-pkg-a/src/internal').InternalThing;\n`,
    );
    expect(findings).toEqual([
      {
        importingFile: 'packages/pkg-b/test/type-only.ts',
        importingPackage: 'fixture-pkg-b',
        targetPackage: 'fixture-pkg-a',
        internalPath: './src/internal',
        line: 1,
      },
    ]);
  });
});

describe('evaluateTestHelperParity', () => {
  const finding: CrossPackageFinding = {
    importingFile: 'packages/pkg-b/test/internal-no-manifest.ts',
    importingPackage: 'fixture-pkg-b',
    targetPackage: 'fixture-pkg-a',
    internalPath: './src/internal',
    line: 1,
  };

  it('reports a finding with no manifest entry as a violation', () => {
    const result = evaluateTestHelperParity([finding], { entries: [], notRuled: [] }, new Set());
    expect(result.violations).toEqual([{ ...finding, reason: 'unpaired-adapter-import' }]);
    expect(result.brokenPairings).toEqual([]);
  });

  it('permits a finding whose importing file is named in a manifest entry', () => {
    const manifest = {
      entries: [
        {
          adapterSuite: finding.importingFile,
          guarantee: 'guarantee',
          blackBoxTest: 'packages/pkg-b/test/black-box-proof.test.ts > suite > case',
          owner: 'owner',
        },
      ],
      notRuled: [],
    };
    const allTestIdentifiers = new Set([
      'packages/pkg-b/test/black-box-proof.test.ts > suite > case',
    ]);
    const result = evaluateTestHelperParity([finding], manifest, allTestIdentifiers);
    expect(result.violations).toEqual([]);
    expect(result.brokenPairings).toEqual([]);
  });

  it('reports a broken pairing when the manifest names a blackBoxTest that resolves to no known test', () => {
    const manifest = {
      entries: [
        {
          adapterSuite: finding.importingFile,
          guarantee: 'guarantee',
          blackBoxTest: 'packages/pkg-b/test/black-box-proof.test.ts > this does not exist',
          owner: 'owner',
        },
      ],
      notRuled: [],
    };
    const result = evaluateTestHelperParity([finding], manifest, new Set());
    expect(result.violations).toEqual([]);
    expect(result.brokenPairings).toEqual([
      {
        adapterSuite: finding.importingFile,
        blackBoxTest: 'packages/pkg-b/test/black-box-proof.test.ts > this does not exist',
      },
    ]);
  });

  it('does not treat a manifest entry with no corresponding finding as an orphan', () => {
    const manifest = {
      entries: [
        {
          adapterSuite: 'packages/operative/src/durable/active-run-adapter.test.ts',
          guarantee: 'guarantee',
          blackBoxTest: 'packages/bureau/src/create-bureau.test.ts > createBureau > case',
          owner: 'owner',
        },
      ],
      notRuled: [],
    };
    const allTestIdentifiers = new Set([
      'packages/bureau/src/create-bureau.test.ts > createBureau > case',
    ]);
    const result = evaluateTestHelperParity([], manifest, allTestIdentifiers);
    expect(result.violations).toEqual([]);
    expect(result.brokenPairings).toEqual([]);
  });

  it('rejects a blackBoxTest naming only a describe suite, not an actual it/test case', () => {
    // findCrossPackageFindings/checkTestHelperParity pass only `leafTestIdentifiers` (it/test
    // cases) here, never the full `allTestIdentifiers` set — a manifest entry naming a suite alone
    // identifies no assertion that actually runs, so it must be treated exactly like naming no
    // test at all.
    const manifest = {
      entries: [
        {
          adapterSuite: finding.importingFile,
          guarantee: 'guarantee',
          blackBoxTest:
            'packages/pkg-b/test/black-box-proof.test.ts > proves the guarantee publicly',
          owner: 'owner',
        },
      ],
      notRuled: [],
    };
    // A caller that (incorrectly) passed the full describe+test identifier set would find this
    // suite-only identifier present; the correct leaf-only set never contains it.
    const suiteOnlyIdentifierPresentButNotALeaf = new Set<string>();
    const result = evaluateTestHelperParity(
      [finding],
      manifest,
      suiteOnlyIdentifierPresentButNotALeaf,
    );
    expect(result.brokenPairings).toEqual([
      {
        adapterSuite: finding.importingFile,
        blackBoxTest: 'packages/pkg-b/test/black-box-proof.test.ts > proves the guarantee publicly',
      },
    ]);
  });
});

describe('formatViolation', () => {
  it('names the file, the internal path, and the exact remediation sentence', () => {
    const message = formatViolation({
      importingFile: 'packages/pkg-b/test/internal-no-manifest.ts',
      importingPackage: 'fixture-pkg-b',
      targetPackage: 'fixture-pkg-a',
      internalPath: './src/internal',
      line: 1,
      reason: 'unpaired-adapter-import',
    });
    expect(message).toContain('packages/pkg-b/test/internal-no-manifest.ts:1');
    expect(message).toContain('./src/internal');
    expect(message).toContain('fixture-pkg-a');
    expect(message).toContain(REMEDIATION_SENTENCE);
  });
});

describe('formatBrokenPairing', () => {
  it('names the adapter suite and the missing blackBoxTest', () => {
    const message = formatBrokenPairing({
      adapterSuite: 'packages/pkg-b/test/internal-with-missing-manifest.ts',
      blackBoxTest: 'packages/pkg-b/test/black-box-proof.test.ts > this test does not exist',
    });
    expect(message).toContain('packages/pkg-b/test/internal-with-missing-manifest.ts');
    expect(message).toContain('this test does not exist');
  });
});

// The five-fixture outcome set the issue's acceptance criteria enumerate, run end to end against
// the fixture repository root exactly as `checkTestHelperParity` runs against the real one.
describe('checkTestHelperParity against the fixture repository', () => {
  it('reports the one unpaired internal-path import as a violation', async () => {
    // 'internal-with-missing-manifest.ts' IS named by a manifest entry (its `adapterSuite`
    // matches), so its import is permitted and never becomes a `violation` — the manifest entry's
    // own broken `blackBoxTest` is a SEPARATE finding, asserted below. Only the truly unmanifested
    // import is a violation.
    const result = await checkTestHelperParity(fixtureRoot);
    const violationFiles = result.violations.map((violation) => violation.importingFile).sort();
    expect(violationFiles).toEqual([
      'packages/pkg-b/src/test/shared-helper.ts',
      'packages/pkg-b/test/internal-no-manifest.ts',
    ]);
  });

  it('scans a non-.test.ts source-side test helper module under packages/*/src/test/', async () => {
    // A source-side helper (like a real consumer's shared conformance suite) never matches
    // `packages/*\/test/**\/*.ts` or `packages/*\/src/**\/*.test.ts` on its own filename, so it
    // must be covered by the dedicated `packages/*\/src/test/**\/*.ts` glob or its internal-path
    // import would bypass the gate entirely.
    const result = await checkTestHelperParity(fixtureRoot);
    expect(result.scannedFiles).toContain('packages/pkg-b/src/test/shared-helper.ts');
    const violationFiles = new Set(result.violations.map((violation) => violation.importingFile));
    expect(violationFiles.has('packages/pkg-b/src/test/shared-helper.ts')).toBe(true);
  });

  it('reports the one broken pairing', async () => {
    const result = await checkTestHelperParity(fixtureRoot);
    expect(result.brokenPairings).toEqual([
      {
        adapterSuite: 'packages/pkg-b/test/internal-with-missing-manifest.ts',
        blackBoxTest: 'packages/pkg-b/test/black-box-proof.test.ts > this test does not exist',
      },
    ]);
  });

  it('does not report the exports-reachable import or the manifest-paired import', async () => {
    const result = await checkTestHelperParity(fixtureRoot);
    const violationFiles = new Set(result.violations.map((violation) => violation.importingFile));
    expect(violationFiles.has('packages/pkg-b/test/exports-reachable.ts')).toBe(false);
    expect(violationFiles.has('packages/pkg-b/test/internal-with-valid-manifest.ts')).toBe(false);
  });

  it('does not report the same-package import', async () => {
    const result = await checkTestHelperParity(fixtureRoot);
    const violationFiles = new Set(result.violations.map((violation) => violation.importingFile));
    expect(violationFiles.has('packages/pkg-a/src/same-package.test.ts')).toBe(false);
  });
});

describe('checkTestHelperParity against the real repository', () => {
  it('finds zero violations and zero broken pairings on the current baseline', async () => {
    const result = await checkTestHelperParity(repositoryRoot);
    expect(result.violations).toEqual([]);
    expect(result.brokenPairings).toEqual([]);
  });

  it('actually walked packages/, proving the zero-violation result is not vacuous', async () => {
    const result = await checkTestHelperParity(repositoryRoot);
    expect(result.scannedFiles).toContain('packages/bureau/src/create-bureau.test.ts');
    expect(result.scannedFiles).toContain(
      'packages/operative/src/durable/active-run-adapter.test.ts',
    );
    expect(result.scannedFiles.length).toBeGreaterThan(100);
  });

  it('the seeded active-run-adapter.test.ts manifest entry names a real black-box test (AB-92 AC6 seed)', async () => {
    const rawManifest: unknown = await Bun.file(
      resolve(repositoryRoot, 'scripts/adapter-suite-manifest.json'),
    ).json();
    const manifest = parseAdapterSuiteManifest(rawManifest);
    const seededEntry = manifest.entries.find(
      (entry) => entry.adapterSuite === 'packages/operative/src/durable/active-run-adapter.test.ts',
    );
    expect(seededEntry).toBeDefined();

    const result = await checkTestHelperParity(repositoryRoot);
    expect(
      result.brokenPairings.some((pairing) => pairing.adapterSuite === seededEntry?.adapterSuite),
    ).toBe(false);
  });

  it('flags an internal-path import introduced under packages/, proving the gate actually runs (AB-100 method)', async () => {
    const packages = await loadWorkspacePackages(repositoryRoot);
    const sourceText = `import { createActiveRun } from '@lostgradient/operative/src/create-run';\nexport const x = createActiveRun;\n`;
    const sourceFile = ts.createSourceFile(
      'packages/bureau/src/proof.test.ts',
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const findings = findCrossPackageFindings(
      'packages/bureau/src/proof.test.ts',
      sourceFile,
      packages,
    );
    const result = evaluateTestHelperParity(findings, { entries: [], notRuled: [] }, new Set());
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]?.internalPath).toBe('./src/create-run');
  });
});
