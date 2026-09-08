/**
 * Single source of truth for excluding `[nightly]`-tagged test names from
 * the pull-request lane (AB-275, AB-356).
 *
 * AB-275 introduced the `[nightly]` test-name tag for scenarios that launch
 * real processes and are too slow for every pull request (the Gateway
 * restart-and-replay conformance scenario is the first one). It excluded the
 * tag from the pull-request lane via `bun test --test-name-pattern` in two
 * places: `packages/gateway/package.json`'s own `test` script (used by
 * `turbo run test`) and `.github/workflows/ci.yml`'s
 * `test:gateway-conformance` invocation.
 *
 * `scripts/check-coverage.ts` invokes `bun test --coverage` directly per
 * package rather than through the package's filtered `test` script, so
 * without this it independently re-executes nightly-tagged tests during
 * `bun run coverage:check`. Import this constant everywhere the exclusion is
 * needed instead of writing the pattern string a second time.
 *
 * This is the single TypeScript source of truth: `check-coverage.ts` and
 * `packages/gateway/package.json`'s `test` script (through
 * `run-tests-excluding-nightly.ts`) both import it. `.github/workflows/
 * ci.yml`'s `test:gateway-conformance` step cannot — a workflow `run:` line
 * has no way to import a TypeScript module — so it carries the pattern as a
 * literal string kept textually identical to this constant rather than a
 * copy maintained independently of it.
 */
export const NIGHTLY_TEST_NAME_PATTERN = '^(?!.*\\[nightly\\])';
