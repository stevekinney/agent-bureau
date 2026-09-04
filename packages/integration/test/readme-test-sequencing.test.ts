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
 * registration) — in both shapes the registered path is the first single-quoted string literal
 * that is not `'bun'`, `'test'`, or `'--test'`.
 */
function extractRegisteredTestPaths(runTestsSource: string): string[] {
  const paths: string[] = [];
  const callPattern = /await run\(\[([^\]]+)\]/g;

  for (const match of runTestsSource.matchAll(callPattern)) {
    const argumentsList = match[1] ?? '';
    const literals = [...argumentsList.matchAll(/'([^']+)'/g)].map((literal) => literal[1]);
    const registeredPath = literals.find(
      (literal) => literal !== 'bun' && literal !== 'test' && literal !== '--test',
    );
    if (registeredPath) paths.push(registeredPath);
  }

  return paths;
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
