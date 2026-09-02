/**
 * Skip-manifest gate (AB-279).
 *
 * AB-92's decision record forbids a hidden skip from accumulating silently: every
 * `.skip`, `.todo`, `.only`, and structural early-return "skip" inside a test must be either
 * absent or declared, with an owner, a reason, an environment predicate, and a removal
 * condition, in `scripts/skip-manifest.json`. This script is that gate.
 *
 * WHY THE TYPESCRIPT COMPILER API, NOT REGULAR EXPRESSIONS. `scripts/documentation-examples.test.ts`
 * already establishes why: a call inside a string literal or a comment reads identically to real
 * code under a regular expression, and a hand-rolled matcher for nested member access and
 * argument lists accumulates false positives one edge case at a time. The TypeScript compiler is
 * already a root devDependency, so parsing every `*.test.ts` file into a real AST costs nothing
 * and removes the class of bug entirely.
 *
 * AST SHAPES MATCHED (also recorded in the pull request body per AB-279's acceptance criteria):
 *
 * - `describe`/`it`/`test`, called bare (`it(...)`), through one `.skip`/`.todo`/`.only`
 *   property access (`it.skip(...)`, `test.only(...)`, `describe.todo(...)`), through a
 *   parameterized `.each(...)(...)` invocation, or through `.skip.each(...)(...)` /
 *   `.only.each(...)(...)`. `resolveTestRoot` walks the callee chain (identifier → optional
 *   property accesses → optional wrapping call, for `.each`'s two-call shape) to the root
 *   `describe`/`it`/`test` identifier; a call only counts as a genuine test declaration — one
 *   this gate reports on or adds to `allTestIdentifiers` — when it also passes a function-like
 *   argument, which is what distinguishes the real declaration (`it.each(data)('title', fn)`)
 *   from the intermediate factory call (`it.each(data)`, no callback yet) that produced it.
 * - `.only` in any of `describe.only`/`it.only`/`test.only`, plain or `.each`-chained, always
 *   fails — the acceptance criteria's enumerated scope. `.skip`/`.todo` and their `.each` forms
 *   are manifestable.
 * - Deliberately still out of scope, verified against the installed `bun@1.4.0` at review time
 *   (verify again against whatever version is installed before relying on this): `.skipIf(...)`
 *   and `.todoIf(...)`. Not hypothetical — `packages/armorer/test/coding/grep.test.ts` and
 *   `packages/operative/test/package-exports.test.ts` each use `.skipIf` today. A `.skipIf`/
 *   `.todoIf` call resolves through `resolveTestRoot` like any other modifier, so it IS scanned
 *   for a conditional early return and DOES contribute its identifier to `allTestIdentifiers` (no
 *   false "orphan" if it is ever named in the manifest) — it just never resolves to a `skip`/
 *   `todo`/`only` finding, because `skipIf`/`todoIf` are not in `SKIP_LIKE_PROPERTIES`. Recorded
 *   as a follow-up in the pull request body rather than silently expanding this issue's scope.
 * - Also out of scope: `*.test.mjs` files (e.g. `packages/integration/test/runtime.test.mjs`,
 *   run through `node --test`, not `bun:test`). The acceptance criteria's scan glob is literally
 *   `*.test.ts`; `node:test`'s API is close enough to `bun:test`'s that a `.mjs` scan is a
 *   plausible future extension, but a different module system and potentially different AST
 *   shapes make it a real, separate slice rather than a one-line glob change.
 * - A conditional early return is a `ReturnStatement` that is either the first statement of an
 *   `IfStatement`'s `then` branch, or the first statement of a block that is that `then` branch,
 *   where the `IfStatement` itself is the first statement of an `it`/`test` (not `describe`)
 *   callback's body — including the callback of an `.each`-chained `it`/`test`.
 * - A finding's `testIdentifier` embeds the declaration's 1-indexed source line whenever its
 *   title is not a plain string literal (`<unnamed:LINE>`), rather than a shared `<unnamed>`
 *   token. Two dynamically-titled or `.each`-templated declarations in the same file would
 *   otherwise collapse onto one identifier, letting one manifest entry silently authorize both.
 *   This does not fully close the gap for two *literal, identical* titles under the same
 *   `describe` chain — the acceptance criteria defines `testIdentifier` as "file path plus the
 *   full test name," which has no room for a positional discriminator on an otherwise-legitimate
 *   duplicate literal name; treated as an accepted limitation of that definition, not a bug.
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

interface TestRoot {
  readonly rootName: string;
  /** Every property name walked from the root, in order, e.g. `['skip']` or `['only', 'each']`. */
  readonly modifiers: readonly string[];
}

/**
 * Walks a callee expression back to its root `describe`/`it`/`test` identifier, following
 * property accesses (`.skip`, `.each`, …) and — because `.each(...)` returns a function you then
 * call again — transparently through one layer of wrapping `CallExpression` (`it.each(data)` as
 * the callee of the outer `it.each(data)('title', fn)`). Returns `undefined` for anything that
 * does not bottom out at `describe`/`it`/`test`.
 */
function resolveTestRoot(expression: ts.Expression): TestRoot | undefined {
  if (ts.isIdentifier(expression)) {
    return TEST_CALL_NAMES.has(expression.text)
      ? { rootName: expression.text, modifiers: [] }
      : undefined;
  }
  if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.name)) {
    const base = resolveTestRoot(expression.expression);
    if (!base) return undefined;
    return { rootName: base.rootName, modifiers: [...base.modifiers, expression.name.text] };
  }
  if (ts.isCallExpression(expression)) {
    return resolveTestRoot(expression.expression);
  }
  return undefined;
}

interface TestCallInfo {
  readonly rootName: string;
  readonly skipKind: SkipKind | undefined;
}

/**
 * A `CallExpression` counts as a genuine test declaration — not merely a `.each`/`.skipIf`
 * factory call that has not been invoked with a callback yet — only once it both resolves to a
 * `describe`/`it`/`test` root and carries a function-like argument. That second condition is what
 * tells `it.each(data)('title', fn)` (a declaration) apart from `it.each(data)` alone (not one).
 */
function getTestCallInfo(node: ts.CallExpression): TestCallInfo | undefined {
  const root = resolveTestRoot(node.expression);
  if (!root) return undefined;
  if (!node.arguments.some(isFunctionLike)) return undefined;

  const skipKinds = root.modifiers
    .map((modifier) => SKIP_LIKE_PROPERTIES[modifier])
    .filter((kind): kind is SkipKind => kind !== undefined);

  return { rootName: root.rootName, skipKind: skipKinds[0] };
}

function getTitleArgument(node: ts.CallExpression, sourceFile: ts.SourceFile): string {
  const titleArgument = node.arguments[0];
  if (titleArgument && ts.isStringLiteralLike(titleArgument)) return titleArgument.text;
  const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  return `<unnamed:${line}>`;
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
        const title = getTitleArgument(node, sourceFile);
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
