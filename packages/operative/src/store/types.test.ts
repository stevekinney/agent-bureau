import { describe, expect, it } from 'bun:test';

import type { RunStatus } from './types';

/**
 * `RunStatus` (AB-205/AB-37) gains `'aborting'` as a fifth member alongside
 * the four terminal/running values `Store`'s own `RunState` (`store.ts`)
 * actually writes. This is a compile-time exhaustiveness check — a member
 * added to or removed from `RunStatus` without a matching edit here fails
 * `bun run check-types`, not just this test — plus one runtime assertion so
 * `bun test` records real coverage over this file.
 */
describe('RunStatus', () => {
  it('names exactly the five known run statuses, including the aborting transitional value', () => {
    const knownStatuses = [
      'running',
      'aborting',
      'completed',
      'error',
      'aborted',
    ] as const satisfies readonly RunStatus[];

    // Exhaustiveness in the other direction: every `RunStatus` member must
    // appear in `knownStatuses`, or this assignment fails to compile.
    const assertNoUnlistedMember = (status: RunStatus): (typeof knownStatuses)[number] => status;
    for (const status of knownStatuses) {
      expect(assertNoUnlistedMember(status)).toBe(status);
    }

    expect(knownStatuses).toContain('aborting');
    expect(knownStatuses).toHaveLength(5);
  });
});
