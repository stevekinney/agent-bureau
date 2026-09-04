/**
 * AB-283 coordinator note — `scripts/run-tests.ts` registers a test file or directory, and
 * `README.md`'s "What `test` Runs" table is meant to document every one of them in run order.
 * AB-268's implementer found the table had silently fallen behind (missing rows for
 * `bureau-agent-definitions.test.ts`, `anthropic-interop.test.ts`, and
 * `model-selection-contract.test.ts`) with nothing to catch the drift. This test is that catch:
 * it parses the real `run` invocations out of `scripts/run-tests.ts` and asserts every registered
 * path appears as a row in the README table, so a future registration without a README row fails
 * here instead of silently drifting again.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'bun:test';

const packageRoot = join(import.meta.dir, '..');

/**
 * Extracts the registered test path from each `await run([...])` call in `run-tests.ts`. Each
 * call's command array is either `['bun', 'test', '<path>', ...]` or
 * `[nodeBinary, '--test', '<path>']` (the `nodeBinary` variable, for the one Node-runner
 * registration), so the registered path is captured directly as the string literal that
 * immediately follows the `'test'`/`'--test'` argument — rather than "the first quoted literal
 * that isn't a known keyword" over the whole bracketed argument list, which would mis-parse a
 * call whose LATER argument also contains a literal `]` (e.g. `test/crash/sqlite.test.ts`'s own
 * `'--test-name-pattern', '\\[smoke\\]'` arguments), since a naive `[^\]]+` capture would treat
 * that embedded `]` as the end of the array.
 */
function extractRegisteredTestPaths(runTestsSource: string): string[] {
  const callPattern = /await run\(\[(?:'bun',\s*'test'|\w+,\s*'--test'),\s*'([^']+)'/g;
  return [...runTestsSource.matchAll(callPattern)].map((match) => match[1] ?? '');
}

/**
 * Extracts every `test/...` path cell from the README's "What `test` Runs" markdown table. A row
 * looks like `| \`test/foo.test.ts\` | Bun | ... |`; this pulls the backtick-quoted path out of
 * the first column and strips a trailing `/` (the directory rows, e.g. `test/lifecycle-contract/`)
 * and a trailing parenthetical (e.g. `test/crash/sqlite.test.ts (smoke scenario)`) so it compares
 * on the same normalized path `scripts/run-tests.ts` itself registers.
 */
function extractReadmeTablePaths(readmeSource: string): string[] {
  // The cell can carry trailing plain text after the closing backtick before the next `|` (e.g.
  // `` `test/crash/sqlite.test.ts` (smoke scenario) ``), so this only requires the backtick group
  // to appear somewhere before the next pipe, not immediately adjacent to it.
  const rowPattern = /^\|\s*`(test\/[^`]+)`[^|]*\|/gm;
  return [...readmeSource.matchAll(rowPattern)].map((row) => (row[1] ?? '').replace(/\/$/, ''));
}

describe('extractRegisteredTestPaths', () => {
  it('extracts the path from a plain bun-test registration', () => {
    expect(extractRegisteredTestPaths(`await run(['bun', 'test', 'test/foo.test.ts']);`)).toEqual([
      'test/foo.test.ts',
    ]);
  });

  it('extracts the path from a Node-runner registration using the nodeBinary variable', () => {
    const source = `await run([nodeBinary, '--test', 'test/runtime.test.mjs'], nodeEnvironment);`;
    expect(extractRegisteredTestPaths(source)).toEqual(['test/runtime.test.mjs']);
  });

  it('extracts the correct path from a call whose later argument itself contains a literal "]"', () => {
    // The regression this guards: a naive "first quoted literal, scanning up to the first ]"
    // parse would stop inside '\\[smoke\\]' and either mis-capture or miss the real path.
    const source = `await run(['bun', 'test', 'test/crash/sqlite.test.ts', '--test-name-pattern', '\\\\[smoke\\\\]']);`;
    expect(extractRegisteredTestPaths(source)).toEqual(['test/crash/sqlite.test.ts']);
  });

  it('extracts every registration from a multi-line source in order', () => {
    const source = [
      `await run(['bun', 'test', 'test/a.test.ts']);`,
      `await run(['bun', 'test', 'test/b.test.ts']);`,
      `await run([nodeBinary, '--test', 'test/c.test.mjs'], nodeEnvironment);`,
    ].join('\n');

    expect(extractRegisteredTestPaths(source)).toEqual([
      'test/a.test.ts',
      'test/b.test.ts',
      'test/c.test.mjs',
    ]);
  });
});

describe('extractReadmeTablePaths', () => {
  it('normalizes a directory row by stripping the trailing slash', () => {
    expect(
      extractReadmeTablePaths('| `test/lifecycle-contract/` | Bun | some description |'),
    ).toEqual(['test/lifecycle-contract']);
  });

  it('extracts a path cell with trailing parenthetical text before the next pipe', () => {
    expect(
      extractReadmeTablePaths(
        '| `test/crash/sqlite.test.ts` (smoke scenario)   | Bun     | some description |',
      ),
    ).toEqual(['test/crash/sqlite.test.ts']);
  });

  it('returns an empty array for a table with no test/ rows', () => {
    expect(extractReadmeTablePaths('| File | Runner |\n| --- | --- |')).toEqual([]);
  });
});

describe('README test-sequencing table', () => {
  it('has a row for every test file or directory scripts/run-tests.ts registers', async () => {
    const [runTestsSource, readmeSource] = await Promise.all([
      readFile(join(packageRoot, 'scripts/run-tests.ts'), 'utf-8'),
      readFile(join(packageRoot, 'README.md'), 'utf-8'),
    ]);

    const registeredPaths = extractRegisteredTestPaths(runTestsSource);
    expect(registeredPaths.length).toBeGreaterThan(0);

    const readmePaths = new Set(extractReadmeTablePaths(readmeSource));
    expect(readmePaths.size).toBeGreaterThan(0);

    const missingFromReadme = registeredPaths.filter((path) => !readmePaths.has(path));
    expect(missingFromReadme).toEqual([]);
  });
});
