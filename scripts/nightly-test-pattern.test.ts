import { describe, expect, it } from 'bun:test';

import { NIGHTLY_TEST_NAME_PATTERN } from './nightly-test-pattern.ts';

describe('NIGHTLY_TEST_NAME_PATTERN', () => {
  const pattern = new RegExp(NIGHTLY_TEST_NAME_PATTERN);

  it('matches a test name with no [nightly] tag', () => {
    expect(pattern.test('pages durable history from the last observed cursor')).toBe(true);
  });

  it('does not match a test name carrying the [nightly] tag', () => {
    expect(pattern.test('[nightly] recovers a fresh process over the same SQLite path')).toBe(
      false,
    );
  });

  it('does not match when the tag appears mid-name rather than at the start', () => {
    expect(pattern.test('restart scenario [nightly] tails live')).toBe(false);
  });
});
