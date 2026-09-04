import { describe, expect, it } from 'bun:test';

import { classify } from './classify';

/**
 * The "killed" half of the fixture pair `scripts/check-mutation.test.ts`
 * relies on: this test genuinely asserts `classify`'s behavior at both
 * sides of the boundary and its side effect, so every mutation
 * `scripts/check-mutation.ts` can apply to `classify` changes an assertion
 * outcome here and the mutant is reported killed.
 */
describe('classify (killed)', () => {
  it('asserts the guard clause, the boundary, the returned literal, and the recorded side effect', () => {
    const seen: string[] = [];
    expect(classify(Number.NaN, () => seen.push('unreachable'))).toBe('unknown');
    expect(seen).toEqual([]);
    expect(classify(10, (label) => seen.push(label))).toBe('high');
    expect(classify(9, (label) => seen.push(label))).toBe('low');
    expect(seen).toEqual(['high', 'low']);
  });
});
