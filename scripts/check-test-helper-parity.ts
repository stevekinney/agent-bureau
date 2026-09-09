/**
 * Test-helper-parity gate (AB-280, enforcing AB-92 AC6, tracked by AB-100 as tst-09c).
 *
 * AB-92's decision record forbids a lower-level adapter suite from becoming a secret testing API:
 * a test that reaches a package's INTERNAL path to prove a user-visible guarantee is a violation
 * unless a black-box test proves the same guarantee through that package's PUBLIC surface. This
 * script is that gate.
 *
 * WHAT COUNTS AS "INTERNAL". Every `packages/*\/test/**\/*.ts` or `packages/*\/src/**\/*.test.ts`
 * file is scanned for import specifiers (static `import`/`export … from`, and dynamic
 * `import('literal')`) that resolve to a DIFFERENT workspace package than the one the importing
 * file itself lives in. An import within the importing file's own package is never reported — a
 * package's unit tests legitimately import their own modules, and `packages/*\/src/test/` exists
 * precisely to wrap internals for external consumers. A cross-package import is permitted only
 * when it resolves through the target package's declared `package.json` `exports` map (a bare
 * package specifier, or one of its declared subpaths, e.g. `@lostgradient/operative/test`); a
 * cross-package import naming a subpath `exports` does not declare — a bare specifier, OR a
 * relative import that crosses into another package's directory on disk, held to the EXACT SAME
 * reachability check against the subpath a real consumer would have to name — is reported unless
 * `scripts/adapter-suite-manifest.json` names the importing file as a labeled adapter suite with a
 * real black-box pairing.
 *
 * WHY THE TYPESCRIPT COMPILER API. Same rationale as `scripts/check-skip-manifest.ts` and
 * `scripts/documentation-examples.test.ts`: a regular expression cannot tell an import inside a
 * string literal or comment from a real one, and `exports`-map resolution has too many shapes
 * (a bare string, a conditions object, a subpath map, `*` wildcard patterns, arrays of
 * alternatives, an explicit `null` to forbid a subpath) for a hand-rolled matcher to get right.
 *
 * EXPORTS-MAP RESOLUTION (`isSubpathReachable`). Reachability is a KEY LOOKUP only — this gate
 * never verifies the resolved target file actually exists on disk, matching how Node itself
 * decides `ERR_PACKAGE_PATH_NOT_EXPORTED` from the map alone.
 *
 * - No `exports` field at all: everything is reachable (Node's own legacy-resolution fallback for
 *   a package with no `exports` map — verified against every workspace `package.json` at review
 *   time: `gateway` and `integration` have none, and both are private test/aggregator packages
 *   with zero cross-package internal-path imports today, so this fallback is inert, not a loophole
 *   silently opened for a real case).
 * - A bare string, or an array of alternatives: only `.` is reachable.
 * - An object whose keys do NOT start with `.`: a CONDITIONS object for `.` (e.g.
 *   `{"import": "...", "types": "..."}`); reachable only for `.`, and only if at least one
 *   condition (including one whose only condition is `types`) resolves to a non-null leaf.
 * - An object whose keys start with `.`: a SUBPATH map. An exact key match wins; otherwise the
 *   longest `*`\-wildcard key whose prefix/suffix match the requested subpath wins (Node's own
 *   tie-break for overlapping patterns). A subpath mapped explicitly to `null` is NOT reachable —
 *   Node's own mechanism for forbidding one subpath while exporting a sibling.
 *
 * MANIFEST VALIDATION (`scripts/adapter-suite-manifest.json`). Two independent things can fail:
 * a reported cross-package import whose importing file names no manifest `adapterSuite` entry
 * (an unpaired adapter import), and a manifest entry whose `blackBoxTest` — "file path plus test
 * name" in the exact `${filePath} > ${describeChain} > ${title}` shape
 * `scripts/check-skip-manifest.ts`'s `findSkipFindingsInSource` already produces as its
 * `testIdentifier` (reused here, not reimplemented, per this repository's no-duplicated-code
 * convention) — that names no test found anywhere the gate scanned (a broken pairing, so the
 * pairing cannot silently rot once the black-box test is renamed or deleted). A manifest entry
 * with no corresponding reported import (for example, the AB-92 AC6-mandated seed for
 * `packages/operative/src/durable/active-run-adapter.test.ts`, whose two internal imports are
 * same-package relative imports the gate never reports in the first place) is NOT an error — the
 * manifest is allowed to document a labeled adapter suite ahead of, or independent of, what this
 * gate's own reported-violation set currently contains.
 *
 * Usage: `bun run scripts/check-test-helper-parity.ts` (wired to `bun run check-test-helper-parity`
 * and to `bun run validate`).
 */
import { readFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';

import ts from 'typescript';

import { findSkipFindingsInSource } from './check-skip-manifest';

export interface WorkspacePackage {
  readonly name: string;
  /** Repository-root-relative, e.g. `packages/operative`. */
  readonly directory: string;
  /** Raw `exports` field from `package.json`, or `undefined` when the package declares none. */
  readonly exportsField: unknown;
}

export interface AdapterSuiteManifestEntry {
  readonly adapterSuite: string;
  readonly guarantee: string;
  readonly blackBoxTest: string;
  readonly owner: string;
}

export interface NotAnAdapterSuiteRuling {
  readonly path: string;
  readonly reason: string;
}

export interface AdapterSuiteManifest {
  readonly entries: readonly AdapterSuiteManifestEntry[];
  readonly notRuled: readonly NotAnAdapterSuiteRuling[];
}

export interface CrossPackageFinding {
  readonly importingFile: string;
  readonly importingPackage: string;
  readonly targetPackage: string;
  /** The specifier's subpath (`.`/`./test`/…) for a bare specifier, or the raw specifier for a relative one. */
  readonly internalPath: string;
  readonly line: number;
}

export interface TestHelperParityViolation extends CrossPackageFinding {
  readonly reason: 'unpaired-adapter-import';
}

export interface BrokenPairing {
  readonly adapterSuite: string;
  readonly blackBoxTest: string;
}

export interface TestHelperParityCheckResult {
  readonly violations: readonly TestHelperParityViolation[];
  readonly brokenPairings: readonly BrokenPairing[];
}

export interface TestHelperParityGateResult extends TestHelperParityCheckResult {
  readonly scannedFiles: readonly string[];
}

const TEST_FILE_GLOBS: readonly string[] = [
  'packages/*/test/**/*.ts',
  'packages/*/src/**/*.test.ts',
];

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isAdapterSuiteManifestEntry(value: unknown): value is AdapterSuiteManifestEntry {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    isNonEmptyString(record['adapterSuite']) &&
    isNonEmptyString(record['guarantee']) &&
    isNonEmptyString(record['blackBoxTest']) &&
    isNonEmptyString(record['owner'])
  );
}

function isNotAnAdapterSuiteRuling(value: unknown): value is NotAnAdapterSuiteRuling {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return isNonEmptyString(record['path']) && isNonEmptyString(record['reason']);
}

/** Runtime shape guard for `scripts/adapter-suite-manifest.json` — no `as` cast past this point. */
export function parseAdapterSuiteManifest(value: unknown): AdapterSuiteManifest {
  if (typeof value !== 'object' || value === null) {
    throw new TypeError(
      'adapter-suite-manifest.json must be an object with entries/notRuled arrays',
    );
  }
  const record = value as Record<string, unknown>;
  const entries = record['entries'];
  const notRuled = record['notRuled'];
  if (!Array.isArray(entries) || !entries.every(isAdapterSuiteManifestEntry)) {
    throw new TypeError(
      'adapter-suite-manifest.json "entries" must be an array of {adapterSuite, guarantee, blackBoxTest, owner}, each a non-empty string',
    );
  }
  if (!Array.isArray(notRuled) || !notRuled.every(isNotAnAdapterSuiteRuling)) {
    throw new TypeError(
      'adapter-suite-manifest.json "notRuled" must be an array of {path, reason}, each a non-empty string',
    );
  }
  return { entries, notRuled };
}

/**
 * Whether `subpath` (`.`, `./test`, `./src/create-run`, …) is reachable through a package's raw
 * `exports` field. A key lookup only — never checks whether the resolved target file exists.
 */
export function isSubpathReachable(exportsField: unknown, subpath: string): boolean {
  if (exportsField === undefined) return true;
  if (typeof exportsField === 'string') return subpath === '.';
  if (Array.isArray(exportsField)) return subpath === '.' && resolvesToSomething(exportsField);
  if (typeof exportsField !== 'object' || exportsField === null) return false;

  const record = exportsField as Record<string, unknown>;
  const keys = Object.keys(record);
  const isSubpathMap = keys.some((key) => key.startsWith('.'));

  if (!isSubpathMap) {
    // A conditions object with no dot-prefixed key maps '.' directly.
    return subpath === '.' && resolvesToSomething(record);
  }

  if (subpath in record) return resolvesToSomething(record[subpath]);

  let bestMatch: { key: string; prefixLength: number; value: unknown } | undefined;
  for (const key of keys) {
    if (!key.includes('*')) continue;
    if (!matchesWildcardPattern(key, subpath)) continue;
    // Node's own precedence: the longest PREFIX (the substring before `*`) wins; total key
    // length is only the tie-break when two patterns share a prefix length (e.g. `./foo/*` vs
    // `./foo/*-suffix`). Comparing by total key length alone (the earlier draft here) can pick a
    // less-specific pattern over a more-specific one whose suffix happens to be shorter.
    const prefixLength = key.indexOf('*');
    if (
      !bestMatch ||
      prefixLength > bestMatch.prefixLength ||
      (prefixLength === bestMatch.prefixLength && key.length > bestMatch.key.length)
    ) {
      bestMatch = { key, prefixLength, value: record[key] };
    }
  }
  return bestMatch !== undefined && resolvesToSomething(bestMatch.value);
}

/**
 * A valid `exports` pattern key contains exactly one `*` (Node rejects more than one); matches
 * when `subpath` shares its prefix and suffix. A key with a second `*` is not a valid pattern —
 * per Node's own `exports` resolution, it is never treated as a match, however superficially
 * similar its prefix/suffix might look, rather than silently matching on the first `*` alone.
 */
function matchesWildcardPattern(pattern: string, subpath: string): boolean {
  const starIndex = pattern.indexOf('*');
  if (starIndex === -1) return pattern === subpath;
  if (pattern.includes('*', starIndex + 1)) return false;
  const prefix = pattern.slice(0, starIndex);
  const suffix = pattern.slice(starIndex + 1);
  return (
    subpath.startsWith(prefix) &&
    subpath.endsWith(suffix) &&
    subpath.length >= prefix.length + suffix.length
  );
}

/** A resolved `exports` leaf resolves to something real when it is not `null` at every branch. */
function resolvesToSomething(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return true;
  if (Array.isArray(value)) return value.some((entry) => resolvesToSomething(entry));
  if (typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some((entry) =>
      resolvesToSomething(entry),
    );
  }
  return false;
}

async function readPackageDirectories(repositoryRoot: string): Promise<string[]> {
  const bunGlob = new Bun.Glob('packages/*/package.json');
  const relativePaths: string[] = [];
  for await (const relativePath of bunGlob.scan({
    cwd: repositoryRoot,
    onlyFiles: true,
    absolute: false,
  })) {
    if (relativePath.includes('node_modules/')) continue;
    relativePaths.push(dirname(relativePath));
  }
  return relativePaths.sort();
}

/** Loads every workspace package's `name`, directory, and raw `exports` field. */
export async function loadWorkspacePackages(repositoryRoot: string): Promise<WorkspacePackage[]> {
  const directories = await readPackageDirectories(repositoryRoot);
  const packages: WorkspacePackage[] = [];

  for (const directory of directories) {
    const raw: unknown = await Bun.file(resolve(repositoryRoot, directory, 'package.json')).json();
    if (typeof raw !== 'object' || raw === null) continue;
    const record = raw as Record<string, unknown>;
    if (!isNonEmptyString(record['name'])) continue;
    packages.push({ name: record['name'], directory, exportsField: record['exports'] });
  }

  return packages;
}

/** The `packages/<name>` prefix a repository-root-relative path lives under, or `undefined`. */
function packageDirectoryForPath(relativePath: string): string | undefined {
  const match = /^(packages\/[^/]+)\//.exec(relativePath);
  return match?.[1];
}

interface ParsedSpecifier {
  readonly packageName: string;
  readonly subpath: string;
}

/** Splits a bare (non-relative) module specifier into its package name and subpath (`.` when bare). */
function parseBareSpecifier(specifier: string): ParsedSpecifier | undefined {
  const scopedMatch = /^(@[^/]+\/[^/]+)(\/.*)?$/.exec(specifier);
  if (scopedMatch?.[1]) {
    return { packageName: scopedMatch[1], subpath: scopedMatch[2] ? `.${scopedMatch[2]}` : '.' };
  }
  const unscopedMatch = /^([^./][^/]*)(\/.*)?$/.exec(specifier);
  if (unscopedMatch?.[1]) {
    return {
      packageName: unscopedMatch[1],
      subpath: unscopedMatch[2] ? `.${unscopedMatch[2]}` : '.',
    };
  }
  return undefined;
}

interface ModuleSpecifierRecord {
  readonly specifier: string;
  readonly line: number;
}

/** Every static and dynamic import specifier in a source file, with its 1-indexed line. */
function findModuleSpecifiers(sourceFile: ts.SourceFile): ModuleSpecifierRecord[] {
  const results: ModuleSpecifierRecord[] = [];

  function recordSpecifier(node: ts.StringLiteralLike): void {
    const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
    results.push({ specifier: node.text, line });
  }

  function visit(node: ts.Node): void {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      recordSpecifier(node.moduleSpecifier);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      recordSpecifier(node.arguments[0]);
    } else if (
      // A type-only equivalent of a dynamic import — `type T = import('../x').T` — parses as an
      // `ImportTypeNode`, not a call expression, so it is invisible to the branch above even
      // though it reaches the same internal path.
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteralLike(node.argument.literal)
    ) {
      recordSpecifier(node.argument.literal);
    }
    node.forEachChild(visit);
  }

  visit(sourceFile);
  return results;
}

/**
 * Every cross-package import in one already-parsed test file that is NOT reachable through the
 * target package's declared `exports` map. Same-package imports, and imports of a package this
 * repository does not build as a workspace member (an external dependency), are never findings.
 */
export function findCrossPackageFindings(
  filePath: string,
  sourceFile: ts.SourceFile,
  packages: readonly WorkspacePackage[],
): CrossPackageFinding[] {
  const importingPackageDirectory = packageDirectoryForPath(filePath);
  if (!importingPackageDirectory) return [];
  const importingPackage = packages.find((pkg) => pkg.directory === importingPackageDirectory);
  if (!importingPackage) return [];

  const packagesByName = new Map(packages.map((pkg) => [pkg.name, pkg] as const));
  const findings: CrossPackageFinding[] = [];

  for (const { specifier, line } of findModuleSpecifiers(sourceFile)) {
    if (specifier.startsWith('.') || specifier.startsWith('/')) {
      const resolvedPath = resolve('/', dirname(filePath), specifier).slice(1);
      const resolvedDirectory = packageDirectoryForPath(resolvedPath);
      if (!resolvedDirectory || resolvedDirectory === importingPackageDirectory) continue;
      const targetPackage = packages.find((pkg) => pkg.directory === resolvedDirectory);
      if (!targetPackage) continue;

      // A relative import reaches the target package's file tree directly, bypassing its
      // `exports` map entirely at the LANGUAGE level — but the AC's predicate is whether the
      // PATH is reachable through the target's declared map, not whether this particular import
      // happened to use one. Compute the subpath a real consumer would have to name (relative to
      // the target package's own directory) and hold it to the exact same reachability check a
      // bare specifier gets: a package with no `exports` field is fully reachable either way
      // (confirmed inert for `integration`/`gateway`, the only two workspace packages with no
      // `exports` field, at review time — see the file header), while a declared map still blocks
      // an undeclared deep subpath even when reached by a relative path instead of a bare one.
      const relativeSubpath = relative(targetPackage.directory, resolvedPath);
      const subpath = relativeSubpath === '' ? '.' : `./${relativeSubpath}`;
      if (isSubpathReachable(targetPackage.exportsField, subpath)) continue;

      findings.push({
        importingFile: filePath,
        importingPackage: importingPackage.name,
        targetPackage: targetPackage.name,
        internalPath: subpath,
        line,
      });
      continue;
    }

    const parsed = parseBareSpecifier(specifier);
    if (!parsed) continue;
    const targetPackage = packagesByName.get(parsed.packageName);
    if (!targetPackage || targetPackage.directory === importingPackageDirectory) continue;
    if (isSubpathReachable(targetPackage.exportsField, parsed.subpath)) continue;

    findings.push({
      importingFile: filePath,
      importingPackage: importingPackage.name,
      targetPackage: targetPackage.name,
      internalPath: parsed.subpath,
      line,
    });
  }

  return findings;
}

/**
 * Pure evaluation: which findings are unpaired (their importing file names no manifest entry),
 * and which manifest entries name a `blackBoxTest` that resolves to no known test identifier.
 */
export function evaluateTestHelperParity(
  findings: readonly CrossPackageFinding[],
  manifest: AdapterSuiteManifest,
  /**
   * Only `it`/`test` CASE identifiers — a `describe` SUITE identifier alone must never satisfy a
   * `blackBoxTest`, since a suite name identifies no assertion that actually runs.
   */
  leafTestIdentifiers: ReadonlySet<string>,
): TestHelperParityCheckResult {
  const pairedAdapterSuites = new Set(manifest.entries.map((entry) => entry.adapterSuite));

  const violations: TestHelperParityViolation[] = findings
    .filter((finding) => !pairedAdapterSuites.has(finding.importingFile))
    .map((finding) => ({ ...finding, reason: 'unpaired-adapter-import' as const }));

  const brokenPairings: BrokenPairing[] = manifest.entries
    .filter((entry) => !leafTestIdentifiers.has(entry.blackBoxTest))
    .map((entry) => ({ adapterSuite: entry.adapterSuite, blackBoxTest: entry.blackBoxTest }));

  return { violations, brokenPairings };
}

export const REMEDIATION_SENTENCE =
  "either import through the package's exports map, or add an entry to scripts/adapter-suite-manifest.json naming the black-box test that proves the same guarantee publicly";

export function formatViolation(violation: TestHelperParityViolation): string {
  return (
    `${violation.importingFile}:${violation.line} — imports internal path "${violation.internalPath}" ` +
    `from package "${violation.targetPackage}": ${REMEDIATION_SENTENCE}`
  );
}

export function formatBrokenPairing(pairing: BrokenPairing): string {
  return (
    `scripts/adapter-suite-manifest.json names "${pairing.adapterSuite}" with blackBoxTest ` +
    `"${pairing.blackBoxTest}", which matches no test found in the repository`
  );
}

async function readTestFiles(repositoryRoot: string, glob: string): Promise<string[]> {
  const bunGlob = new Bun.Glob(glob);
  const relativePaths: string[] = [];
  for await (const relativePath of bunGlob.scan({
    cwd: repositoryRoot,
    onlyFiles: true,
    absolute: false,
  })) {
    if (relativePath.includes('node_modules/') || relativePath.includes('dist/')) continue;
    relativePaths.push(relativePath);
  }
  return relativePaths.sort();
}

/** End-to-end check for a repository root: scans every test file glob and evaluates the manifest. */
export async function checkTestHelperParity(
  repositoryRoot: string,
): Promise<TestHelperParityGateResult> {
  const [fileListsByGlob, packages, rawManifest] = await Promise.all([
    Promise.all(TEST_FILE_GLOBS.map((glob) => readTestFiles(repositoryRoot, glob))),
    loadWorkspacePackages(repositoryRoot),
    Bun.file(resolve(repositoryRoot, 'scripts/adapter-suite-manifest.json')).json(),
  ]);

  const manifest = parseAdapterSuiteManifest(rawManifest);
  const scannedFiles = [...new Set(fileListsByGlob.flat())].sort();

  const allFindings: CrossPackageFinding[] = [];
  // Only `it`/`test` CASE identifiers, never a `describe` SUITE identifier alone — a manifest
  // entry naming just a suite would assert nothing and must not satisfy a `blackBoxTest`.
  const leafTestIdentifiers = new Set<string>();

  for (const relativeFilePath of scannedFiles) {
    const sourceText = await readFile(resolve(repositoryRoot, relativeFilePath), 'utf-8');
    const sourceFile = ts.createSourceFile(
      relativeFilePath,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    allFindings.push(...findCrossPackageFindings(relativeFilePath, sourceFile, packages));
    const { leafTestIdentifiers: fileIdentifiers } = findSkipFindingsInSource(
      relativeFilePath,
      sourceText,
    );
    for (const identifier of fileIdentifiers) leafTestIdentifiers.add(identifier);
  }

  const { violations, brokenPairings } = evaluateTestHelperParity(
    allFindings,
    manifest,
    leafTestIdentifiers,
  );

  return { violations, brokenPairings, scannedFiles };
}

if (import.meta.main) {
  try {
    const repositoryRoot = resolve(import.meta.dir, '..');
    const result = await checkTestHelperParity(repositoryRoot);
    const messages = [
      ...result.violations.map(formatViolation),
      ...result.brokenPairings.map(formatBrokenPairing),
    ];

    if (messages.length > 0) {
      throw new Error(
        `Test-helper-parity gate failed:\n${messages.map((message) => `- ${message}`).join('\n')}`,
      );
    }

    console.log('✓ No unpaired internal-path test import or broken adapter-suite pairing found.');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`✖ ${message}`);
    process.exit(1);
  }
}
