import { describe, expect, test } from 'bun:test';

import {
  type ChildProcessResult,
  excludedFromCoverage,
  formatFailureReason,
  formatOutputTail,
  formatPercentage,
  isPackageSourceFile,
  parseCoverageTotals,
  runCoverageCheck,
} from './check-coverage';

const packageRoot = '/repo/packages/example';
const sourceRoot = '/repo/packages/example/src';

function createChildResult(overrides: Partial<ChildProcessResult> = {}): ChildProcessResult {
  return {
    exitCode: 0,
    signalCode: null,
    stdout: '',
    stderr: '',
    ...overrides,
  };
}

function createLogs() {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    logs,
    errors,
    log: (message: string) => logs.push(message),
    logError: (message: string) => errors.push(message),
  };
}

const passingLcov = ['SF:src/index.ts', 'FNF:2', 'FNH:2', 'LF:10', 'LH:10', 'end_of_record'].join(
  '\n',
);

describe('excludedFromCoverage', () => {
  test('returns the gateway Svelte UI exclusions for the gateway package', () => {
    const excluded = excludedFromCoverage('gateway');

    expect(excluded.has('ui/layout.svelte')).toBe(true);
    expect(excluded.size).toBe(12);
  });

  test('returns no exclusions for any other package', () => {
    expect(excludedFromCoverage('armorer')).toEqual(new Set());
    expect(excludedFromCoverage(undefined)).toEqual(new Set());
  });
});

describe('formatFailureReason', () => {
  test('names the package, stage, exit code, and signal', () => {
    expect(
      formatFailureReason({
        packageName: 'example',
        stage: 'threshold',
        exitCode: 0,
        signal: null,
        detail: 'line coverage 90.00% is below 100.00%',
      }),
    ).toBe(
      '✖ example: coverage check failed at stage "threshold" (exit 0, signal none): line coverage 90.00% is below 100.00%',
    );
  });

  test('renders a null exit code and signal explicitly', () => {
    expect(
      formatFailureReason({
        packageName: 'example',
        stage: 'test failure',
        exitCode: null,
        signal: 'SIGKILL',
        detail: 'bun test --coverage did not exit cleanly',
      }),
    ).toBe(
      '✖ example: coverage check failed at stage "test failure" (exit null, signal SIGKILL): bun test --coverage did not exit cleanly',
    );
  });
});

describe('formatOutputTail', () => {
  test('reports stdout and stderr as separately labeled sections, each keeping only its own last lines', () => {
    const child = createChildResult({
      stdout: 'line 1\nline 2\n',
      stderr: 'line 3\n',
    });

    expect(formatOutputTail(child, 1)).toBe(
      '--- child stdout tail (last 1 line(s)) ---\nline 2\n--- child stderr tail (last 1 line(s)) ---\nline 3',
    );
  });

  test('omits a section for a stream that produced no output', () => {
    const child = createChildResult({ stdout: 'only stdout\n', stderr: '' });

    expect(formatOutputTail(child)).toBe('--- child stdout tail (last 1 line(s)) ---\nonly stdout');
  });

  test('reports no output captured when both streams are empty', () => {
    expect(formatOutputTail(createChildResult())).toBe(
      '--- child output tail (no output captured) ---',
    );
  });
});

describe('isPackageSourceFile', () => {
  test('accepts a source file under src/', () => {
    expect(isPackageSourceFile('src/index.ts', { packageRoot, sourceRoot })).toBe(true);
  });

  test('rejects a test file', () => {
    expect(isPackageSourceFile('src/index.test.ts', { packageRoot, sourceRoot })).toBe(false);
  });

  test('rejects a file outside src/', () => {
    expect(isPackageSourceFile('scripts/build.ts', { packageRoot, sourceRoot })).toBe(false);
  });
});

describe('parseCoverageTotals', () => {
  test('sums function and line counts across records', () => {
    const lcov = [
      'SF:src/a.ts',
      'FNF:1',
      'FNH:1',
      'LF:5',
      'LH:5',
      'end_of_record',
      'SF:src/b.ts',
      'FNF:2',
      'FNH:1',
      'LF:8',
      'LH:6',
      'end_of_record',
    ].join('\n');

    const totals = parseCoverageTotals(lcov, { packageRoot, sourceRoot, excluded: new Set() });

    expect(totals).toEqual({
      functions: { covered: 2, total: 3 },
      lines: { covered: 11, total: 13 },
    });
  });

  test('skips excluded files', () => {
    const lcov = ['SF:src/excluded.ts', 'FNF:5', 'FNH:0', 'LF:5', 'LH:0', 'end_of_record'].join(
      '\n',
    );

    const totals = parseCoverageTotals(lcov, {
      packageRoot,
      sourceRoot,
      excluded: new Set(['excluded.ts']),
    });

    expect(totals).toEqual({
      functions: { covered: 0, total: 0 },
      lines: { covered: 0, total: 0 },
    });
  });

  test('throws on a malformed numeric field instead of silently producing NaN', () => {
    const lcov = ['SF:src/a.ts', 'FNF:not-a-number', 'FNH:0', 'LF:1', 'LH:1', 'end_of_record'].join(
      '\n',
    );

    expect(() =>
      parseCoverageTotals(lcov, { packageRoot, sourceRoot, excluded: new Set() }),
    ).toThrow(/Malformed lcov record/);
  });
});

describe('formatPercentage', () => {
  test('reports 100.00 when there is nothing to cover', () => {
    expect(formatPercentage(0, 0)).toBe('100.00');
  });

  test('rounds to two decimal places', () => {
    expect(formatPercentage(1, 3)).toBe('33.33');
  });
});

describe('runCoverageCheck', () => {
  test('prints the coverage summary and returns 0 on a passing run', async () => {
    const { logs, errors, log, logError } = createLogs();

    const exitCode = await runCoverageCheck({
      packageName: 'example',
      packageRoot,
      sourceRoot,
      excluded: new Set(),
      runTestsWithCoverage: () => Promise.resolve(createChildResult({ exitCode: 0 })),
      readLcovReport: () => Promise.resolve(passingLcov),
      log,
      logError,
    });

    expect(exitCode).toBe(0);
    expect(logs).toEqual([
      'Package-local coverage: functions 100.00% (2/2), lines 100.00% (10/10)',
    ]);
    expect(errors).toEqual([]);
  });

  test('reports the spawn stage when launching the child process throws', async () => {
    const { errors, log, logError } = createLogs();

    const exitCode = await runCoverageCheck({
      packageName: 'example',
      packageRoot,
      sourceRoot,
      excluded: new Set(),
      runTestsWithCoverage: () => {
        throw new Error('spawn bun ENOENT');
      },
      readLcovReport: () => Promise.resolve(passingLcov),
      log,
      logError,
    });

    expect(exitCode).toBe(1);
    expect(errors).toEqual([
      '✖ example: coverage check failed at stage "spawn" (exit null, signal none): spawn bun ENOENT',
    ]);
  });

  test('reports the test failure stage and the child exit code when tests fail', async () => {
    const { errors, log, logError } = createLogs();

    const exitCode = await runCoverageCheck({
      packageName: 'example',
      packageRoot,
      sourceRoot,
      excluded: new Set(),
      runTestsWithCoverage: () =>
        Promise.resolve(createChildResult({ exitCode: 1, stdout: '1 pass, 1 fail\n' })),
      readLcovReport: () => Promise.resolve(passingLcov),
      log,
      logError,
    });

    expect(exitCode).toBe(1);
    expect(errors).toEqual([
      '✖ example: coverage check failed at stage "test failure" (exit 1, signal none): bun test --coverage did not exit cleanly',
    ]);
  });

  test('reports the test failure stage with a signal when the child is killed', async () => {
    const { errors, log, logError } = createLogs();

    const exitCode = await runCoverageCheck({
      packageName: 'example',
      packageRoot,
      sourceRoot,
      excluded: new Set(),
      runTestsWithCoverage: () =>
        Promise.resolve(createChildResult({ exitCode: null, signalCode: 'SIGKILL' })),
      readLcovReport: () => Promise.resolve(passingLcov),
      log,
      logError,
    });

    expect(exitCode).toBe(1);
    expect(errors).toEqual([
      '✖ example: coverage check failed at stage "test failure" (exit null, signal SIGKILL): bun test --coverage did not exit cleanly',
    ]);
  });

  test('reports the coverage parse stage and the output tail when the lcov report is missing', async () => {
    const { errors, log, logError } = createLogs();

    const exitCode = await runCoverageCheck({
      packageName: 'example',
      packageRoot,
      sourceRoot,
      excluded: new Set(),
      runTestsWithCoverage: () =>
        Promise.resolve(createChildResult({ exitCode: 0, stdout: '1108 pass, 0 fail\n' })),
      readLcovReport: () => Promise.reject(new Error('ENOENT: no such file or directory')),
      log,
      logError,
    });

    expect(exitCode).toBe(1);
    expect(errors).toEqual([
      '✖ example: coverage check failed at stage "coverage parse" (exit 0, signal none): ENOENT: no such file or directory',
      '--- child stdout tail (last 1 line(s)) ---\n1108 pass, 0 fail',
    ]);
  });

  test('reports the coverage parse stage and the output tail when the lcov report is malformed', async () => {
    const { errors, log, logError } = createLogs();

    const exitCode = await runCoverageCheck({
      packageName: 'example',
      packageRoot,
      sourceRoot,
      excluded: new Set(),
      runTestsWithCoverage: () =>
        Promise.resolve(createChildResult({ exitCode: 0, stdout: '1108 pass, 0 fail\n' })),
      readLcovReport: () =>
        Promise.resolve(
          ['SF:src/a.ts', 'FNF:garbage', 'FNH:0', 'LF:1', 'LH:1', 'end_of_record'].join('\n'),
        ),
      log,
      logError,
    });

    expect(exitCode).toBe(1);
    expect(errors).toEqual([
      '✖ example: coverage check failed at stage "coverage parse" (exit 0, signal none): Malformed lcov record: could not parse "FNF" from "FNF:garbage"',
      '--- child stdout tail (last 1 line(s)) ---\n1108 pass, 0 fail',
    ]);
  });

  test('reports the threshold stage when function coverage is below 100 percent', async () => {
    const { errors, log, logError } = createLogs();
    const lcov = ['SF:src/a.ts', 'FNF:2', 'FNH:1', 'LF:10', 'LH:10', 'end_of_record'].join('\n');

    const exitCode = await runCoverageCheck({
      packageName: 'example',
      packageRoot,
      sourceRoot,
      excluded: new Set(),
      runTestsWithCoverage: () => Promise.resolve(createChildResult({ exitCode: 0 })),
      readLcovReport: () => Promise.resolve(lcov),
      log,
      logError,
    });

    expect(exitCode).toBe(1);
    expect(errors).toEqual([
      '✖ example: coverage check failed at stage "threshold" (exit 0, signal none): function coverage 50.00% is below 100.00%',
    ]);
  });

  test('reports the threshold stage when line coverage is below 100 percent', async () => {
    const { errors, log, logError } = createLogs();
    const lcov = ['SF:src/a.ts', 'FNF:1', 'FNH:1', 'LF:10', 'LH:5', 'end_of_record'].join('\n');

    const exitCode = await runCoverageCheck({
      packageName: 'example',
      packageRoot,
      sourceRoot,
      excluded: new Set(),
      runTestsWithCoverage: () => Promise.resolve(createChildResult({ exitCode: 0 })),
      readLcovReport: () => Promise.resolve(lcov),
      log,
      logError,
    });

    expect(exitCode).toBe(1);
    expect(errors).toEqual([
      '✖ example: coverage check failed at stage "threshold" (exit 0, signal none): line coverage 50.00% is below 100.00%',
    ]);
  });
});
