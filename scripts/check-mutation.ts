#!/usr/bin/env bun
/**
 * Targeted lifecycle mutation check (AB-284).
 *
 * AB-92/AB-100 rule out a 100 percent mutation score and rule out mutating the whole
 * repository — line/function coverage already proves a branch RAN; it never proves a test
 * asserted its EFFECT. This script closes exactly that gap for the four narrow areas where an
 * executed-but-unasserted branch is most dangerous: lifecycle transition tables, cancellation
 * propagation, terminal-event uniqueness, and cleanup-ownership resolution — the four target
 * sets named in `scripts/mutation-targets.json`. Nothing outside that file is ever mutated.
 *
 * MUTATION OPERATORS (the complete, fixed set — no others are ever applied):
 *
 * 1. `negate-boolean-condition` — wraps an `if` statement's condition in `!(...)`, so the
 *    branch and its inverse swap. Applied to every `IfStatement` found in the target symbol's
 *    body.
 * 2. `swap-comparison-operator` — replaces a comparison operator with its logical opposite
 *    pairing: `===`/`!==`, `<`/`>=`, `>`/`<=`. Applied to every such `BinaryExpression`.
 * 3. `replace-returned-literal-with-default` — replaces a literal `return` value with its
 *    type's default (`''` for a string, `0` for a number, `false` for a boolean). Applied to
 *    every `ReturnStatement` whose expression is one of those literal kinds.
 * 4. `remove-statement` — deletes one `ExpressionStatement` (a bare call or assignment)
 *    entirely, OR a whole no-`else` guard clause (`if (cond) return;` / `if (cond) { return; }`)
 *    whose then-branch is exactly one `ReturnStatement`. Never applied to a declaration
 *    (`const`/`let`), which would produce a `ReferenceError` that reads as "killed" for the
 *    wrong reason — a guard clause is safe by the same test (it introduces no dangling
 *    reference, only a changed control-flow path). The guard-clause case is this issue's own
 *    confirm-the-mechanism finding: `ActiveRunLiveness.settle`'s `if (status === 'terminal')
 *    return;` guard, deleted by hand, survived its covering test even though negating or
 *    swapping that same condition is killed (both break `settle` outright; only outright removal
 *    leaves the guard's actual idempotency claim unobserved).
 *
 * WHY THE TYPESCRIPT COMPILER API. Matches `scripts/check-skip-manifest.ts`'s own rationale: a
 * regular expression or hand-rolled matcher over source text cannot reliably tell a real `if`
 * condition from one inside a string or comment, or find the exact node boundaries a text splice
 * needs. This is source-to-source text splicing driven by real AST node positions, not a
 * general-purpose mutation testing framework — no mutant scheduling, no coverage-guided test
 * selection, no report format beyond this script's own.
 *
 * WHY EVERY MUTANT REBUILDS ITS OWNING PACKAGE FIRST. A workspace import (e.g. `packages/
 * integration` importing `@lostgradient/operative`) resolves through that package's `exports`
 * map to `dist/`, never to `src/` (see `.claude/rules/monorepo-workflow.md`'s stale-dist guard,
 * added after AB-146 for exactly this class of false result). A mutant applied to `src/` is
 * invisible to any test running against a stale `dist/`, and reports every mutant "survived" for
 * a reason that has nothing to do with a missing assertion. So: a covering test that names
 * `rebuild` packages gets them rebuilt (`turbo run build --filter=<pkg>`) immediately before
 * that test runs, on the mutated source, every time — an in-package test (no `rebuild` entries)
 * skips this, since `bun test` resolves a relative import straight to `src/`.
 *
 * A surviving mutant is reported with the file, the symbol, the operator, the exact before/after
 * text, the line, and the test(s) that ran and passed anyway — enough to write the missing
 * assertion without rediscovering the mutation. Nothing is ever excluded to reduce a count: a
 * surviving mutant is either a missing assertion (a follow-up issue) or a genuinely equivalent
 * mutant, and the second case is recorded with its reason directly in `mutation-targets.json`,
 * never dropped silently.
 *
 * Usage:
 *   bun run check-mutation           # compares survivors against scripts/mutation-baseline.json
 *   bun run mutation:baseline        # regenerates the baseline from the current survivor counts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import ts from 'typescript';

const REPO_ROOT = resolve(import.meta.dir, '..');
const TARGETS_PATH = resolve(REPO_ROOT, 'scripts/mutation-targets.json');
const BASELINE_PATH = resolve(REPO_ROOT, 'scripts/mutation-baseline.json');

// ---------------------------------------------------------------------------
// Target and baseline shapes
// ---------------------------------------------------------------------------

export interface MutationTarget {
  readonly file: string;
  readonly symbol: string;
  readonly why: string;
  /** 1-based index disambiguating which same-named implementation to target, in source-order
   *  (the order `findSymbolBody`'s pre-order AST walk visits them), when `symbol` alone is
   *  ambiguous within the file — e.g. `execution-lifecycle.ts` declares both a per-execution
   *  `abort` closure and an unrelated bulk `abort(selector, ...)` method. Omit when `symbol` is
   *  unique in the file, which `findSymbolBody` still verifies on its own. */
  readonly occurrence?: number;
  /** Present only for a mutation deliberately not counted as a follow-up: a genuinely
   *  equivalent mutant, recorded here with its reason rather than silently excluded. */
  readonly equivalentMutants?: readonly { readonly operator: string; readonly reason: string }[];
}

export interface MutationTest {
  readonly path: string;
  /** Package names to `turbo run build --filter=<pkg>` before this test runs, because this
   *  test crosses a package boundary and resolves the mutated package through `dist/`. Empty
   *  or omitted for an in-package test, which resolves the mutated file's own `src/` directly. */
  readonly rebuild?: readonly string[];
  /** Forwarded to `bun test <path> --test-name-pattern <testNamePattern>` to scope a large
   *  shared test file down to the `it`/`describe` names that actually cover this target — "the
   *  tests that cover them," not every test in the file. Omit to run the whole file. */
  readonly testNamePattern?: string;
}

export interface MutationTargetSet {
  readonly name: string;
  readonly description: string;
  readonly targets: readonly MutationTarget[];
  readonly tests: readonly MutationTest[];
}

export interface MutationTargetsFile {
  readonly operators: readonly string[];
  readonly targetSets: readonly MutationTargetSet[];
}

export type MutationBaseline = Readonly<Record<string, number>>;

// ---------------------------------------------------------------------------
// Mutation candidates
// ---------------------------------------------------------------------------

export type MutationOperator =
  | 'negate-boolean-condition'
  | 'swap-comparison-operator'
  | 'replace-returned-literal-with-default'
  | 'remove-statement';

export interface MutationCandidate {
  readonly operator: MutationOperator;
  readonly start: number;
  readonly end: number;
  readonly originalText: string;
  readonly replacementText: string;
  readonly line: number;
}

const COMPARISON_SWAP: Readonly<Record<number, ts.SyntaxKind>> = {
  [ts.SyntaxKind.EqualsEqualsEqualsToken]: ts.SyntaxKind.ExclamationEqualsEqualsToken,
  [ts.SyntaxKind.ExclamationEqualsEqualsToken]: ts.SyntaxKind.EqualsEqualsEqualsToken,
  [ts.SyntaxKind.LessThanToken]: ts.SyntaxKind.GreaterThanEqualsToken,
  [ts.SyntaxKind.GreaterThanEqualsToken]: ts.SyntaxKind.LessThanToken,
  [ts.SyntaxKind.GreaterThanToken]: ts.SyntaxKind.LessThanEqualsToken,
  [ts.SyntaxKind.LessThanEqualsToken]: ts.SyntaxKind.GreaterThanToken,
};

const COMPARISON_TEXT: Readonly<Record<number, string>> = {
  [ts.SyntaxKind.EqualsEqualsEqualsToken]: '===',
  [ts.SyntaxKind.ExclamationEqualsEqualsToken]: '!==',
  [ts.SyntaxKind.LessThanToken]: '<',
  [ts.SyntaxKind.GreaterThanEqualsToken]: '>=',
  [ts.SyntaxKind.GreaterThanToken]: '>',
  [ts.SyntaxKind.LessThanEqualsToken]: '<=',
};

function scriptKindFor(filePath: string): ts.ScriptKind {
  return filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

/**
 * Locates the implementation node (one with a `Block` body) named `symbol` in `sourceText`. With
 * no `occurrence`, `symbol` must be unique in the file — 2+ matches throws rather than guessing.
 * With `occurrence` (1-based, in the pre-order AST-walk order matches are found), selects that
 * specific same-named implementation.
 */
export function findSymbolBody(
  sourceText: string,
  filePath: string,
  symbol: string,
  occurrence?: number,
): ts.Block {
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(filePath),
  );

  const matches: ts.Block[] = [];

  function visit(node: ts.Node): void {
    if (ts.isFunctionDeclaration(node) && node.name?.text === symbol && node.body) {
      matches.push(node.body);
    } else if (
      (ts.isMethodDeclaration(node) || ts.isFunctionExpression(node)) &&
      node.name &&
      ts.isIdentifier(node.name) &&
      node.name.text === symbol &&
      node.body
    ) {
      matches.push(node.body);
    } else if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === symbol &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) &&
      node.initializer.body &&
      ts.isBlock(node.initializer.body)
    ) {
      matches.push(node.initializer.body);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);

  if (matches.length === 0) {
    throw new Error(
      `No implementation of symbol "${symbol}" with a block body found in ${filePath}`,
    );
  }
  if (occurrence !== undefined) {
    const body = matches[occurrence - 1];
    if (!body) {
      throw new Error(
        `Symbol "${symbol}" occurrence ${occurrence} does not exist in ${filePath}: only ${matches.length} implementation(s) found.`,
      );
    }
    return body;
  }
  if (matches.length > 1) {
    throw new Error(
      `Symbol "${symbol}" is ambiguous in ${filePath}: ${matches.length} implementations found. Add "occurrence" to the target to disambiguate.`,
    );
  }
  const [body] = matches;
  if (!body) {
    throw new Error(
      `No implementation of symbol "${symbol}" with a block body found in ${filePath}`,
    );
  }
  return body;
}

/** True for `return;`/`return <expr>;` directly, or a `{ return; }`/`{ return <expr>; }` block
 *  containing exactly that one statement — the shape of a guard clause's then-branch. */
function isSingleReturnGuardBody(statement: ts.Statement): boolean {
  if (ts.isReturnStatement(statement)) return true;
  if (!ts.isBlock(statement) || statement.statements.length !== 1) return false;
  const only = statement.statements[0];
  return only !== undefined && ts.isReturnStatement(only);
}

function lineOf(sourceFile: ts.SourceFile, position: number): number {
  return sourceFile.getLineAndCharacterOfPosition(position).line + 1;
}

/** Walks `body` and collects every mutation candidate the four fixed operators can produce. */
export function collectMutationCandidates(
  sourceText: string,
  filePath: string,
  symbol: string,
  occurrence?: number,
): MutationCandidate[] {
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(filePath),
  );
  const target = findSymbolBody(sourceFile.getFullText(), filePath, symbol, occurrence);

  const candidates: MutationCandidate[] = [];

  function visit(node: ts.Node): void {
    if (ts.isIfStatement(node)) {
      const condition = node.expression;
      candidates.push({
        operator: 'negate-boolean-condition',
        start: condition.getStart(sourceFile),
        end: condition.getEnd(),
        originalText: condition.getText(sourceFile),
        replacementText: `!(${condition.getText(sourceFile)})`,
        line: lineOf(sourceFile, condition.getStart(sourceFile)),
      });
      // A guard clause — `if (cond) return;` / `if (cond) { return; }`, no `else` — is safe to
      // delete WHOLESALE the same way an `ExpressionStatement` is: it introduces no dangling
      // reference, only a changed control-flow path. Distinct from `negate-boolean-condition`
      // above (which flips when the guard fires) and worth its own candidate: this is exactly
      // the confirm-the-mechanism hand check's own finding (AB-284's own acceptance criteria) —
      // `ActiveRunLiveness.settle`'s `if (status === 'terminal') return;` guard, applied by hand,
      // survived its covering test even though negating/swapping that same condition is killed
      // (both break `settle` outright rather than leaving its terminal-once idempotency merely
      // unobserved).
      if (!node.elseStatement && isSingleReturnGuardBody(node.thenStatement)) {
        candidates.push({
          operator: 'remove-statement',
          start: node.getStart(sourceFile),
          end: node.getEnd(),
          originalText: node.getText(sourceFile),
          replacementText: '',
          line: lineOf(sourceFile, node.getStart(sourceFile)),
        });
      }
    } else if (ts.isBinaryExpression(node)) {
      const swapped = COMPARISON_SWAP[node.operatorToken.kind];
      if (swapped !== undefined) {
        const replacement = COMPARISON_TEXT[swapped];
        if (replacement !== undefined) {
          candidates.push({
            operator: 'swap-comparison-operator',
            start: node.operatorToken.getStart(sourceFile),
            end: node.operatorToken.getEnd(),
            originalText: node.operatorToken.getText(sourceFile),
            replacementText: replacement,
            line: lineOf(sourceFile, node.operatorToken.getStart(sourceFile)),
          });
        }
      }
    } else if (ts.isReturnStatement(node) && node.expression) {
      const expr = node.expression;
      let replacement: string | undefined;
      if (ts.isStringLiteralLike(expr)) {
        replacement = `''`;
      } else if (ts.isNumericLiteral(expr)) {
        replacement = '0';
      } else if (
        expr.kind === ts.SyntaxKind.TrueKeyword ||
        expr.kind === ts.SyntaxKind.FalseKeyword
      ) {
        replacement = 'false';
      }
      if (replacement !== undefined && replacement !== expr.getText(sourceFile)) {
        candidates.push({
          operator: 'replace-returned-literal-with-default',
          start: expr.getStart(sourceFile),
          end: expr.getEnd(),
          originalText: expr.getText(sourceFile),
          replacementText: replacement,
          line: lineOf(sourceFile, expr.getStart(sourceFile)),
        });
      }
    } else if (ts.isExpressionStatement(node)) {
      candidates.push({
        operator: 'remove-statement',
        start: node.getStart(sourceFile),
        end: node.getEnd(),
        originalText: node.getText(sourceFile),
        replacementText: '',
        line: lineOf(sourceFile, node.getStart(sourceFile)),
      });
    }
    ts.forEachChild(node, visit);
  }

  // Walk only inside the target symbol's own body.
  ts.forEachChild(target, visit);

  return candidates;
}

/** Applies one candidate to `sourceText`, returning the mutated text. Pure — no I/O. */
export function applyMutation(sourceText: string, candidate: MutationCandidate): string {
  return (
    sourceText.slice(0, candidate.start) +
    candidate.replacementText +
    sourceText.slice(candidate.end)
  );
}

// ---------------------------------------------------------------------------
// Baseline comparison
// ---------------------------------------------------------------------------

export interface BaselineComparison {
  readonly setName: string;
  readonly survivedCount: number;
  readonly baselineCount: number;
  readonly regressed: boolean;
  readonly improved: boolean;
}

export function compareToBaseline(
  setName: string,
  survivedCount: number,
  baseline: MutationBaseline,
): BaselineComparison {
  const baselineCount = baseline[setName] ?? 0;
  return {
    setName,
    survivedCount,
    baselineCount,
    regressed: survivedCount > baselineCount,
    improved: survivedCount < baselineCount,
  };
}

// ---------------------------------------------------------------------------
// Process execution (injectable for tests)
// ---------------------------------------------------------------------------

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type RunCommand = (command: readonly string[], cwd: string) => CommandResult;

// A mutation can defeat a guard that a covering test's `await` depends on and leave that test
// spinning in a genuine synchronous loop — not merely a slow one bun's own `--timeout` (which
// relies on the event loop turning over) can interrupt. Bounding the subprocess itself at the
// OS level is the only thing that reliably reclaims control from that case. This is not "raise a
// timeout to make a flaky suite pass" (forbidden by this project's own working agreements): a
// timeout firing here means the SUBPROCESS is killed and its non-zero (in fact absent) exit code
// is treated exactly like any other test failure — the mutant that caused it is KILLED, correctly,
// not silently passed. Every covering test this file's target sets name completes in low single-
// digit seconds unmutated (confirmed empirically per target set, including the rebuild step);
// 90 seconds is generous headroom above that, not a threshold tuned to make a hang look like a
// pass.
const SPAWN_TIMEOUT_MS = 90 * 1000;

export const spawnCommand: RunCommand = (command, cwd) => {
  const result = Bun.spawnSync(command as string[], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: SPAWN_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  });
  return {
    exitCode: result.exitCode ?? 1,
    stdout: result.stdout.toString('utf8'),
    stderr: result.stderr.toString('utf8'),
  };
};

export interface FileSystem {
  readFile: (path: string) => string;
  writeFile: (path: string, contents: string) => void;
}

export const realFileSystem: FileSystem = {
  readFile: (path) => readFileSync(path, 'utf8'),
  writeFile: (path, contents) => writeFileSync(path, contents),
};

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export interface SurvivedMutant {
  readonly setName: string;
  readonly file: string;
  readonly symbol: string;
  readonly operator: MutationOperator;
  readonly line: number;
  readonly originalText: string;
  readonly replacementText: string;
  readonly testsPassed: readonly string[];
  /** Set when the target's own `equivalentMutants` names this operator as a genuinely
   *  equivalent mutant (never a missing assertion) — carries the recorded reason so a survivor
   *  report distinguishes "write a follow-up assertion" from "this was already explained." Still
   *  counted in `survived`/the baseline: recorded, per this issue's own acceptance criteria,
   *  never silently excluded. */
  readonly equivalentReason?: string;
}

export interface RunOptions {
  readonly repoRoot: string;
  readonly runCommand: RunCommand;
  readonly fileSystem: FileSystem;
  /** Refuses to run against a git-dirty target file. Disabled only by fixture tests, where the
   *  fixture files under `scripts/fixtures/mutation/` are committed and never dirty in CI, but
   *  the check itself still doesn't need to shell out to `git` in a unit test. */
  readonly checkGitClean?: (filePath: string) => boolean;
}

export interface TargetSetResult {
  readonly setName: string;
  readonly survived: readonly SurvivedMutant[];
  readonly killedCount: number;
}

/**
 * Runs every test in `tests` (rebuilding first where declared) against the current file state.
 *
 * A rebuild failure is handled differently depending on `onBuildFailure`: during the pre-mutation
 * sanity pass (`'throw'`) a build failure against UNMUTATED source is a real problem the check
 * cannot proceed past, so it throws. During an actual mutant's run (`'kill'`) a rebuild failure
 * is itself evidence the mutation broke something a human would also have to fix — e.g. negating
 * `!runState` here can defeat a control-flow-narrowing guard TypeScript relies on at another call
 * site in the same file, turning a `RunState` into a type error a few hundred lines away — so it
 * counts as the mutant being killed (by the type system, not a test assertion) rather than
 * aborting the whole check.
 */
function runTests(
  options: RunOptions,
  tests: readonly MutationTest[],
  onBuildFailure: 'throw' | 'kill',
): { readonly allPassed: boolean; readonly passedPaths: readonly string[] } {
  const passedPaths: string[] = [];
  let allPassed = true;
  for (const test of tests) {
    let buildFailed = false;
    for (const pkg of test.rebuild ?? []) {
      const build = options.runCommand(
        ['bun', 'run', 'turbo', 'run', 'build', `--filter=${pkg}`],
        options.repoRoot,
      );
      if (build.exitCode !== 0) {
        if (onBuildFailure === 'throw') {
          throw new Error(
            `Failed to rebuild package "${pkg}" for test ${test.path}:\n${build.stderr}`,
          );
        }
        buildFailed = true;
        break;
      }
    }
    if (buildFailed) {
      allPassed = false;
      continue;
    }
    const command = test.testNamePattern
      ? ['bun', 'test', test.path, '--test-name-pattern', test.testNamePattern]
      : ['bun', 'test', test.path];
    const result = options.runCommand(command, options.repoRoot);
    if (result.exitCode === 0) {
      passedPaths.push(test.path);
    } else {
      allPassed = false;
    }
  }
  return { allPassed, passedPaths };
}

/** Runs the full mutation check for one target set, restoring every mutated file afterward. */
export function runTargetSet(options: RunOptions, set: MutationTargetSet): TargetSetResult {
  const survived: SurvivedMutant[] = [];
  let killedCount = 0;

  // Sanity: the covering tests must pass BEFORE any mutation, or a broken suite would report
  // every mutant "killed" or "survived" for a reason that has nothing to do with this check.
  const sanity = runTests(options, set.tests, 'throw');
  if (!sanity.allPassed) {
    throw new Error(
      `Target set "${set.name}": covering tests do not pass against unmutated source. Fix the suite before running the mutation check.`,
    );
  }

  const rebuildPackages = new Set<string>();
  for (const test of set.tests) for (const pkg of test.rebuild ?? []) rebuildPackages.add(pkg);

  try {
    for (const target of set.targets) {
      const absolutePath = resolve(options.repoRoot, target.file);
      if (options.checkGitClean && !options.checkGitClean(absolutePath)) {
        throw new Error(
          `Target file ${target.file} has uncommitted changes. Commit or discard them before running the mutation check.`,
        );
      }
      const originalText = options.fileSystem.readFile(absolutePath);
      const candidates = collectMutationCandidates(
        originalText,
        target.file,
        target.symbol,
        target.occurrence,
      );

      for (const candidate of candidates) {
        const mutatedText = applyMutation(originalText, candidate);
        options.fileSystem.writeFile(absolutePath, mutatedText);
        let result: { allPassed: boolean; passedPaths: readonly string[] };
        try {
          result = runTests(options, set.tests, 'kill');
        } finally {
          options.fileSystem.writeFile(absolutePath, originalText);
        }
        if (result.allPassed) {
          const equivalent = target.equivalentMutants?.find(
            (entry) => entry.operator === candidate.operator,
          );
          survived.push({
            setName: set.name,
            file: target.file,
            symbol: target.symbol,
            operator: candidate.operator,
            line: candidate.line,
            originalText: candidate.originalText,
            replacementText: candidate.replacementText,
            testsPassed: result.passedPaths,
            ...(equivalent ? { equivalentReason: equivalent.reason } : {}),
          });
        } else {
          killedCount += 1;
        }
      }
    }
  } finally {
    // Every mutant restores its own file before the next one, and rebuild-declaring tests
    // rebuild fresh before they run — but the LAST mutant to touch a rebuilt package leaves
    // `dist/` built from that mutant's source. One final rebuild after the whole target set
    // restores `dist/` to match the now fully-restored `src/`.
    for (const pkg of rebuildPackages) {
      options.runCommand(
        ['bun', 'run', 'turbo', 'run', 'build', `--filter=${pkg}`],
        options.repoRoot,
      );
    }
  }

  return { setName: set.name, survived, killedCount };
}

function gitIsClean(filePath: string): boolean {
  const result = spawnCommand(['git', 'status', '--porcelain', '--', filePath], REPO_ROOT);
  return result.stdout.trim().length === 0;
}

function loadTargets(): MutationTargetsFile {
  return JSON.parse(readFileSync(TARGETS_PATH, 'utf8')) as MutationTargetsFile;
}

function loadBaseline(): MutationBaseline {
  try {
    return JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as MutationBaseline;
  } catch {
    return {};
  }
}

function formatSurvivor(mutant: SurvivedMutant): string {
  return [
    `  [${mutant.setName}] ${mutant.file} :: ${mutant.symbol} (line ${mutant.line})`,
    `    operator: ${mutant.operator}`,
    `    mutation: ${JSON.stringify(mutant.originalText)} -> ${JSON.stringify(mutant.replacementText)}`,
    `    tests that ran and passed anyway: ${mutant.testsPassed.join(', ') || '(none declared)'}`,
    mutant.equivalentReason
      ? `    recorded as an equivalent mutant: ${mutant.equivalentReason}`
      : `    classification: missing assertion (write a follow-up, or record as equivalent in mutation-targets.json)`,
  ].join('\n');
}

async function main(): Promise<void> {
  const writeBaseline = process.argv.includes('--write-baseline');
  const targetsFile = loadTargets();
  const baseline = loadBaseline();

  const options: RunOptions = {
    repoRoot: REPO_ROOT,
    runCommand: spawnCommand,
    fileSystem: realFileSystem,
    checkGitClean: gitIsClean,
  };

  const results: TargetSetResult[] = [];
  for (const set of targetsFile.targetSets) {
    console.log(`Running mutation check for target set "${set.name}"...`);
    const result = runTargetSet(options, set);
    results.push(result);
    console.log(
      `  ${result.survived.length} survived, ${result.killedCount} killed, ${result.survived.length + result.killedCount} total mutants.`,
    );
  }

  if (writeBaseline) {
    const nextBaseline: Record<string, number> = {};
    for (const result of results) nextBaseline[result.setName] = result.survived.length;
    writeFileSync(BASELINE_PATH, `${JSON.stringify(nextBaseline, null, 2)}\n`);
    console.log(`Wrote ${BASELINE_PATH}`);
    return;
  }

  let failed = false;
  for (const result of results) {
    const comparison = compareToBaseline(result.setName, result.survived.length, baseline);
    if (comparison.regressed) {
      failed = true;
      console.error(
        `\nTarget set "${result.setName}" regressed: ${comparison.survivedCount} surviving mutants, baseline allows ${comparison.baselineCount}.`,
      );
    } else if (comparison.improved) {
      console.log(
        `\nTarget set "${result.setName}" improved: ${comparison.survivedCount} surviving mutants, baseline was ${comparison.baselineCount}. Run "bun run mutation:baseline" to lower it.`,
      );
    }
    // Printed at every count, not only on regression: a surviving mutant within budget is still
    // a missing assertion (or a recorded equivalent mutant) an author should be able to see
    // without first breaking the baseline.
    for (const mutant of result.survived) console.log(formatSurvivor(mutant));
  }

  if (failed) {
    process.exit(1);
  }
  console.log('\nMutation check passed: no target set exceeds its recorded baseline.');
}

if (import.meta.main) {
  await main();
}
