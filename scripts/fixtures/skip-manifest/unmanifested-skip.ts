/**
 * Fixture for scripts/check-skip-manifest.test.ts (AB-279).
 *
 * Deliberately named without a `.test.ts` suffix: it exists to be parsed as fixture source text
 * by the gate's own test, not to be discovered by `bun test` or by the gate's real repository
 * scan (`packages/**\/*.test.ts`, `scripts/**\/*.test.ts`).
 *
 * One `it.skip` with no matching `scripts/skip-manifest.json` entry — must be flagged.
 */
import { describe, expect, it } from 'bun:test';

describe('a suite with an unmanifested skip', () => {
  it.skip('is skipped without a manifest entry', () => {
    expect(true).toBe(true);
  });
});
