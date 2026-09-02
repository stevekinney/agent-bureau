/**
 * Fixture for scripts/check-skip-manifest.test.ts (AB-279).
 *
 * One `it.skip` whose test identifier the test file manifests directly (not in the real
 * `scripts/skip-manifest.json`, which ships empty) — must NOT be flagged.
 */
import { describe, expect, it } from 'bun:test';

describe('a suite with a manifested skip', () => {
  it.skip('is skipped with a manifest entry', () => {
    expect(true).toBe(true);
  });
});
