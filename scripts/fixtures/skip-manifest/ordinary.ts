/**
 * Fixture for scripts/check-skip-manifest.test.ts (AB-279).
 *
 * An ordinary test with no skip, todo, only, or conditional early return. Must NOT be flagged,
 * and its identifier must be discoverable so a manifest entry naming it would NOT be an orphan.
 */
import { expect, it } from 'bun:test';

it('runs unconditionally and asserts', () => {
  const total = 1 + 1;
  expect(total).toBe(2);
});
