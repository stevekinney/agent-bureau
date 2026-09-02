/**
 * Fixture for scripts/check-skip-manifest.test.ts (AB-279).
 *
 * A `ReturnStatement` inside an `IfStatement` that is the first statement of the test callback
 * body — a structural skip with no `.skip` call to grep for. Must be flagged.
 */
import { expect, it } from 'bun:test';

it('bails out early under a condition instead of asserting', () => {
  if (Bun.env['SOME_CONDITION'] !== 'set') {
    return;
  }
  expect(true).toBe(true);
});
