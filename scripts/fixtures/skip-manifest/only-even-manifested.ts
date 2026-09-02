/**
 * Fixture for scripts/check-skip-manifest.test.ts (AB-279).
 *
 * One `it.only`. `.only` can never be manifested — a committed `.only` silently disables the
 * rest of its file — so this must be flagged even when the test manifests its identifier.
 */
import { expect, it } from 'bun:test';

it.only('is the only test that would run if this file were live', () => {
  expect(true).toBe(true);
});
