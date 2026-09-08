import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';

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

  it('is carried verbatim by the pull-request CI gateway-conformance step', async () => {
    // A workflow `run:` line cannot import this module, so `ci.yml` holds the
    // pattern as a literal. This pins that literal to the constant so the two
    // cannot drift apart silently (AB-356).
    const workflow = await Bun.file(
      join(import.meta.dir, '..', '.github', 'workflows', 'ci.yml'),
    ).text();
    expect(workflow).toContain(
      `bun run test:gateway-conformance -- --test-name-pattern "${NIGHTLY_TEST_NAME_PATTERN}"`,
    );
  });
});
