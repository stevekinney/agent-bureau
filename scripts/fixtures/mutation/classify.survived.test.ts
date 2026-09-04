import { describe, expect, it } from 'bun:test';

import { classify } from './classify';

/**
 * The "survived" half of the fixture pair `scripts/check-mutation.test.ts`
 * relies on: this test runs `classify`'s branch but deliberately never
 * asserts which branch fired, the returned literal's value, or the
 * recorded side effect — only that a string came back. Every mutation
 * `scripts/check-mutation.ts` can apply to `classify` still returns a
 * string, so this test keeps passing and the mutant is reported survived.
 * This is the "executed but unasserted" case the check exists to catch.
 */
describe('classify (survived)', () => {
  it('runs the branch without asserting its outcome', () => {
    expect(typeof classify(10, () => {})).toBe('string');
  });
});
