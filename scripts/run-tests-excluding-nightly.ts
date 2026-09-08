/**
 * Thin `bun test` wrapper that applies `NIGHTLY_TEST_NAME_PATTERN`
 * (AB-275, AB-356) so a package's own `test` script shares the same
 * exclusion constant `scripts/check-coverage.ts` uses, instead of each
 * consumer hardcoding the pattern string separately.
 *
 * Any extra arguments (a path filter, for example) pass through to
 * `bun test` unchanged.
 */
import { NIGHTLY_TEST_NAME_PATTERN } from './nightly-test-pattern.ts';

const command = Bun.spawnSync(
  ['bun', 'test', ...process.argv.slice(2), '--test-name-pattern', NIGHTLY_TEST_NAME_PATTERN],
  {
    cwd: process.cwd(),
    stdout: 'inherit',
    stderr: 'inherit',
  },
);

process.exit(command.exitCode ?? 1);
