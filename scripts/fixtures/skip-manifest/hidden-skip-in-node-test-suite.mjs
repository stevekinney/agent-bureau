/**
 * Fixture for scripts/check-skip-manifest.test.ts (AB-293).
 *
 * Named `.mjs`, deliberately without a `.test.mjs` suffix: it exists to be parsed as fixture
 * source text by the gate's own test (proving the widened `.mjs` glob and `ScriptKind.JS` parse
 * path both work), not to be discovered by the gate's real repository scan
 * (`packages/**\/*.test.mjs`, `scripts/**\/*.test.mjs`) or executed by `node --test`.
 *
 * A `node:test` suite — the same shape as `packages/integration/test/runtime.test.mjs` — with one
 * `test.skip` and no matching `scripts/skip-manifest.json` entry. Before AB-293, `.mjs` files were
 * entirely out of the scan glob, so this hidden skip would bypass the gate; must now be flagged.
 */
import { describe, test } from 'node:test';

describe('a node:test suite with a hidden skip', () => {
  test.skip('is skipped without a manifest entry', () => {
    // Intentionally empty — this test never runs.
  });
});
