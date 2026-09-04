/**
 * Fixture for scripts/check-skip-manifest.test.ts (AB-293).
 *
 * Deliberately named without a `.test.ts` suffix, matching the other fixtures in this directory:
 * it exists to be parsed as fixture source text by the gate's own test, not discovered by the
 * gate's real repository scan.
 *
 * `it` is imported under the alias `spec`. `spec.skip(...)` has no matching
 * `scripts/skip-manifest.json` entry. Before AB-293, an aliased import was not resolved back to
 * `bun:test`'s `it`, so `spec` did not match `TEST_CALL_NAMES` and this skip was entirely
 * invisible to the gate; must now be flagged.
 */
import { expect, it as spec } from 'bun:test';

spec.skip('is skipped through an aliased import with no manifest entry', () => {
  expect(true).toBe(true);
});
