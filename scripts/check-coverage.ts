import { rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { NIGHTLY_TEST_NAME_PATTERN } from './nightly-test-pattern.ts';

export type CoverageTotals = {
  functions: { covered: number; total: number };
  lines: { covered: number; total: number };
};

/**
 * The stage at which a `check-coverage.ts` run failed (AB-386). Printed in
 * every non-zero-exit reason so a failure names where it happened instead
 * of exiting silently.
 */
export type CoverageCheckStage = 'spawn' | 'test failure' | 'coverage parse' | 'threshold';

export type ChildProcessResult = {
  exitCode: number | null;
  signalCode: string | null;
  stdout: string;
  stderr: string;
};

/**
 * Runs `bun test --coverage` for one package and returns its result. Thrown
 * errors are treated as a failure to spawn the child process at all (the
 * `spawn` stage) — distinct from the child running and exiting non-zero
 * (the `test failure` stage).
 */
export type RunTestsWithCoverage = () => Promise<ChildProcessResult>;

export type ReadLcovReport = () => Promise<string>;

/**
 * Per-file coverage exclusions (AB-316). Every entry here is a `src/`-
 * relative path, scoped to a single named `package` so an unrelated
 * workspace package can never collide with the same relative path.
 *
 * These are gateway's Svelte UI files. `bun-plugin-svelte`'s `onLoad`
 * returns `{ contents: result.js.code }` for both `.svelte` (`compile`) and
 * `.svelte.[tj]s` (`compileModule`) — no `map` field — so Bun's coverage
 * instrumentation has no sourcemap to translate compiled-output positions
 * back to the original file. For `.svelte` files (which compile the
 * template into a wholly different server-render function body) this is
 * not a subtle drift: `src/ui/layout.svelte` is 157 source lines but its
 * lcov record carries `DA:` entries up to line 246 — physically impossible
 * to correspond to that file's own source. For `.svelte.ts` hook modules
 * (a lighter macro-expansion of `$state`/`$derived`, format mostly
 * preserved) the drift is smaller but still real: `use-runs.svelte.ts`,
 * `use-reviews.svelte.ts`, and `use-chat.svelte.ts` each report specific
 * lines uncovered that dedicated, passing tests exercise directly (proven
 * per-file — see each test file's tests asserting on exactly those
 * branches, e.g. `use-reviews.svelte.test.ts`'s "records the thrown error
 * message when refresh rejects with a network failure").
 *
 * A second, independent reason applies to the plain `.svelte` UI files:
 * this package's Svelte component tests render only through
 * `svelte/server` (`bunfig.toml`'s `svelte-preload.ts` compiles with
 * `side: 'server'`) — there is no DOM/mount harness (no happy-dom/jsdom,
 * no `@testing-library/svelte`) in the existing test setup. `$effect`
 * bodies, `onMount`, `bind:value`-driven client state (e.g.
 * `run-detail.svelte`'s event filter), and DOM event handlers (`onclick`,
 * `onapprove`, etc.) never execute under SSR-only rendering, matching the
 * AB-316 coordinator ruling's original exclusion case verbatim: "if a UI
 * file is genuinely untestable in Bun's runner."
 *
 * The root cause (no sourcemap from `bun-plugin-svelte`'s `onLoad`) is
 * filed upstream rather than worked around here.
 */
export function excludedFromCoverage(packageName: string | undefined): Set<string> {
  return new Set<string>(
    packageName === 'gateway'
      ? [
          // Sourcemap-less line misattribution (proven via dedicated passing
          // tests targeting the exact flagged lines/branches) — AB-316.
          'ui/hooks/use-runs.svelte.ts',
          'ui/hooks/use-reviews.svelte.ts',
          'ui/hooks/use-run-detail.svelte.ts',
          'ui/hooks/use-chat.svelte.ts',
          'ui/hooks/use-websocket.svelte.ts',
          'ui/pages/configuration.svelte',
          // Client-only: $effect/onMount/bind:value/DOM-event code with no
          // SSR-reachable path and no DOM test harness in this package — AB-316.
          'ui/app.svelte',
          'ui/layout.svelte',
          'ui/pages/chat.svelte',
          'ui/pages/reviews.svelte',
          'ui/components/review-row.svelte',
          // Both: the event-filter feature is client-only (`bind:value`, no
          // DOM harness) and the surrounding lines are sourcemap-misattributed
          // (`.svelte` `compile()` output, no map) — AB-316.
          'ui/pages/run-detail.svelte',
        ]
      : [],
  );
}

export type SourceFileContext = {
  packageRoot: string;
  sourceRoot: string;
};

export function isPackageSourceFile(filePath: string, context: SourceFileContext): boolean {
  if (filePath.includes(`${path.sep}coverage${path.sep}`)) return false;
  if (filePath.includes(`${path.sep}dist${path.sep}`)) return false;
  if (filePath.includes(`${path.sep}scripts${path.sep}`)) return false;
  if (filePath.endsWith('.test.ts')) return false;

  const absolutePath = path.resolve(context.packageRoot, filePath);
  const relativePath = path.relative(context.sourceRoot, absolutePath);

  return (
    !relativePath.startsWith('..') &&
    !path.isAbsolute(relativePath) &&
    (absolutePath === context.sourceRoot ||
      absolutePath.startsWith(`${context.sourceRoot}${path.sep}`))
  );
}

const NONNEGATIVE_INTEGER = /^\d+$/;

function parseCoverageCount(line: string, prefixLength: number, field: string): number {
  const text = line.slice(prefixLength);
  // `Number('')` is `0`, a finite number — a truncated record with a bare
  // `FNF:` counter would otherwise coerce to a silently "valid" zero
  // instead of the malformed-record failure it actually is. Require an
  // explicit nonnegative integer before coercing.
  if (!NONNEGATIVE_INTEGER.test(text)) {
    throw new Error(`Malformed lcov record: could not parse "${field}" from "${line}"`);
  }
  return Number(text);
}

/**
 * Parses an lcov report's text into package-scoped coverage totals. Throws
 * when a record's numeric fields are not parseable, which the caller
 * reports as a `coverage parse` stage failure (AB-386) rather than letting
 * silent `NaN` totals mask a corrupt report.
 */
export function parseCoverageTotals(
  lcovText: string,
  context: SourceFileContext & { excluded: Set<string> },
): CoverageTotals {
  const totals: CoverageTotals = {
    functions: { covered: 0, total: 0 },
    lines: { covered: 0, total: 0 },
  };

  for (const section of lcovText.split('end_of_record')) {
    const lines = section
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

    const sourceLine = lines.find((line) => line.startsWith('SF:'));
    if (!sourceLine) continue;

    const sourceFile = sourceLine.slice(3);
    if (!isPackageSourceFile(sourceFile, context)) continue;

    const relativeToSource = path.relative(
      context.sourceRoot,
      path.resolve(context.packageRoot, sourceFile),
    );
    if (context.excluded.has(relativeToSource.split(path.sep).join('/'))) continue;

    for (const line of lines) {
      if (line.startsWith('FNF:')) {
        totals.functions.total += parseCoverageCount(line, 4, 'FNF');
      } else if (line.startsWith('FNH:')) {
        totals.functions.covered += parseCoverageCount(line, 4, 'FNH');
      } else if (line.startsWith('LF:')) {
        totals.lines.total += parseCoverageCount(line, 3, 'LF');
      } else if (line.startsWith('LH:')) {
        totals.lines.covered += parseCoverageCount(line, 3, 'LH');
      }
    }
  }

  return totals;
}

export function formatPercentage(covered: number, total: number): string {
  if (total === 0) return '100.00';
  return ((covered / total) * 100).toFixed(2);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * One-line failure reason (AB-386): every non-zero exit names the package,
 * the stage it failed at, and the child process's exit code and signal, so
 * a failure can be diagnosed from the log instead of forcing a rerun.
 */
export function formatFailureReason(input: {
  packageName: string;
  stage: CoverageCheckStage;
  exitCode: number | null;
  signal: string | null;
  detail: string;
}): string {
  return `✖ ${input.packageName}: coverage check failed at stage "${input.stage}" (exit ${
    input.exitCode ?? 'null'
  }, signal ${input.signal ?? 'none'}): ${input.detail}`;
}

function tailLines(text: string, maxLines: number): string[] {
  const trimmed = text.replace(/\n+$/, '');
  return trimmed.length > 0 ? trimmed.split('\n').slice(-maxLines) : [];
}

/**
 * The raw tail of the child's stdout and stderr, printed when a passing
 * test run's coverage table cannot be parsed (AB-386) so the original
 * output survives even though it was captured rather than inherited (see
 * `createRealRunTestsWithCoverage`'s comment on why). Reported as two
 * separately labeled sections rather than one concatenated block: stdout
 * and stderr interleave arbitrarily and neither is guaranteed to end on a
 * line boundary, so joining them directly could merge the tail of one
 * stream into the head of the other on the same line.
 */
export function formatOutputTail(child: ChildProcessResult, maxLines = 40): string {
  const stdoutTail = tailLines(child.stdout, maxLines);
  const stderrTail = tailLines(child.stderr, maxLines);
  const sections: string[] = [];

  if (stdoutTail.length > 0) {
    sections.push(
      `--- child stdout tail (last ${stdoutTail.length} line(s)) ---\n${stdoutTail.join('\n')}`,
    );
  }
  if (stderrTail.length > 0) {
    sections.push(
      `--- child stderr tail (last ${stderrTail.length} line(s)) ---\n${stderrTail.join('\n')}`,
    );
  }

  return sections.length > 0
    ? sections.join('\n')
    : '--- child output tail (no output captured) ---';
}

export type CoverageCheckOptions = SourceFileContext & {
  packageName: string;
  excluded: Set<string>;
  runTestsWithCoverage: RunTestsWithCoverage;
  readLcovReport: ReadLcovReport;
  log: (message: string) => void;
  logError: (message: string) => void;
};

/**
 * Runs the full coverage gate for one package: spawn `bun test --coverage`,
 * require a clean exit, parse the resulting lcov report, and enforce the
 * 100 percent function/line threshold. Returns the process exit code
 * instead of calling `process.exit` so it can be exercised in tests
 * (AB-386).
 */
export async function runCoverageCheck(options: CoverageCheckOptions): Promise<number> {
  const {
    packageName,
    packageRoot,
    sourceRoot,
    excluded,
    runTestsWithCoverage,
    readLcovReport,
    log,
    logError,
  } = options;

  let child: ChildProcessResult;
  try {
    child = await runTestsWithCoverage();
  } catch (error) {
    logError(
      formatFailureReason({
        packageName,
        stage: 'spawn',
        exitCode: null,
        signal: null,
        detail: errorMessage(error),
      }),
    );
    return 1;
  }

  if (child.exitCode !== 0) {
    logError(
      formatFailureReason({
        packageName,
        stage: 'test failure',
        exitCode: child.exitCode,
        signal: child.signalCode,
        detail: 'bun test --coverage did not exit cleanly',
      }),
    );
    return child.exitCode ?? 1;
  }

  let lcovText: string;
  try {
    lcovText = await readLcovReport();
  } catch (error) {
    logError(
      formatFailureReason({
        packageName,
        stage: 'coverage parse',
        exitCode: child.exitCode,
        signal: child.signalCode,
        detail: errorMessage(error),
      }),
    );
    logError(formatOutputTail(child));
    return 1;
  }

  let totals: CoverageTotals;
  try {
    totals = parseCoverageTotals(lcovText, { packageRoot, sourceRoot, excluded });
  } catch (error) {
    logError(
      formatFailureReason({
        packageName,
        stage: 'coverage parse',
        exitCode: child.exitCode,
        signal: child.signalCode,
        detail: errorMessage(error),
      }),
    );
    logError(formatOutputTail(child));
    return 1;
  }

  const functionPercentage = formatPercentage(totals.functions.covered, totals.functions.total);
  const linePercentage = formatPercentage(totals.lines.covered, totals.lines.total);

  log(
    `Package-local coverage: functions ${functionPercentage}% (${totals.functions.covered}/${totals.functions.total}), lines ${linePercentage}% (${totals.lines.covered}/${totals.lines.total})`,
  );

  if (totals.functions.covered !== totals.functions.total) {
    logError(
      formatFailureReason({
        packageName,
        stage: 'threshold',
        exitCode: child.exitCode,
        signal: child.signalCode,
        detail: `function coverage ${functionPercentage}% is below 100.00%`,
      }),
    );
    return 1;
  }

  if (totals.lines.covered !== totals.lines.total) {
    logError(
      formatFailureReason({
        packageName,
        stage: 'threshold',
        exitCode: child.exitCode,
        signal: child.signalCode,
        detail: `line coverage ${linePercentage}% is below 100.00%`,
      }),
    );
    return 1;
  }

  return 0;
}

/**
 * Tees a child process stream to the parent's matching stream (so output
 * keeps appearing live, exactly as it did under the old `stdio: 'inherit'`)
 * while also buffering it, so the coordinator ruling's "print the raw tail
 * of the child's output" requirement has something to print from even
 * though the stream was captured rather than inherited.
 */
async function teeToParentAndBuffer(
  stream: ReadableStream<Uint8Array> | undefined,
  parentStream: typeof process.stdout | typeof process.stderr,
): Promise<string> {
  if (!stream) return '';

  const decoder = new TextDecoder();
  let buffered = '';

  for await (const chunk of stream) {
    const text = decoder.decode(chunk, { stream: true });
    parentStream.write(text);
    buffered += text;
  }

  return buffered;
}

/**
 * Spawns `command`, streaming its stdout/stderr live to the parent's own
 * streams as they arrive (so a long-running child still shows progress)
 * while also buffering both for the returned `ChildProcessResult`.
 *
 * `child.exited` only signals that the process has finished; its resolved
 * value is a shell-style status (e.g. 143 for SIGTERM), not this
 * function's `exitCode` contract. `child.exitCode` and `child.signalCode`
 * are read only after `exited` resolves — Bun leaves `exitCode` `null` for
 * a signal-terminated child, which `runCoverageCheck`'s `test failure`
 * stage depends on to report the signal rather than a fabricated code.
 */
export async function spawnAndCollect(
  command: string[],
  options: { cwd: string },
): Promise<ChildProcessResult> {
  const child = Bun.spawn(command, {
    cwd: options.cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [stdout, stderr] = await Promise.all([
    teeToParentAndBuffer(child.stdout, process.stdout),
    teeToParentAndBuffer(child.stderr, process.stderr),
  ]);
  await child.exited;

  return {
    exitCode: child.exitCode,
    signalCode: child.signalCode ?? null,
    stdout,
    stderr,
  };
}

/**
 * Real `bun test --coverage` runner (AB-386).
 */
export function createRealRunTestsWithCoverage(options: {
  packageRoot: string;
  coverageDirectory: string;
}): RunTestsWithCoverage {
  return () =>
    spawnAndCollect(
      [
        'bun',
        'test',
        '--coverage',
        '--coverage-reporter=lcov',
        '--coverage-dir',
        options.coverageDirectory,
        // Mirror the pull-request lane's exclusion (AB-275, AB-356): this
        // script invokes `bun test --coverage` directly rather than through
        // a package's filtered `test` script, so without this flag it
        // would separately re-execute nightly-tagged scenarios (e.g.
        // gateway's restart-and-replay conformance test) on every
        // `bun run coverage:check`.
        '--test-name-pattern',
        NIGHTLY_TEST_NAME_PATTERN,
      ],
      { cwd: options.packageRoot },
    );
}

if (import.meta.main) {
  const packageRoot = process.cwd();
  const sourceRoot = path.resolve(packageRoot, 'src');
  const coverageDirectory = path.resolve(packageRoot, 'coverage');
  const lcovPath = path.join(coverageDirectory, 'lcov.info');
  const packageJson = JSON.parse(
    await readFile(path.join(packageRoot, 'package.json'), 'utf8'),
  ) as {
    name?: string;
  };
  const packageName = packageJson.name ?? path.basename(packageRoot);

  rmSync(coverageDirectory, { recursive: true, force: true });

  const exitCode = await runCoverageCheck({
    packageName,
    packageRoot,
    sourceRoot,
    excluded: excludedFromCoverage(packageJson.name),
    runTestsWithCoverage: createRealRunTestsWithCoverage({ packageRoot, coverageDirectory }),
    readLcovReport: () => readFile(lcovPath, 'utf8'),
    log: (message) => console.log(message),
    logError: (message) => console.error(message),
  });

  process.exit(exitCode);
}
