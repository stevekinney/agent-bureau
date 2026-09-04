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
 * already a root devDependency, so parsing every `*.test.ts`, `*.test.mjs`, and `*.test.js` file
 * into a real AST costs nothing and removes the class of bug entirely.
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
 * - AB-293 extended the scan glob to `*.test.mjs` and `*.test.js` under `packages/` and
 *   `scripts/` (e.g. `packages/integration/test/runtime.test.mjs`, run through `node --test`).
 *   `node:test`'s `describe`/`it`/`test`/`.skip`/`.todo`/`.only` surface is lexically identical
 *   to `bun:test`'s, so the same AST matcher applies; the only difference is the parser's
 *   `ScriptKind` (`JS` for `.mjs`/`.js`, `TS` for `.ts` — see `scriptKindForFilePath`), since a
 *   `.mjs`/`.js` file is never itself TypeScript syntax.
 * - AB-293 also resolved two patterns that used to be out of scope, both against real fixtures
 *   under `scripts/fixtures/skip-manifest/`, because the repository-wide `git grep` re-run at
 *   that issue's start still showed zero live hits for either (checked with
 *   `git grep -nE "\\b(it|test)\\(['"][^'"]*['"]\\s*,\\s*[A-Za-z_][A-Za-z0-9_]*\\s*\\)"` and
 *   `git grep -nE "import \\{[^}]*\\b(it|test|describe) as \\w+"`, each run separately against
 *   `packages/**\/*.test.ts`, `packages/**\/*.test.mjs`, `packages/**\/*.test.js`,
 *   `scripts/*.test.ts`, `scripts/*.test.mjs`, and `scripts/*.test.js` — every combination zero
 *   hits, so this closed a real boundary rather than a live gap):
 *   - An aliased import — `import { it as spec } from 'bun:test'` (or `'node:test'`) —
 *     `spec.skip(...)` now resolves back to `it`. `collectTestImportAliases` builds a
 *     local-name → canonical-name map from every top-level `ImportDeclaration` whose module
 *     specifier is exactly `'bun:test'` or `'node:test'`, for `describe`/`it`/`test` import
 *     specifiers only; `resolveTestRoot` consults it before falling back to `TEST_CALL_NAMES`.
 *     An alias from any other module is deliberately not resolved — a same-named import from an
 *     unrelated package is not a test declaration just because it shares a name.
 *   - A callback passed by reference — `it('case', someNamedFunction)` — is now inspected at
 *     `someNamedFunction`'s own declaration site. `collectFunctionBindings` walks the entire file
 *     once, before any test-call matching, recording every named `function someNamedFunction() {}`
 *     declaration and every `const someNamedFunction = () => {}` / `= function () {}` variable
 *     initializer found anywhere in the tree, by name. `resolveCallback` then accepts a test
 *     call's callback argument either directly (an inline arrow/function expression, at any
 *     argument index, as before) or, when the argument at index 1 or later is a bare `Identifier`,
 *     by looking that name up in the bindings map — the resolved function-like node is then the
 *     one `hasConditionalEarlyReturn` inspects and the one whose presence makes the call a genuine
 *     declaration (`.each`-style factory calls with no callback at all still are not). By-reference
 *     resolution is deliberately withheld from argument index 0 — the title slot in a genuine
 *     declaration, but also the sole argument of an intermediate factory call like
 *     `it.skipIf(shouldSkip)` — so that factory call's own by-reference argument is never
 *     mistaken for the test's callback; see the comment on `resolveCallback` for the concrete
 *     false-positive this closes. A callback that is a `PropertyAccessExpression` (`obj.method`)
 *     or otherwise not a bare identifier is still not resolved — narrowly matching the acceptance
 *     criteria's stated shape (`it('case', someNamedFunction)`) rather than reaching for full
 *     symbol resolution. Known limitation: `describe('suite', suiteBody)` — a `describe` callback
 *     passed by reference — resolves `suiteBody` for the purposes of counting it as a genuine
 *     declaration, but `findSkipFindings`'s `describeChain` is built by walking the call node's
 *     own children, not the resolved declaration's, so any `it`/`test` nested inside `suiteBody`
 *     does not get that describe title prefixed onto its identifier. Outside this issue's stated
 *     shape (`it('case', someNamedFunction)`), so not fixed here.
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
const TEST_MODULE_SPECIFIERS = new Set(['bun:test', 'node:test']);
const SKIP_LIKE_PROPERTIES: Readonly<Record<string, SkipKind>> = {
  skip: 'skip',
  todo: 'todo',
  only: 'only',
};

/** Every `describe`/`it`/`test`-shaped callback declared by name, keyed by its local identifier. */
type FunctionLikeDeclaration = ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration;

function isFunctionLike(node: ts.Node): node is FunctionLikeDeclaration {
  return (
    ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node)
  );
}

/**
 * Maps a local import binding back to the canonical `describe`/`it`/`test` name it aliases, for
 * every `import { it as spec } from 'bun:test'`-shaped specifier at the top level of the file.
 * Only `bun:test` and `node:test` module specifiers are consulted, and only for
 * `describe`/`it`/`test` specifiers — an alias of a same-named import from an unrelated module is
 * deliberately not resolved.
 */
function collectTestImportAliases(sourceFile: ts.SourceFile): ReadonlyMap<string, string> {
  const aliases = new Map<string, string>();

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (!TEST_MODULE_SPECIFIERS.has(statement.moduleSpecifier.text)) continue;

    const namedBindings = statement.importClause?.namedBindings;
    if (!namedBindings || !ts.isNamedImports(namedBindings)) continue;

    for (const specifier of namedBindings.elements) {
      if (!specifier.propertyName) continue; // not aliased
      const canonicalName = specifier.propertyName.text;
      if (!TEST_CALL_NAMES.has(canonicalName)) continue;
      aliases.set(specifier.name.text, canonicalName);
    }
  }

  return aliases;
}

/**
 * Maps every named, function-like declaration reachable anywhere in the file — a
 * `function someName() {}` declaration or a `const someName = () => {}` / `= function () {}`
 * variable initializer — to its declaration node, so a callback passed by reference
 * (`it('case', someName)`) can be resolved to the place its body actually lives.
 */
function collectFunctionBindings(
  sourceFile: ts.SourceFile,
): ReadonlyMap<string, FunctionLikeDeclaration> {
  const bindings = new Map<string, FunctionLikeDeclaration>();

  function visit(node: ts.Node): void {
    if (ts.isFunctionDeclaration(node) && node.name) {
      bindings.set(node.name.text, node);
    } else if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      isFunctionLike(node.initializer)
    ) {
      bindings.set(node.name.text, node.initializer);
    }
    node.forEachChild(visit);
  }

  visit(sourceFile);
  return bindings;
}

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
function resolveTestRoot(
  expression: ts.Expression,
  importAliases: ReadonlyMap<string, string>,
): TestRoot | undefined {
  if (ts.isIdentifier(expression)) {
    const canonicalName = importAliases.get(expression.text) ?? expression.text;
    return TEST_CALL_NAMES.has(canonicalName)
      ? { rootName: canonicalName, modifiers: [] }
      : undefined;
  }
  if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.name)) {
    const base = resolveTestRoot(expression.expression, importAliases);
    if (!base) return undefined;
    return { rootName: base.rootName, modifiers: [...base.modifiers, expression.name.text] };
  }
  if (ts.isCallExpression(expression)) {
    return resolveTestRoot(expression.expression, importAliases);
  }
  return undefined;
}

interface TestCallInfo {
  readonly rootName: string;
  readonly skipKind: SkipKind | undefined;
  /** The resolved callback body — inline, or looked up by reference. */
  readonly callback: FunctionLikeDeclaration;
}

/**
 * Resolves a test call's callback argument to the function-like node whose body should actually
 * be inspected: an inline arrow/function expression argument, as before, or — when the argument
 * is a bare `Identifier` — that name looked up in `functionBindings`, resolving a callback passed
 * by reference (`it('case', someName)`) to `someName`'s own declaration site. Anything else (a
 * property access, a call expression, …) is not resolved.
 */
function resolveCallback(
  node: ts.CallExpression,
  functionBindings: ReadonlyMap<string, FunctionLikeDeclaration>,
): FunctionLikeDeclaration | undefined {
  for (const [index, argument] of node.arguments.entries()) {
    if (isFunctionLike(argument)) return argument;
    // By-reference resolution is deliberately restricted to argument index >= 1 (after the title
    // slot in a real `it('title', callback)`/`it.each(data)('title', callback)` declaration).
    // Without this bound, an *intermediate* factory call such as `it.skipIf(shouldSkip)` — whose
    // sole argument at index 0 is itself a by-reference identifier, not a title — would resolve
    // `shouldSkip` as if it were the test's callback and misreport a false conditional-early-return
    // finding for `shouldSkip`'s own body, on a call node that is not a genuine test declaration at
    // all (confirmed with `it.skipIf(shouldSkip)('real title', () => {...})` before this guard).
    if (index >= 1 && ts.isIdentifier(argument)) {
      const bound = functionBindings.get(argument.text);
      if (bound) return bound;
    }
  }
  return undefined;
}

/**
 * A `CallExpression` counts as a genuine test declaration — not merely a `.each`/`.skipIf`
 * factory call that has not been invoked with a callback yet — only once it both resolves to a
 * `describe`/`it`/`test` root and carries a resolvable callback (inline or by reference). That
 * second condition is what tells `it.each(data)('title', fn)` (a declaration) apart from
 * `it.each(data)` alone (not one).
 */
function getTestCallInfo(
  node: ts.CallExpression,
  importAliases: ReadonlyMap<string, string>,
  functionBindings: ReadonlyMap<string, FunctionLikeDeclaration>,
): TestCallInfo | undefined {
  const root = resolveTestRoot(node.expression, importAliases);
  if (!root) return undefined;
  const callback = resolveCallback(node, functionBindings);
  if (!callback) return undefined;

  const skipKinds = root.modifiers
    .map((modifier) => SKIP_LIKE_PROPERTIES[modifier])
    .filter((kind): kind is SkipKind => kind !== undefined);

  return { rootName: root.rootName, skipKind: skipKinds[0], callback };
}

function getTitleArgument(node: ts.CallExpression, sourceFile: ts.SourceFile): string {
  const titleArgument = node.arguments[0];
  if (titleArgument && ts.isStringLiteralLike(titleArgument)) return titleArgument.text;
  const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  return `<unnamed:${line}>`;
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

/**
 * A resolved callback whose body's first statement is an `IfStatement` starting with a return.
 * `callback` is already resolved by {@link resolveCallback} — inline or by reference — so this is
 * agnostic to which of those two shapes produced it.
 */
function hasConditionalEarlyReturn(callback: FunctionLikeDeclaration): boolean {
  if (!callback.body || !ts.isBlock(callback.body)) return false;
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
  const importAliases = collectTestImportAliases(sourceFile);
  const functionBindings = collectFunctionBindings(sourceFile);

  function visit(node: ts.Node, describeChain: readonly string[]): void {
    if (ts.isCallExpression(node)) {
      const callInfo = getTestCallInfo(node, importAliases, functionBindings);
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
          hasConditionalEarlyReturn(callInfo.callback)
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

/**
 * A `.mjs`/`.js` file is plain JavaScript, never TypeScript syntax; a `.ts` file (including a
 * fixture with no real extension in its own name, loaded here under a `.ts` `filePath`, as
 * `scripts/check-skip-manifest.test.ts` does) is parsed as TypeScript. Anything else defaults to
 * `TS`, matching this script's own historical behavior before AB-293 introduced the JS glob.
 */
function scriptKindForFilePath(filePath: string): ts.ScriptKind {
  return filePath.endsWith('.mjs') || filePath.endsWith('.js')
    ? ts.ScriptKind.JS
    : ts.ScriptKind.TS;
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
    scriptKindForFilePath(filePath),
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

/**
 * Every glob this gate scans, relative to the repository root. `*.test.mjs` and `*.test.js` were
 * added by AB-293 alongside the pre-existing `*.test.ts`, so a `node:test` suite such as
 * `packages/integration/test/runtime.test.mjs` is no longer invisible to the gate.
 */
const TEST_FILE_GLOBS: readonly string[] = [
  'packages/**/*.test.ts',
  'packages/**/*.test.mjs',
  'packages/**/*.test.js',
  'scripts/**/*.test.ts',
  'scripts/**/*.test.mjs',
  'scripts/**/*.test.js',
];

/** End-to-end check for a repository root: scans every test file glob and evaluates the manifest. */
export async function checkSkipManifest(repositoryRoot: string): Promise<SkipManifestGateResult> {
  const [fileListsByGlob, rawManifest] = await Promise.all([
    Promise.all(TEST_FILE_GLOBS.map((glob) => readTestFiles(repositoryRoot, glob))),
    Bun.file(resolve(repositoryRoot, 'scripts/skip-manifest.json')).json(),
  ]);

  const manifest = parseSkipManifest(rawManifest);
  const scannedFiles = [...new Set(fileListsByGlob.flat())].sort();

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
