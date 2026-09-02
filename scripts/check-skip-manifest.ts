/**
 * Skip-manifest gate (AB-279).
 *
 * AB-92's decision record forbids a hidden skip from accumulating silently: every
 * `.skip`, `.todo`, `.only`, and structural early-return "skip" inside a test must be either
 * absent or declared, with an owner, a reason, an environment predicate, and a removal
 * condition, in `scripts/skip-manifest.json`. This script is that gate.
 *
 * WHY THE TYPESCRIPT COMPILER API, NOT REGULAR EXPRESSIONS. `scripts/documentation-examples.ts`
 * already establishes why: a call inside a string literal or a comment reads identically to real
 * code under a regular expression, and a hand-rolled matcher for nested member access and
 * argument lists accumulates false positives one edge case at a time. The TypeScript compiler is
 * already a root devDependency, so parsing every `*.test.ts` file into a real AST costs nothing
 * and removes the class of bug entirely.
 *
 * AST SHAPES MATCHED (also recorded in the pull request body per AB-279's acceptance criteria):
 *
 * - `describe`/`it`/`test`, called either as a bare identifier (`it(...)`) or through a single
 *   property access on that identifier (`it.skip(...)`, `test.only(...)`, `describe.todo(...)`).
 *   This is exactly AB-279's enumerated scope: `describe.skip`, `it.skip`, `test.skip`,
 *   `describe.todo`, `it.todo`, `test.todo`, and `.only` in those three forms, plus the
 *   conditional-return shape below — nothing more. bun:test's runtime API is WIDER than that
 *   list — it also exposes `.skip.each(...)`, `.only.each(...)`, `.skipIf(...)`, `.todoIf(...)`,
 *   and `.if(...)` (confirmed against the installed `bun@1.4.0` at review time; verify again
 *   against whatever version is installed before relying on this). `.skipIf`/`.todoIf` are not
 *   hypothetical: `packages/armorer/test/coding/grep.test.ts` and
 *   `packages/operative/test/package-exports.test.ts` each use `.skipIf` today, and this gate
 *   does not see either call. Deliberately out of scope per the acceptance criteria's literal
 *   enumeration, not because the deeper forms don't exist — recorded as a follow-up in the pull
 *   request body rather than silently expanding this issue's boundary.
 * - A conditional early return is a `ReturnStatement` that is either the first statement of an
 *   `IfStatement`'s `then` branch, or the first statement of a block that is that `then` branch,
 *   where the `IfStatement` itself is the first statement of an `it`/`test` callback's body.
 *   `describe` callbacks are not test bodies and are not scanned for this shape.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import ts from 'typescript';

export type SkipKind = 'skip' | 'todo' | 'only' | 'conditional-early-return';

export interface SkipFinding {
  readonly filePath: string;
  readonly testIdentifier: string;
  readonly kind: SkipKind;
  readonly line: number;
}

export interface SkipManifestEntry {
  readonly testIdentifier: string;
  readonly owner: string;
  readonly reason: string;
  readonly environmentPredicate: string;
  readonly removalCondition: string;
}

export interface SkipManifestViolation {
  readonly filePath: string;
  readonly testIdentifier: string;
  readonly kind: SkipKind;
  readonly line: number;
  readonly reason: 'unmanifested' | 'only-cannot-be-manifested';
}

export interface SkipManifestCheckResult {
  readonly violations: readonly SkipManifestViolation[];
  readonly orphanedEntries: readonly string[];
}

export interface SkipManifestGateResult extends SkipManifestCheckResult {
  /** Every file the repository-wide scan actually walked, relative to `repositoryRoot`, sorted. */
  readonly scannedFiles: readonly string[];
}

const TEST_CALL_NAMES = new Set(['describe', 'it', 'test']);
const SKIP_LIKE_PROPERTIES: Readonly<Record<string, SkipKind>> = {
  skip: 'skip',
  todo: 'todo',
  only: 'only',
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isSkipManifestEntry(value: unknown): value is SkipManifestEntry {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    isNonEmptyString(record.testIdentifier) &&
    isNonEmptyString(record.owner) &&
    isNonEmptyString(record.reason) &&
    isNonEmptyString(record.environmentPredicate) &&
    isNonEmptyString(record.removalCondition)
  );
}

/** Runtime shape guard for `scripts/skip-manifest.json` — no `as` cast past this point. */
export function parseSkipManifest(value: unknown): SkipManifestEntry[] {
  if (!Array.isArray(value) || !value.every(isSkipManifestEntry)) {
    throw new TypeError(
      'skip-manifest.json must be an array of {testIdentifier, owner, reason, environmentPredicate, removalCondition}, each a non-empty string',
    );
  }
  return value;
}

interface TestCallInfo {
  readonly rootName: string;
  readonly skipKind: SkipKind | undefined;
}

/** Recognizes `describe`/`it`/`test` called bare or through one `.skip`/`.todo`/`.only` property. */
function getTestCallInfo(node: ts.CallExpression): TestCallInfo | undefined {
  const { expression } = node;

  if (ts.isIdentifier(expression) && TEST_CALL_NAMES.has(expression.text)) {
    return { rootName: expression.text, skipKind: undefined };
  }

  if (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    TEST_CALL_NAMES.has(expression.expression.text) &&
    ts.isIdentifier(expression.name)
  ) {
    const skipKind = SKIP_LIKE_PROPERTIES[expression.name.text];
    return { rootName: expression.expression.text, skipKind };
  }

  return undefined;
}

function getTitleArgument(node: ts.CallExpression): string {
  const titleArgument = node.arguments[0];
  if (titleArgument && ts.isStringLiteralLike(titleArgument)) return titleArgument.text;
  return '<unnamed>';
}

function isFunctionLike(node: ts.Node): node is ts.ArrowFunction | ts.FunctionExpression {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node);
}

/** The first `ReturnStatement` of an `IfStatement`'s `then` branch, direct or one block deep. */
function ifThenStartsWithReturn(ifStatement: ts.IfStatement): boolean {
  const { thenStatement } = ifStatement;
  if (ts.isReturnStatement(thenStatement)) return true;
  if (ts.isBlock(thenStatement)) {
    const first = thenStatement.statements[0];
    return first !== undefined && ts.isReturnStatement(first);
  }
  return false;
}

/** A test callback whose body's first statement is an `IfStatement` starting with a return. */
function hasConditionalEarlyReturn(node: ts.CallExpression): boolean {
  const callback = node.arguments.find(isFunctionLike);
  if (!callback || !callback.body || !ts.isBlock(callback.body)) return false;
  const first = callback.body.statements[0];
  return first !== undefined && ts.isIfStatement(first) && ifThenStartsWithReturn(first);
}

/**
 * Walks one already-parsed source file, returning every skip-like finding and every
 * `describe`/`it`/`test` identifier seen (skip-like or not), the latter used to detect a manifest
 * entry that names no real test.
 */
export function findSkipFindings(
  filePath: string,
  sourceFile: ts.SourceFile,
): { findings: SkipFinding[]; allTestIdentifiers: Set<string> } {
  const findings: SkipFinding[] = [];
  const allTestIdentifiers = new Set<string>();

  function visit(node: ts.Node, describeChain: readonly string[]): void {
    if (ts.isCallExpression(node)) {
      const callInfo = getTestCallInfo(node);
      if (callInfo) {
        const title = getTitleArgument(node);
        const fullChain = [...describeChain, title];
        const testIdentifier = `${filePath} > ${fullChain.join(' > ')}`;
        allTestIdentifiers.add(testIdentifier);

        const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;

        if (callInfo.skipKind) {
          findings.push({ filePath, testIdentifier, kind: callInfo.skipKind, line });
        } else if (
          (callInfo.rootName === 'it' || callInfo.rootName === 'test') &&
          hasConditionalEarlyReturn(node)
        ) {
          findings.push({ filePath, testIdentifier, kind: 'conditional-early-return', line });
        }

        const nextChain = callInfo.rootName === 'describe' ? fullChain : describeChain;
        node.forEachChild((child) => visit(child, nextChain));
        return;
      }
    }
    node.forEachChild((child) => visit(child, describeChain));
  }

  visit(sourceFile, []);
  return { findings, allTestIdentifiers };
}

/** Convenience wrapper around {@link findSkipFindings} that parses source text first. */
export function findSkipFindingsInSource(
  filePath: string,
  sourceText: string,
): { findings: SkipFinding[]; allTestIdentifiers: Set<string> } {
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  return findSkipFindings(filePath, sourceFile);
}

/**
 * Pure evaluation: which findings are unmanifested violations (an `.only` is always a violation,
 * manifested or not), and which manifest entries name no test found anywhere in the scan.
 */
export function evaluateSkipManifest(
  findings: readonly SkipFinding[],
  allTestIdentifiers: ReadonlySet<string>,
  manifest: readonly SkipManifestEntry[],
): SkipManifestCheckResult {
  const manifestedIdentifiers = new Set(manifest.map((entry) => entry.testIdentifier));
  const violations: SkipManifestViolation[] = [];

  for (const finding of findings) {
    if (finding.kind === 'only') {
      violations.push({ ...finding, reason: 'only-cannot-be-manifested' });
      continue;
    }
    if (!manifestedIdentifiers.has(finding.testIdentifier)) {
      violations.push({ ...finding, reason: 'unmanifested' });
    }
  }

  const orphanedEntries = manifest
    .map((entry) => entry.testIdentifier)
    .filter((testIdentifier) => !allTestIdentifiers.has(testIdentifier));

  return { violations, orphanedEntries };
}

export function formatViolation(violation: SkipManifestViolation): string {
  const suffix =
    violation.reason === 'only-cannot-be-manifested'
      ? '.only cannot be manifested — it silently disables the rest of its file; remove it'
      : 'add an entry to scripts/skip-manifest.json with an owner, reason, environment predicate, and removal condition, or unskip the test';
  return `${violation.filePath}:${violation.line} — ${violation.testIdentifier} (${violation.kind}): ${suffix}`;
}

export function formatOrphanedEntry(testIdentifier: string): string {
  return `scripts/skip-manifest.json has an entry for "${testIdentifier}", which matches no test in the repository`;
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

/** End-to-end check for a repository root: scans every `*.test.ts` and evaluates the manifest. */
export async function checkSkipManifest(repositoryRoot: string): Promise<SkipManifestGateResult> {
  const [packageTestFiles, scriptTestFiles, rawManifest] = await Promise.all([
    readTestFiles(repositoryRoot, 'packages/**/*.test.ts'),
    readTestFiles(repositoryRoot, 'scripts/**/*.test.ts'),
    Bun.file(resolve(repositoryRoot, 'scripts/skip-manifest.json')).json(),
  ]);

  const manifest = parseSkipManifest(rawManifest);
  const scannedFiles = [...packageTestFiles, ...scriptTestFiles].sort();

  const allFindings: SkipFinding[] = [];
  const allTestIdentifiers = new Set<string>();

  for (const relativeFilePath of scannedFiles) {
    const sourceText = await readFile(resolve(repositoryRoot, relativeFilePath), 'utf-8');
    const { findings, allTestIdentifiers: fileIdentifiers } = findSkipFindingsInSource(
      relativeFilePath,
      sourceText,
    );
    allFindings.push(...findings);
    for (const identifier of fileIdentifiers) allTestIdentifiers.add(identifier);
  }

  const { violations, orphanedEntries } = evaluateSkipManifest(
    allFindings,
    allTestIdentifiers,
    manifest,
  );

  return { violations, orphanedEntries, scannedFiles };
}

if (import.meta.main) {
  try {
    const repositoryRoot = resolve(import.meta.dir, '..');
    const result = await checkSkipManifest(repositoryRoot);
    const messages = [
      ...result.violations.map(formatViolation),
      ...result.orphanedEntries.map(formatOrphanedEntry),
    ];

    if (messages.length > 0) {
      throw new Error(
        `Skip-manifest gate failed:\n${messages.map((message) => `- ${message}`).join('\n')}`,
      );
    }

    console.log('✓ No unmanifested skip, todo, only, or conditional early return found.');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`✖ ${message}`);
    process.exit(1);
  }
}
